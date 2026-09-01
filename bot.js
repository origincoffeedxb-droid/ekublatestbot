require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const store = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const ANNOUNCE_CHAT_ID = process.env.ANNOUNCE_CHAT_ID;
const TELEBIRR_NUMBER = process.env.TELEBIRR_NUMBER || 'SET_YOUR_TELEBIRR_NUMBER';
const TELEBIRR_NAME = process.env.TELEBIRR_NAME || 'Your Company';
const LOCK_MINUTES = parseInt(process.env.LOCK_MINUTES || '5', 10);

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env — get one from @BotFather on Telegram.');
  process.exit(1);
}
if (!ADMIN_CHAT_ID) {
  console.error('Missing ADMIN_CHAT_ID in .env — see .env.example for how to find it.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Short tier codes keep Telegram callback_data under the 64-byte limit.
const TIERS = {
  a: { amount: 200, label: '200 ብር' },
};
const TOTAL_NUMBERS = 5; // size of the number pool per round — one draw once all of these are confirmed
const PAGE_SIZE = 50; // numbers per page (5 rows x 10) — irrelevant while TOTAL_NUMBERS <= 50, kept for future growth

function displayName(from) {
  return from.username ? '@' + from.username : (from.first_name || 'ተጠቃሚ');
}

// ============================================================
//  THEME — visual language & motion helpers
//  (Telegram has no real color/CSS control, so "next-gen" here
//  means: a consistent emoji palette, HTML "cards" via
//  <blockquote>/<code>, a heat-gradient progress bar, and real
//  animation via short sequences of message edits.)
// ============================================================

const ICON = {
  free: '🟢',
  taken: '🔴',
  pending: '🟡',
};

const STATUS_LABEL = {
  locked: '🔒 ተይዟል',
  pending: '🟡 ያልተረጋገጠ',
  confirmed: '✅ ተረጋግጧል',
};

// Renders a number using bold Unicode math digits (𝟏𝟐𝟑...) so open/actionable
// numbers visually pop against the plain-digit taken/pending ones.
const BOLD_DIGITS = ['𝟎', '𝟏', '𝟐', '𝟑', '𝟒', '𝟓', '𝟔', '𝟕', '𝟖', '𝟗'];
function boldNumber(n) {
  return String(n).split('').map((d) => BOLD_DIGITS[Number(d)]).join('');
}

// Heat-gradient progress bar: the fill color shifts as a tier gets closer to
// drawing, so "how close is this round" reads at a glance.
function gradientBar(filled, total = TOTAL_NUMBERS, size = 10) {
  const ratio = total > 0 ? filled / total : 0;
  const filledBlocks = Math.max(0, Math.min(size, Math.round(ratio * size)));
  let block;
  if (ratio >= 1) block = '🟨'; // gold — full, about to draw
  else if (ratio >= 0.66) block = '🟪'; // magenta — almost there
  else if (ratio >= 0.33) block = '🟦'; // blue — halfway
  else block = '🟩'; // green — just getting started
  return block.repeat(filledBlocks) + '⬜'.repeat(size - filledBlocks);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Payer phone number: capture, validate, mask ----------

function normalizePhone(text) {
  return text.replace(/[^\d+]/g, '');
}

function isValidPhone(text) {
  const digits = text.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 13;
}

// Shows only the first 3 and last 3 digits — e.g. 0912345678 -> 091****678
function maskPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return digits;
  const first3 = digits.slice(0, 3);
  const last3 = digits.slice(-3);
  const maskLen = Math.max(digits.length - 6, 3);
  return `${first3}${'*'.repeat(maskLen)}${last3}`;
}

// Tracks users who've submitted a txn ID and are now expected to send the
// phone number they paid from, before the submission is finalized.
const pendingPhoneRequests = new Map(); // userId -> { tierCode, round, number, txnId }

// Best-effort "bot is typing…" cue — purely cosmetic, never blocks the flow.
function typing(ctx) {
  return ctx.sendChatAction('typing').catch(() => {});
}

// Plays a short sequence of edits on a message to fake motion (spinners,
// "verifying…" reveals, etc). Silently ignores edit races/rate limits.
async function playFrames(telegram, chatId, messageId, frames, extra, delay = 450) {
  for (let i = 0; i < frames.length; i++) {
    try {
      await telegram.editMessageText(chatId, messageId, undefined, frames[i], extra);
    } catch (e) {
      /* message may be identical / already gone — ignore */
    }
    if (i < frames.length - 1) await sleep(delay);
  }
}

function formatRemaining(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function reservationCardText(tier, number, remainingMs) {
  return (
    `🔒 <b>የመረጡትን ቁጥር ይዘዋል </b>\n\n` +
    `ቁጥር <b>${boldNumber(number)}</b> በ<b>${tier.label}</b> ለእርስዎ ተይዟል።\n\n` +
    `<blockquote>📲 <b>${tier.amount} ብር</b> በቴሌብር ወደ፦\n<code>${TELEBIRR_NUMBER}</code>  (${TELEBIRR_NAME})</blockquote>\n\n` +
    `⏳ ለማረጋገጥ የሚቀሮት ደቂቃ ፦ <b>${formatRemaining(remainingMs)}</b>\n` +
    `ብሩን ከላኩ በኋላ የቴሌብር Transaction እዚሁ ይላኩልን።\n` +
    `በአምስት ደቂቃ ውስጥ ካልደረሰን፣ ምርጫዎ ይሰረዝ እና ቁጥሩ ለሁሉም ሰው ክፍት ይሆናል።`
  );
}

// Tracks the "live" reservation card so it can be countdown-animated and
// later resolved (submitted / expired) without touching persisted state.
const activeCountdowns = new Map(); // userId -> { intervalId, chatId, messageId, tierCode, round, number, expiry }

function clearCountdown(userId) {
  const c = activeCountdowns.get(userId);
  if (c) {
    clearInterval(c.intervalId);
    activeCountdowns.delete(userId);
  }
  return c || null;
}

function startCountdown(userId, chatId, messageId, tierCode, round, number, expiry) {
  clearCountdown(userId);
  const tier = TIERS[tierCode];
  const intervalId = setInterval(async () => {
    const row = store.getNumberRow(tierCode, round, number);
    const remaining = expiry - Date.now();
    if (!row || row.status !== 'locked' || remaining <= 0) {
      clearCountdown(userId);
      return;
    }
    try {
      await bot.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        reservationCardText(tier, number, remaining),
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      /* ignore transient edit failures */
    }
  }, 20000);
  activeCountdowns.set(userId, { intervalId, chatId, messageId, tierCode, round, number, expiry });
}

// ---------- Generate and send full board to announcement channel ----------
async function postFullBoardToChannel(tierCode, round) {
  if (!ANNOUNCE_CHAT_ID) return;

  const rows = store.getTierNumbers(tierCode, round);
  const byNumber = {};
  for (const r of rows) byNumber[r.number] = r;

  const lines = [];
  for (let n = 1; n <= TOTAL_NUMBERS; n++) {
    const r = byNumber[n];
    if (!r) {
      // Free number — show green icon + number + "አልተያዘም" (not reserved)
      lines.push(`${ICON.free} ${String(n).padStart(3, '0')}  አልተያዘም`);
    } else if (r.status === 'pending') {
      // Pending number — show yellow icon + number + phone + "በክለሳ ላይ"
      const masked = r.phone ? maskPhone(r.phone) : '—';
      lines.push(`${ICON.pending} ${String(n).padStart(3, '0')}  📱 ${masked}  በክለሳ ላይ`);
    } else {
      // Confirmed number — show red icon + number + phone + "ተይዟል" (reserved)
      const masked = r.phone ? maskPhone(r.phone) : '—';
      lines.push(`${ICON.taken} ${String(n).padStart(3, '0')}  📱 ${masked}  ተይዟል`);
    }
  }

  const tier = TIERS[tierCode];
  const header = `📋 <b>${tier.label} መደብ — የእጣ ወቅታዊ ዝርዝር (ዙር ${round})</b>\n⏰ <i>${new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' })}</i>`;

  const CHUNK = 40;
  try {
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK);
      const text = (i === 0 ? header + '\n\n' : '') + `<blockquote>${chunk.join('\n')}</blockquote>`;
      await bot.telegram.sendMessage(ANNOUNCE_CHAT_ID, text, { parse_mode: 'HTML' });
      if (i + CHUNK < lines.length) await sleep(200); // brief delay between chunks
    }
  } catch (e) {
    console.error('Could not post full board to ANNOUNCE_CHAT_ID:', e.message);
  }
}

// ---------- Keyboards ----------

function mainMenuKeyboard() {
  const tierCode = 'a';
  const tier = TIERS[tierCode];
  const round = store.getCurrentRound(tierCode);
  const filled = store.countConfirmed(tierCode, round);
  const bar = gradientBar(filled, TOTAL_NUMBERS, 5);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`💎 ${tier.label}  ${bar}  ${filled}/${TOTAL_NUMBERS}`, `tier:${tierCode}`)],
  ]);
}

function numbersGridKeyboard(tierCode, round, page) {
  const rows = store.getTierNumbers(tierCode, round);
  const statusByNumber = {};
  for (const r of rows) statusByNumber[r.number] = r.status;

  const start = page * PAGE_SIZE + 1;
  const end = Math.min(start + PAGE_SIZE - 1, TOTAL_NUMBERS);

  const buttons = [];
  let row = [];
  for (let n = start; n <= end; n++) {
    const status = statusByNumber[n];
    let icon;
    // Green = free and pickable; red = taken (locked / under review / confirmed
    // — all read the same from a picker's point of view: not available).
    if (!status) icon = `${ICON.free}${boldNumber(n)}`; // free — actionable
    else icon = `${ICON.taken}${n}`; // taken — not selectable

    if (status) {
      row.push(Markup.button.callback(icon, 'noop')); // not selectable
    } else {
      row.push(Markup.button.callback(icon, `pick:${tierCode}:${n}`));
    }
    if (row.length === 10) {
      buttons.push(row);
      row = [];
    }
  }
  if (row.length) buttons.push(row);

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀️ ወደኋላ', `pg:${tierCode}:${page - 1}`));
  if (end < TOTAL_NUMBERS) nav.push(Markup.button.callback('ወደፊት ▶️', `pg:${tierCode}:${page + 1}`));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback('📋 ክፍት እና የተያዙ የእጣ ዝርዝሮችን ለማየት', `board:${tierCode}`)]);
  buttons.push([Markup.button.callback('🔙 ወደ ኋላ ተመለስ', 'menu')]);

  return Markup.inlineKeyboard(buttons);
}

// Persistent bottom menu (reply keyboard) — gives the bot an "app" feel.
function replyMenu() {
  return Markup.keyboard([
    ['🎟️ ቁጥር ለመያዝ', '👁 የመረጡትን ቁጥር ለማየት'],
    ['❓ ጥያቄ ወይም እገዛ ለማግኘት'],
  ]).resize();
}

// ---------- Commands ----------

// Temporary helper: reveals the current chat's ID so you can find your ADMIN_CHAT_ID.
// Safe to leave in permanently — it only ever shows the ID of the chat it's used in.
bot.command('whereami', (ctx) => {
  ctx.reply(`Chat ID: ${ctx.chat.id}\nChat type: ${ctx.chat.type}\nChat title: ${ctx.chat.title || '(none — private chat)'}`);
});

bot.start(async (ctx) => {
  await typing(ctx);
  const intro = await ctx.reply('✨ በመዘጋጀት ላይ...', { parse_mode: 'HTML' });
  await sleep(400);

  const welcomeText =
    `✨ <b>እንኳን ወደ እለታዊ እቁብ በደህና መጡ!</b> 🎉\n\n` +
    `ለማስጀመር እና ቁጥር ለመያዝ ከታች ያለውን ይምረጡ፣ ከዚያም ${ICON.free} ያልተያዘ ቁጥር ከ<b>1</b> እስከ <b>${TOTAL_NUMBERS}</b> ውስጥ ይምረጡ! ` +
    `ክፍያውን በቴሌብር በ<b>${LOCK_MINUTES} ደቂቃ</b> ውስጥ ልከው የግብይት ቁጥርዎን እና ስልክ ቁጥሮን ማስገባት ይኖርብዎታል። ` +
    `በዝርዝር ውስጥ ያሉት ${TOTAL_NUMBERS} ቁጥሮች ሁሉ ተከፍለው ሲረጋገጡ አንድ አሸናፊ በእጣ ይመረጣል።\n\n` +
    `መልካም እድል 🎉🎉🎉\n\n` +
    `<blockquote>${ICON.free} ያልተያዘ ${ICON.taken} የተያዘ</blockquote>\n\n` +
    `👇 ለመጀመር ከታች ይንኩ እና ይምረጡ!፦`;

  try {
    await ctx.telegram.editMessageText(intro.chat.id, intro.message_id, undefined, welcomeText, {
      parse_mode: 'HTML',
      ...mainMenuKeyboard(),
    });
  } catch (e) {
    await ctx.reply(welcomeText, { parse_mode: 'HTML', ...mainMenuKeyboard() });
  }

  // Make sure the persistent bottom reply-keyboard is shown too.
  await ctx.reply('ከታች ያለውን ምናሌ ተጠቅመው በማንኛውም ጊዜ መርዳት ይችላሉ፦', replyMenu());
});

bot.command('numbers', async (ctx) => {
  await typing(ctx);
  ctx.reply('ቁጥሮችን ይምረጡ፦', mainMenuKeyboard());
});
bot.hears('🎟️ ቁጥር ለመያዝ', async (ctx) => {
  await typing(ctx);
  ctx.reply('ቁጥሮችን ለመያዝ ይምረጡ፦', mainMenuKeyboard());
});

async function mynumberReply(ctx) {
  await typing(ctx);
  const rows = store.getNumbersByUser(ctx.from.id);
  if (!rows.length) {
    return ctx.reply('❕ አሁን ምንም የያዙት ቁጥር የለዎትም።');
  }
  const lines = rows.map((r) => {
    const tier = TIERS[r.tier] || { label: r.tier };
    const status = STATUS_LABEL[r.status] || r.status;
    const phoneLine = r.phone ? ` — 📱 ${maskPhone(r.phone)}` : '';
    return `ቁጥር <b>${boldNumber(r.number)}</b> — ${tier.label} (ዙር ${r.round}) — ${status}${phoneLine}`;
  });
  await ctx.reply(
    `👁 <b>የመረጡት ቁጥር(ሮች)</b>\n\n<blockquote>${lines.join('\n')}</blockquote>`,
    { parse_mode: 'HTML' }
  );
}
bot.command('mynumber', mynumberReply);
bot.hears('👁 የመረጡትን ቁጥር ለማየት', mynumberReply);

bot.hears('❓ ጥያቄ ወይም እገዛ ለማግኘት', (ctx) => ctx.reply('🛟 እርዳታ ካስፈለገዎት ያነጋግሩን፦ @eletawiequbsupport'));

bot.action('noop', (ctx) => ctx.answerCbQuery('ይህ ቁጥር አስቀድሞ ተይዟል።'));

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  await typing(ctx);
  await ctx.editMessageText('መደብ ይምረጡ፦', mainMenuKeyboard());
});

bot.action(/^tier:a$/, async (ctx) => {
  const tierCode = 'a';
  await ctx.answerCbQuery();
  await typing(ctx);
  const round = store.getCurrentRound(tierCode);
  const filled = store.countConfirmed(tierCode, round);
  await ctx.editMessageText(
    `💎 በ <b>${TIERS[tierCode].label} መደብ</b>\n${gradientBar(filled)}  ${filled}/${TOTAL_NUMBERS}\n\n` +
      `ማንኛውንም ${ICON.free} ያልተያዘ ቁጥር ይምረጡ (1–${TOTAL_NUMBERS})፦`,
    { parse_mode: 'HTML', ...numbersGridKeyboard(tierCode, round, 0) }
  );
});

bot.action(/^pg:a:(\d+)$/, async (ctx) => {
  const tierCode = 'a';
  const page = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery();
  await typing(ctx);
  const round = store.getCurrentRound(tierCode);
  const filled = store.countConfirmed(tierCode, round);
  await ctx.editMessageText(
    `💎 <b>${TIERS[tierCode].label} መደብ</b>\n${gradientBar(filled)}  ${filled}/${TOTAL_NUMBERS}\n\n` +
      `ማንኛውንም ${ICON.free} ክፍት ቁጥር ይምረጡ (1–${TOTAL_NUMBERS})፦`,
    { parse_mode: 'HTML', ...numbersGridKeyboard(tierCode, round, page) }
  );
});

// Full text board: every number 1–TOTAL_NUMBERS, 🟢 free or 🔴 taken (with
// masked phone for taken ones). Chunked so a fully-booked tier never risks
// exceeding Telegram's per-message length limit.
async function sendBoard(ctx, tierCode) {
  const round = store.getCurrentRound(tierCode);
  const rows = store.getTierNumbers(tierCode, round);
  const byNumber = {};
  for (const r of rows) byNumber[r.number] = r;

  const lines = [];
  for (let n = 1; n <= TOTAL_NUMBERS; n++) {
    const r = byNumber[n];
    if (!r) {
      // Free number — show green icon + number + "አልተያዘም" (not reserved)
      lines.push(`${ICON.free} ${String(n).padStart(3, '0')}  አልተያዘም`);
    } else if (r.status === 'pending') {
      // Pending number — show yellow icon + number + phone + "በክለሳ ላይ"
      const masked = r.phone ? maskPhone(r.phone) : '—';
      lines.push(`${ICON.pending} ${String(n).padStart(3, '0')}  📱 ${masked}  በክለሳ ላይ`);
    } else {
      // Confirmed number — show red icon + number + phone + "ተይዟል" (reserved)
      const masked = r.phone ? maskPhone(r.phone) : '—';
      lines.push(`${ICON.taken} ${String(n).padStart(3, '0')}  📱 ${masked}  ተይዟል`);
    }
  }

  const header = `📋 <b>${TIERS[tierCode].label} የተያዙ እና ያልተያዙ ቁጥሮች ዝርዝር</b>`;
  const CHUNK = 40;
  for (let i = 0; i < lines.length; i += CHUNK) {
    const chunk = lines.slice(i, i + CHUNK);
    const text = (i === 0 ? header + '\n\n' : '') + `<blockquote>${chunk.join('\n')}</blockquote>`;
    await ctx.reply(text, { parse_mode: 'HTML' });
  }
}

bot.action(/^board:a$/, async (ctx) => {
  const tierCode = 'a';
  await ctx.answerCbQuery();
  await typing(ctx);
  await sendBoard(ctx, tierCode);
});

bot.action(/^pick:a:(\d+)$/, async (ctx) => {
  const tierCode = 'a';
  const number = parseInt(ctx.match[1], 10);
  const tier = TIERS[tierCode];
  const userId = ctx.from.id;

  const existingLock = store.getActiveLock(userId);
  if (existingLock) {
    await ctx.answerCbQuery('አስቀድመው የያዙት ቁጥር አለዎት። እባክዎ መጀመሪያ ያንን ይጨርሱ።', { show_alert: true });
    return;
  }

  const round = store.getCurrentRound(tierCode);
  const current = store.getNumberRow(tierCode, round, number);
  if (current) {
    await ctx.answerCbQuery('ይቅርታ፣ ያ ቁጥር አሁን በሌላ ሰው ተይዟል።', { show_alert: true });
    return;
  }

  store.lockNumber(tierCode, round, number, userId, displayName(ctx.from));
  await ctx.answerCbQuery(`${ICON.locked} ቁጥሩ ተይዟል!`);
  await typing(ctx);

  const expiry = Date.now() + LOCK_MINUTES * 60 * 1000;
  const sent = await ctx.reply(`${ICON.locked} <b>በመያዝ ላይ...</b>`, { parse_mode: 'HTML' });
  await sleep(350);
  const cardText = reservationCardText(tier, number, expiry - Date.now());
  try {
    await ctx.telegram.editMessageText(sent.chat.id, sent.message_id, undefined, cardText, { parse_mode: 'HTML' });
  } catch (e) {
    /* ignore */
  }

  // Send explicit instruction for transaction ID
  await sleep(500);
  await ctx.reply(
    `<b>🔢 በመጀመሪያ ፦</b>\n\n` +
    `1️⃣ <b>የቴሌብር ግብይት ቁጥር ይላኩልን</b> (ለምሳሌ: TRX123456789)\n` +
    `⏰ ያሎት ${LOCK_MINUTES} ደቂቃዎች ነው!`,
    { parse_mode: 'HTML' }
  );

  startCountdown(userId, sent.chat.id, sent.message_id, tierCode, round, number, expiry);

  setTimeout(async () => {
    const row = store.getNumberRow(tierCode, round, number);
    if (row && row.status === 'locked') {
      store.releaseNumber(tierCode, round, number, userId);
      clearCountdown(userId);
      pendingPhoneRequests.delete(userId);
      const expiredText = `⌛ <b>ጊዜው አልቋል</b>\n\nቁጥር ${number} (${tier.label} መደብ) በሰዓቱ ስላልተረጋገጠ ቁጥሩ ተለቋል። ${ICON.free} ለሁሉም ሰው ክፍት ሆኗል — በማንኛውም ጊዜ ሌላ ቁጥር መምረጥ ይችላሉ።`;
      try {
        await bot.telegram.editMessageText(sent.chat.id, sent.message_id, undefined, expiredText, { parse_mode: 'HTML' });
      } catch (e) {
        try {
          await bot.telegram.sendMessage(userId, expiredText, { parse_mode: 'HTML' });
        } catch (e2) { /* user may have blocked the bot */ }
      }
    }
  }, LOCK_MINUTES * 60 * 1000);
});

// Reservation completion is two steps: (1) the Telebirr transaction ID,
// then (2) the phone number that was used to pay, so it can be masked and
// shown next to the number on the board / pushed to the channel.
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;

  // Step 2: we already have a txn ID for this user and are waiting on the phone number
  const awaitingPhone = pendingPhoneRequests.get(userId);
  if (awaitingPhone) {
    const { tierCode, round, number, txnId } = awaitingPhone;
    const row = store.getNumberRow(tierCode, round, number);
    if (!row || row.status !== 'locked') {
      pendingPhoneRequests.delete(userId);
      return ctx.reply(
        `⚠️ <b>ይህ ማስያዝ ጊዜው አልፎበታል ወይም ተቀይሯል።</b>\n\n` +
        `እባክዎ ከመጀመሪያው ይሞክሩ — ሌላ ቁጥር ይምረጡ።`,
        { parse_mode: 'HTML' }
      );
    }

    const phoneText = ctx.message.text.trim();
    if (!isValidPhone(phoneText)) {
      return ctx.reply(
        `❌ <b>ይህ ትክክለኛ ስልክ ቁጥር አደለም 09XXX ብለው ይጻፉ።</b>\n\n` +
        `እባክዎ የከፈሉበትን ስልክ ቁጥር በትክክል ያስገቡ:\n` +
        `<code>0912345678</code>\n` +
        `ወይም ሌላ ትክክለኛ ቦታ።`,
        { parse_mode: 'HTML' }
      );
    }

    pendingPhoneRequests.delete(userId);
    const phone = normalizePhone(phoneText);
    store.setPayerPhone(tierCode, round, number, phone);
    store.submitTxn(tierCode, round, number, txnId);

    const masked = maskPhone(phone);
    const tier = TIERS[tierCode];

    const countdown = clearCountdown(userId);
    if (countdown) {
      try {
        await bot.telegram.editMessageText(
          countdown.chatId,
          countdown.messageId,
          undefined,
          `${ICON.pending} <b>በክለሳ ላይ</b>\n\nቁጥር <b>${boldNumber(number)}</b> — ${tier.label} መድብ\n<blockquote>የግብይት ቁጥር፦ <code>${txnId}</code>\nስልክ፦ <code>${masked}</code></blockquote>`,
          { parse_mode: 'HTML' }
        );
      } catch (e) { /* ignore */ }
    }

    await typing(ctx);
    await ctx.reply(
      `✅ <b>ተቀበልናል!</b>\n\n` +
      `<blockquote>ግብይት ቁጥር: <code>${txnId}</code>\nስልክ: <code>${masked}</code></blockquote>\n\n` +
      `📨 ክፍያዎ አሁን እየተረጋገጠ ነው። እባኮትን ትንሽ ደቂቃ ይጠብቁን።`,
      { parse_mode: 'HTML' }
    );

    try {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🆕 <b>አዲስ ክፍያ ገብቷል</b>\n\n` +
          `<blockquote>ደረጃ፦ ${tier.label}\nቁጥር፦ ${number}\nተጠቃሚ፦ ${displayName(ctx.from)} (id ${userId})\nየግብይት መታወቂያ፦ <code>${txnId}</code>\nስልክ፦ <code>${masked}</code></blockquote>\n\n` +
          `ከማጽደቅዎ በፊት ከቴሌብር ዝርዝርዎ ጋር እባክዎ ያረጋግጡ።`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            Markup.button.callback('✅ አጽድቅ', `appr:${tierCode}:${number}`),
            Markup.button.callback('❌ አትቀበል', `rej:${tierCode}:${number}`),
          ]),
        }
      );
    } catch (e) {
      console.error('Failed to notify admin chat — check ADMIN_CHAT_ID is set correctly:', e.message);
      await ctx.reply(
        'ማመልከቻዎ ደርሶናል፣ ነገር ግን አሁን የእቁቡን አስተባባሪዎች ማግኘት አልቻልንም። እባክዎ በውስጥ ያዋሩን።'
      );
    }
    return;
  }

  // Step 1: user sends their Telebirr transaction ID
  const lock = store.getActiveLock(userId);
  if (!lock) return; // not in the middle of a reservation — ignore

  const row = store.getNumberRow(lock.tier, lock.round, lock.number);
  if (!row || row.status !== 'locked') {
    return ctx.reply('የእርስዎ ጥያቄ ለዚህ ቁጥር አስቀድሞ እየታየ ነው — እባክዎ የእቁቡን አስተባባሪዎች ማረጋገጫ ይጠብቁ።');
  }

  const txnId = ctx.message.text.trim();
  if (txnId.length < 4) {
    return ctx.reply('ይህ ትክክለኛ የግብይት ቁጥር አይመስልም። እባክዎ የቴሌብር ግብይት Transaction ID ይላኩ (ለምሳሌ: TRX123456789)።');
  }

  pendingPhoneRequests.set(userId, { tierCode: lock.tier, round: lock.round, number: lock.number, txnId });
  await typing(ctx);
  await ctx.reply(
    `✅ <b>Transaction ID ቁጥር ተቀበልናል!</b>\n\n` +
    `📱 አሁን <b>የከፈሉበት ስልክ ቁጥር</b> ይላኩልን (ለምሳሌ: 0912345678)።`,
    { parse_mode: 'HTML' }
  );
});

// ---------- Admin approve/reject ----------

function isAdminChat(ctx) {
  return String(ctx.chat.id) === String(ADMIN_CHAT_ID);
}

bot.action(/^appr:a:(\d+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('Admins only.', { show_alert: true });
  const tierCode = 'a';
  const number = parseInt(ctx.match[1], 10);
  const round = store.getCurrentRound(tierCode);
  const row = store.getNumberRow(tierCode, round, number);
  if (!row || row.status !== 'pending') {
    return ctx.answerCbQuery('ለዚህ ቁጥር የሚጠባበቅ ነገር የለም።', { show_alert: true });
  }

  store.confirmNumber(tierCode, round, number, row.user_id);
  clearCountdown(row.user_id);
  await ctx.answerCbQuery('✅ ተረጋግጧል።');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ ጸድቋል');

  const tier = TIERS[tierCode];

  if (row.user_id) {
    try {
      const sent = await bot.telegram.sendMessage(row.user_id, '🔍 <b>ክፍያዎ በማረጋገጥ ላይ...እባኮትን ትንሽ ይጠብቁን!</b>', { parse_mode: 'HTML' });
      await sleep(500);
      await bot.telegram.editMessageText(
        row.user_id,
        sent.message_id,
        undefined,
        `🎉 <b>ተረጋግጧል!</b>\n\nለቁጥር ${boldNumber(number)} (${tier.label} ደረጃ) ያደረጉት ክፍያ ተረጋግጧል! በይፋ እቁቡ ውስጥ ገብተዋል። መልካም ዕድል! 🍀`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { /* ignore */ }
  }

  // Push the FULL board to the announcement channel after confirmation
  await postFullBoardToChannel(tierCode, round);

  const confirmed = store.countConfirmed(tierCode, round);
  if (confirmed >= TOTAL_NUMBERS && store.getTierStatus(tierCode) === 'open') {
    await announceBoardFull(tierCode, round);
  }
});

bot.action(/^rej:a:(\d+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('Admins only.', { show_alert: true });
  const tierCode = 'a';
  const number = parseInt(ctx.match[1], 10);
  const round = store.getCurrentRound(tierCode);
  const row = store.getNumberRow(tierCode, round, number);
  if (!row || row.status !== 'pending') {
    return ctx.answerCbQuery('ለዚህ ቁጥር የሚጠባበቅ ነገር የለም።', { show_alert: true });
  }

  store.releaseNumber(tierCode, round, number, row.user_id);
  clearCountdown(row.user_id);
  await ctx.answerCbQuery('ተቀባይነት አላገኘም።');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ ውድቅ ሆነ — ቁጥሩ ተለቋል');

  if (row.user_id) {
    try {
      const sent = await bot.telegram.sendMessage(row.user_id, '🔍 <b>ክፍያዎ በማረጋገጥ ላይ...</b>', { parse_mode: 'HTML' });
      await sleep(500);
      await bot.telegram.editMessageText(
        row.user_id,
        sent.message_id,
        undefined,
        `❌ <b>አልተረጋገጠም</b>\n\nለቁጥር ${number} (${TIERS[tierCode].label} ደረጃ) ያደረጉትን ግብይት ማረጋገጥ አልቻልንም። ቁጥሩ ተለቋል። ` +
          `ስህተት ነው ብለው ካሰቡ፣ እባክዎ ከግብይት ቁጥርዎ ጋር @eletawiequbsupport ላይ ድጋፍ ያግኙ።`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { /* ignore */ }
  }
});

// ---------- Full-board notification (fires once, the moment a round fills up) ----------

async function announceBoardFull(tierCode, round) {
  store.setTierStatus(tierCode, 'full');
  const tier = TIERS[tierCode];

  const text =
    `🎉 <b>ደረጃው ሙሉ በሙሉ ተይዟል!</b> — ${tier.label} ደረጃ (ዙር ${round})\n\n` +
    `ሁሉም ${TOTAL_NUMBERS} ቁጥሮች ተከፍለው ተረጋግጠዋል። 🎊\n` +
    `🎡 አሸናፊው የሚመረጠው አስተዳዳሪዎቻችን በሚያሳውቁት ልዩ ሰዓት ላይ፣ ቀጥታ በሚደረግ የዕጣ ማዞሪያ ነው። እባክዎ ትንሽ ይጠብቁን — ሰዓቱ በቅርቡ ይገለጻል! 🍀`;

  if (ANNOUNCE_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(ANNOUNCE_CHAT_ID, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Could not announce full board to ANNOUNCE_CHAT_ID:', e.message);
    }
  }

  // Privately notify every confirmed participant in this round.
  const rows = store.getTierNumbers(tierCode, round).filter((r) => r.status === 'confirmed' && r.user_id);
  for (const r of rows) {
    try {
      await bot.telegram.sendMessage(r.user_id, text, { parse_mode: 'HTML' });
    } catch (e) { /* user may have blocked the bot — ignore */ }
  }

  try {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `📣 <b>${tier.label} ደረጃ ሙሉ ሆኗል (ዙር ${round})።</b>\n\n` +
        `የዕጣ ሰዓት ለማሳወቅ፦ <code>/settime &lt;ሰዓት&gt;</code>\n` +
        `ቀጥታ ማዞሪያውን ለመጀመር፦ <code>/spin</code>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Failed to notify admin chat that the board is full:', e.message);
  }
}

// Admin-only: announce the specific draw time to the channel and to every
// confirmed participant in the current (full) round. Free-text time — the
// admin decides the format ("ዛሬ ምሽት 9:00", a full date, etc).
bot.command('settime', async (ctx) => {
  if (!isAdminChat(ctx)) return;
  const tierCode = 'a';
  const round = store.getCurrentRound(tierCode);
  const status = store.getTierStatus(tierCode);
  if (status !== 'full' && status !== 'scheduled') {
    return ctx.reply('ደረጃው ገና ሙሉ አልሆነም — ሁሉም ቁጥሮች ተከፍለው እስኪረጋገጡ ድረስ ሰዓት ማዘጋጀት አያስፈልግም።');
  }

  const drawTime = ctx.message.text.replace(/^\/settime(@\w+)?\s*/, '').trim();
  if (!drawTime) {
    return ctx.reply('አጠቃቀም፦ /settime <ቀን እና ሰዓት>  (ለምሳሌ: /settime ዛሬ ምሽት 9:00)');
  }

  store.setDrawTime(tierCode, drawTime);
  store.setTierStatus(tierCode, 'scheduled');

  const tier = TIERS[tierCode];
  const text =
    `⏰ <b>የዕጣ ሰዓት ተገልጿል!</b> — ${tier.label} ደረጃ (ዙር ${round})\n\n` +
    `🎡 አሸናፊው በ<b>${drawTime}</b> ላይ ቀጥታ በሚደረግ የዕጣ ማዞሪያ ይመረጣል። እባክዎ በሰዓቱ ከቻናላችን ጋር ይቆዩ! 🍀`;

  if (ANNOUNCE_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(ANNOUNCE_CHAT_ID, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Could not announce draw time to ANNOUNCE_CHAT_ID:', e.message);
    }
  }

  const rows = store.getTierNumbers(tierCode, round).filter((r) => r.status === 'confirmed' && r.user_id);
  for (const r of rows) {
    try {
      await bot.telegram.sendMessage(r.user_id, text, { parse_mode: 'HTML' });
    } catch (e) { /* ignore */ }
  }

  ctx.reply(`✅ ሰዓቱ ተመዝግቧል እና ተገልጿል፦ ${drawTime}`);
});

// ---------- Live spin wheel — admin-triggered ----------

// Builds one animation frame: every number in the round laid out in a row,
// with the currently-highlighted one boxed by a pointer — a text-only wheel.
function wheelFrame(numbers, highlight) {
  return numbers
    .map((n) => (n === highlight ? `👉<b>${boldNumber(n)}</b>👈` : `${ICON.taken}${n}`))
    .join('   ');
}

// Builds the sequence of numbers the pointer lands on across the animation:
// a few fast laps around the wheel, then a final approach that always ends
// on the real (already-picked) winner, so the animation never "cheats".
function buildSpinSequence(numbers, winnerNumber) {
  const sequence = [];
  const laps = 3;
  for (let lap = 0; lap < laps; lap++) {
    for (const n of numbers) sequence.push(n);
  }
  const winnerIdx = numbers.indexOf(winnerNumber);
  for (let i = 0; i <= winnerIdx; i++) sequence.push(numbers[i]);
  if (sequence[sequence.length - 1] !== winnerNumber) sequence.push(winnerNumber);
  return sequence;
}

// Admin-only manual command to kick off the live, animated draw once a round is full.
bot.command('spin', async (ctx) => {
  if (!isAdminChat(ctx)) return;
  const tierCode = 'a';
  const round = store.getCurrentRound(tierCode);
  const status = store.getTierStatus(tierCode);
  const confirmed = store.countConfirmed(tierCode, round);

  if (confirmed < TOTAL_NUMBERS) {
    return ctx.reply('ገና ሁሉም ቁጥሮች አልተያዙም — ማዞሪያውን ማስጀመር አይቻልም።');
  }
  if (status === 'drawing') {
    return ctx.reply('ማዞሪያው አስቀድሞ በመካሄድ ላይ ነው።');
  }

  store.setTierStatus(tierCode, 'drawing');
  await ctx.reply('🎡 ማዞሪያው ተጀምሯል — ወደ ማስታወቂያ ቻናሉ ይሂዱ!');
  await startLiveSpin(tierCode, round);
});

async function startLiveSpin(tierCode, round) {
  const tier = TIERS[tierCode];
  const winnerRow = store.pickWinnerRow(tierCode, round);
  if (!winnerRow) {
    store.setTierStatus(tierCode, 'open');
    return;
  }

  if (!ANNOUNCE_CHAT_ID) {
    console.error('ANNOUNCE_CHAT_ID not set — cannot run the live spin.');
    store.setTierStatus(tierCode, 'open');
    return;
  }

  const numbers = [];
  for (let n = 1; n <= TOTAL_NUMBERS; n++) numbers.push(n);
  const sequence = buildSpinSequence(numbers, winnerRow.number);
  const header = `🎡 <b>${tier.label} ደረጃ — ቀጥታ የዕጣ ማዞሪያ (ዙር ${round})</b>\n\n`;

  let sentAnnounce;
  try {
    sentAnnounce = await bot.telegram.sendMessage(
      ANNOUNCE_CHAT_ID,
      header + wheelFrame(numbers, sequence[0]),
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error('Could not start live spin on ANNOUNCE_CHAT_ID:', e.message);
    store.setTierStatus(tierCode, 'open');
    return;
  }

  // Animate: fast at first, slowing down toward the end so it feels like a
  // real spinning wheel coasting to a stop on the winner.
  for (let i = 1; i < sequence.length; i++) {
    const fromEnd = sequence.length - i;
    const delay = fromEnd > 6 ? 120 : 120 + (7 - fromEnd) * 180;
    await sleep(delay);
    try {
      await bot.telegram.editMessageText(
        ANNOUNCE_CHAT_ID,
        sentAnnounce.message_id,
        undefined,
        header + wheelFrame(numbers, sequence[i]),
        { parse_mode: 'HTML' }
      );
    } catch (e) { /* transient edit races — ignore, animation continues */ }
  }

  store.recordWinner(tierCode, round, winnerRow.number, winnerRow.user_id, winnerRow.username);

  const finalText =
    `🎊 <b>የዕጣ ውጤት — ${tier.label} ደረጃ (ዙር ${round})</b> 🎊\n\n` +
    `🏆 አሸናፊ ቁጥር፦ ${boldNumber(winnerRow.number)}\n` +
    `👤 አሸናፊ፦ ${winnerRow.username || 'ተጠቃሚ ' + winnerRow.user_id}\n` +
    `📱 ስልክ፦ <code>${winnerRow.phone || '—'}</code>\n\n` +
    `✨ እንኳን ደስ አለዎት! አዲስ ዙር አሁን ይጀምራል — ለመቀላቀል ቁጥር ይምረጡ።`;

  await sleep(600);
  try {
    await bot.telegram.editMessageText(ANNOUNCE_CHAT_ID, sentAnnounce.message_id, undefined, finalText, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Could not post final draw result to ANNOUNCE_CHAT_ID:', e.message);
  }

  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, finalText, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Could not post draw result to ADMIN_CHAT_ID:', e.message);
  }

  // Private message to the winner — confirms to them, specifically, that they won.
  if (winnerRow.user_id) {
    try {
      await bot.telegram.sendMessage(
        winnerRow.user_id,
        `🏆 <b>እንኳን ደስ አለዎት! እርስዎ አሸናፊ ነዎት! 🎉</b>\n\n` +
          `በቁጥር ${boldNumber(winnerRow.number)} የ${tier.label} ዕጣውን አሸንፈዋል! አስተዳዳሪያችን በቅርቡ ያገኝዎታል። 🍾`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { /* ignore — e.g. user blocked the bot */ }
  }

  store.startNewRound(tierCode);
}

// Admin-only manual command to force-start a fresh round for a tier (e.g. to reset a stalled one)
bot.command('newround', async (ctx) => {
  if (!isAdminChat(ctx)) return;
  const tierCode = 'a';
  const next = store.startNewRound(tierCode);
  ctx.reply(`ለ${TIERS[tierCode].label} ደረጃ ዙር ${next} ተጀምሯል። ሁሉም ቁጥሮች እንደገና ክፍት ናቸው።`);
});

// ---------- Safety net: periodic sweep for expired locks (covers server restarts) ----------
setInterval(() => {
  const cutoff = Date.now() - LOCK_MINUTES * 60 * 1000;
  const expired = store.findExpiredLocks(cutoff);
  for (const row of expired) {
    store.releaseNumber(row.tier, row.round, row.number, row.user_id);
    clearCountdown(row.user_id);
    pendingPhoneRequests.delete(row.user_id);
    if (row.user_id) {
      bot.telegram
        .sendMessage(
          row.user_id,
          `⌛ ቁጥር ${row.number} (${TIERS[row.tier].label} ደረጃ) ማስያዝ ጊዜው አልቋል እና ተለቋል።`
        )
        .catch(() => {});
    }
  }
}, 30 * 1000);

// Global safety net: log unexpected errors instead of crashing the whole process.
bot.catch((err, ctx) => {
  console.error(`Unhandled bot error for update ${ctx.updateType}:`, err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (bot kept running):', err && err.message);
});

bot.launch().then(() => console.log('Bot is running (polling mode).'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
