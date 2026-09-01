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
const PAGE_SIZE = 50; // numbers per page (5 rows x 10)
const PICK_COUNT = 5; // how many numbers a single reservation must contain

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
  locked: '🔒',
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
function gradientBar(filled, total = 100, size = 10) {
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
// phone number they paid from, before the submission is finalized. Holds
// the whole batch of numbers the txn ID applies to.
const pendingPhoneRequests = new Map(); // userId -> { tierCode, round, numbers, txnId }

// Tracks numbers a user has tapped but not yet locked/paid for — the
// "in progress" selection before they've picked all PICK_COUNT numbers.
const selectionSessions = new Map(); // userId -> { tierCode, numbers: number[] }

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

function reservationCardText(tier, numbers, remainingMs) {
  const total = tier.amount * numbers.length;
  const numberList = numbers.map((n) => boldNumber(n)).join('፣ ');
  return (
    `🔒 <b>የመረጡትን ${numbers.length} ቁጥሮች ይዘዋል</b>\n\n` +
    `ቁጥሮች <b>${numberList}</b> በ<b>${tier.label}</b> ለእርስዎ ተይዘዋል።\n\n` +
    `<blockquote>📲 <b>${total} ብር</b> (${numbers.length} × ${tier.amount}) በቴሌብር ወደ፦\n<code>${TELEBIRR_NUMBER}</code>  (${TELEBIRR_NAME})</blockquote>\n\n` +
    `⏳ ለማረጋገጥ የሚቀሮት ደቂቃ ፦ <b>${formatRemaining(remainingMs)}</b>\n` +
    `ብሩን ከላኩ በኋላ የቴሌብር Transaction እዚሁ ይላኩልን።\n` +
    `በ${LOCK_MINUTES} ደቂቃ ውስጥ ካልደረሰን፣ ምርጫዎ ይሰረዝ እና ቁጥሮቹ ለሁሉም ሰው ክፍት ይሆናሉ።`
  );
}

// Tracks the "live" reservation card so it can be countdown-animated and
// later resolved (submitted / expired) without touching persisted state.
const activeCountdowns = new Map(); // userId -> { intervalId, chatId, messageId, tierCode, round, numbers, expiry }

function clearCountdown(userId) {
  const c = activeCountdowns.get(userId);
  if (c) {
    clearInterval(c.intervalId);
    activeCountdowns.delete(userId);
  }
  return c || null;
}

function startCountdown(userId, chatId, messageId, tierCode, round, numbers, expiry) {
  clearCountdown(userId);
  const tier = TIERS[tierCode];
  const intervalId = setInterval(async () => {
    const stillLocked = numbers.every((n) => {
      const row = store.getNumberRow(tierCode, round, n);
      return row && row.status === 'locked';
    });
    const remaining = expiry - Date.now();
    if (!stillLocked || remaining <= 0) {
      clearCountdown(userId);
      return;
    }
    try {
      await bot.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        reservationCardText(tier, numbers, remaining),
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      /* ignore transient edit failures */
    }
  }, 20000);
  activeCountdowns.set(userId, { intervalId, chatId, messageId, tierCode, round, numbers, expiry });
}

// ---------- Generate and send full board to announcement channel ----------
async function postFullBoardToChannel(tierCode, round) {
  if (!ANNOUNCE_CHAT_ID) return;

  const rows = store.getTierNumbers(tierCode, round);
  const byNumber = {};
  for (const r of rows) byNumber[r.number] = r;

  const lines = [];
  for (let n = 1; n <= 100; n++) {
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
  const bar = gradientBar(filled, 100, 5);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`💎 ${tier.label}  ${bar}  ${filled}/100`, `tier:${tierCode}`)],
  ]);
}

// `selected` is the list of numbers the user has already tapped in this
// in-progress reservation (not yet locked in the DB) — shown with a star.
function numbersGridKeyboard(tierCode, round, page, selected = []) {
  const rows = store.getTierNumbers(tierCode, round);
  const statusByNumber = {};
  for (const r of rows) statusByNumber[r.number] = r.status;
  const selectedSet = new Set(selected);

  const start = page * PAGE_SIZE + 1;
  const end = Math.min(start + PAGE_SIZE - 1, 100);

  const buttons = [];
  let row = [];
  for (let n = start; n <= end; n++) {
    const status = statusByNumber[n];
    let icon;
    // Star = picked by me (pending confirmation); green = free and
    // pickable; red = taken (locked / under review / confirmed by
    // someone else — all read the same from a picker's point of view).
    if (selectedSet.has(n)) {
      icon = `⭐${boldNumber(n)}`;
    } else if (!status) {
      icon = `${ICON.free}${boldNumber(n)}`;
    } else {
      icon = `${ICON.taken}${n}`;
    }

    if (selectedSet.has(n) || !status) {
      row.push(Markup.button.callback(icon, `pick:${tierCode}:${n}:${page}`));
    } else {
      row.push(Markup.button.callback(icon, 'noop')); // not selectable
    }
    if (row.length === 10) {
      buttons.push(row);
      row = [];
    }
  }
  if (row.length) buttons.push(row);

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀️ ወደኋላ', `pg:${tierCode}:${page - 1}`));
  if (end < 100) nav.push(Markup.button.callback('ወደፊት ▶️', `pg:${tierCode}:${page + 1}`));
  if (nav.length) buttons.push(nav);

  buttons.push([
    Markup.button.callback(
      selectedSet.size === PICK_COUNT
        ? `✅ ${PICK_COUNT} ቁጥሮች ተመርጠዋል — ማረጋገጫ`
        : `⭐ የተመረጡ ${selectedSet.size}/${PICK_COUNT}`,
      `confirmpick:${tierCode}`
    ),
  ]);
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
    `ለማስጀመር እና ${PICK_COUNT} ቁጥሮችን ለመያዝ ከታች ያለውን ይምረጡ፣ ከዚያም ${ICON.free} ካልተያዙ ቁጥሮች ከ<b>1</b> እስከ <b>100</b> ውስጥ በድምሩ <b>${PICK_COUNT}</b> ቁጥሮችን ይምረጡ! ` +
    `ክፍያውን በቴሌብር በ<b>${LOCK_MINUTES} ደቂቃ</b> ውስጥ ልከው የግብይት ቁጥርዎን እና ስልክ ቁጥሮን ማስገባት ይኖርብዎታል። ` +
    `በዝርዝር ውስጥ ያሉት 100 ቁጥሮች ሁሉ ተከፍለው ሲረጋገጡ አንድ አሸናፊ በእጣ ይመረጣል።\n\n` +
    `መልካም እድል 🎉🎉🎉\n\n` +
    `<blockquote>${ICON.free} ያልተያዘ  ⭐ የተመረጠ  ${ICON.taken} የተያዘ</blockquote>\n\n` +
    `👇 ለመጀመር ከታች ይንኩ እና ${PICK_COUNT} ቁጥሮችን ይምረጡ፦`;

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
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  await typing(ctx);
  const round = store.getCurrentRound(tierCode);
  const filled = store.countConfirmed(tierCode, round);
  const session = selectionSessions.get(userId);
  const selected = session && session.tierCode === tierCode ? session.numbers : [];
  await ctx.editMessageText(
    `💎 በ <b>${TIERS[tierCode].label} መደብ</b>\n${gradientBar(filled)}  ${filled}/100\n\n` +
      `${PICK_COUNT} ${ICON.free} ያልተያዙ ቁጥሮችን ይምረጡ (1–100)፦`,
    { parse_mode: 'HTML', ...numbersGridKeyboard(tierCode, round, 0, selected) }
  );
});

bot.action(/^pg:a:(\d+)$/, async (ctx) => {
  const tierCode = 'a';
  const page = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  await typing(ctx);
  const round = store.getCurrentRound(tierCode);
  const filled = store.countConfirmed(tierCode, round);
  const session = selectionSessions.get(userId);
  const selected = session && session.tierCode === tierCode ? session.numbers : [];
  await ctx.editMessageText(
    `💎 <b>${TIERS[tierCode].label} መደብ</b>\n${gradientBar(filled)}  ${filled}/100\n\n` +
      `${PICK_COUNT} ${ICON.free} ክፍት ቁጥሮችን ይምረጡ (1–100)፦`,
    { parse_mode: 'HTML', ...numbersGridKeyboard(tierCode, round, page, selected) }
  );
});

// Full text board: every number 1–100, 🟢 free or 🔴 taken (with masked
// phone for taken ones). Chunked so a fully-booked tier never risks
// exceeding Telegram's per-message length limit.
async function sendBoard(ctx, tierCode) {
  const round = store.getCurrentRound(tierCode);
  const rows = store.getTierNumbers(tierCode, round);
  const byNumber = {};
  for (const r of rows) byNumber[r.number] = r;

  const lines = [];
  for (let n = 1; n <= 100; n++) {
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

// Tapping a free number toggles it in/out of the user's in-progress
// selection (up to PICK_COUNT numbers) — it isn't locked in the DB yet.
bot.action(/^pick:a:(\d+):(\d+)$/, async (ctx) => {
  const tierCode = 'a';
  const number = parseInt(ctx.match[1], 10);
  const page = parseInt(ctx.match[2], 10);
  const userId = ctx.from.id;

  const existingLock = store.getActiveLock(userId);
  if (existingLock) {
    await ctx.answerCbQuery('አስቀድመው የያዙት ማስያዝ አለ። እባክዎ መጀመሪያ ያንን ይጨርሱ።', { show_alert: true });
    return;
  }

  const round = store.getCurrentRound(tierCode);
  const current = store.getNumberRow(tierCode, round, number);

  let session = selectionSessions.get(userId);
  if (!session || session.tierCode !== tierCode) {
    session = { tierCode, numbers: [] };
  }

  const idx = session.numbers.indexOf(number);
  if (idx !== -1) {
    // Already selected — tapping again deselects it.
    session.numbers.splice(idx, 1);
    await ctx.answerCbQuery('ምርጫ ተነስቷል።');
  } else {
    if (current) {
      await ctx.answerCbQuery('ይቅርታ፣ ያ ቁጥር በሌላ ሰው ተይዟል።', { show_alert: true });
      return;
    }
    if (session.numbers.length >= PICK_COUNT) {
      await ctx.answerCbQuery(`ቀድሞውኑ ${PICK_COUNT} ቁጥሮች መርጠዋል። ለውጥ ለማድረግ ከመረጧቸው ውስጥ አንዱን ይንኩ።`, { show_alert: true });
      return;
    }
    session.numbers.push(number);
    await ctx.answerCbQuery(`⭐ ተመርጧል (${session.numbers.length}/${PICK_COUNT})`);
  }

  selectionSessions.set(userId, session);

  const filled = store.countConfirmed(tierCode, round);
  try {
    await ctx.editMessageText(
      `💎 <b>${TIERS[tierCode].label} መደብ</b>\n${gradientBar(filled)}  ${filled}/100\n\n` +
        `${PICK_COUNT} ${ICON.free} ያልተያዙ ቁጥሮችን ይምረጡ (1–100)፦`,
      { parse_mode: 'HTML', ...numbersGridKeyboard(tierCode, round, page, session.numbers) }
    );
  } catch (e) {
    /* identical-content edit errors — ignore */
  }
});

// Once exactly PICK_COUNT numbers are selected, this locks all of them
// together and kicks off a single reservation/payment flow for the batch.
bot.action(/^confirmpick:a$/, async (ctx) => {
  const tierCode = 'a';
  const tier = TIERS[tierCode];
  const userId = ctx.from.id;

  const existingLock = store.getActiveLock(userId);
  if (existingLock) {
    await ctx.answerCbQuery('አስቀድመው የያዙት ማስያዝ አለ።', { show_alert: true });
    return;
  }

  const session = selectionSessions.get(userId);
  if (!session || session.tierCode !== tierCode || session.numbers.length !== PICK_COUNT) {
    await ctx.answerCbQuery(`እባክዎ በትክክል ${PICK_COUNT} ቁጥሮች ይምረጡ።`, { show_alert: true });
    return;
  }

  const round = store.getCurrentRound(tierCode);

  // Re-check none of the chosen numbers got taken by someone else while selecting.
  const stillFree = session.numbers.every((n) => !store.getNumberRow(tierCode, round, n));
  if (!stillFree) {
    selectionSessions.delete(userId);
    await ctx.answerCbQuery('ይቅርታ፣ ከመረጧቸው ቁጥሮች አንዱ አሁን በሌላ ሰው ተይዟል። እባክዎ እንደገና ይምረጡ።', { show_alert: true });
    await typing(ctx);
    try {
      await ctx.editMessageText(
        `💎 <b>${tier.label} መደብ</b>\n\n${PICK_COUNT} ${ICON.free} ያልተያዙ ቁጥሮችን ይምረጡ (1–100)፦`,
        { parse_mode: 'HTML', ...numbersGridKeyboard(tierCode, round, 0, []) }
      );
    } catch (e) { /* ignore */ }
    return;
  }

  const numbers = [...session.numbers].sort((a, b) => a - b);
  selectionSessions.delete(userId);

  for (const n of numbers) {
    store.lockNumber(tierCode, round, n, userId, displayName(ctx.from));
  }
  const now = Date.now();
  const expiry = now + LOCK_MINUTES * 60 * 1000;
  store.setActiveLock(userId, tierCode, round, numbers, now);

  await ctx.answerCbQuery(`${ICON.locked} ቁጥሮቹ ተይዘዋል!`);
  await typing(ctx);

  const sent = await ctx.reply(`${ICON.locked} <b>በመያዝ ላይ...</b>`, { parse_mode: 'HTML' });
  await sleep(350);
  const cardText = reservationCardText(tier, numbers, expiry - Date.now());
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

  startCountdown(userId, sent.chat.id, sent.message_id, tierCode, round, numbers, expiry);

  setTimeout(async () => {
    const lock = store.getActiveLock(userId);
    const stillOurs =
      lock &&
      lock.tier === tierCode &&
      lock.round === round &&
      numbers.length === lock.numbers.length &&
      numbers.every((n) => lock.numbers.includes(n));
    if (stillOurs) {
      for (const n of numbers) store.releaseNumber(tierCode, round, n);
      store.clearActiveLock(userId);
      clearCountdown(userId);
      pendingPhoneRequests.delete(userId);
      const expiredText = `⌛ <b>ጊዜው አልቋል</b>\n\nቁጥሮች ${numbers.join('፣ ')} (${tier.label} መደብ) በሰዓቱ ስላልተረጋገጡ ተለቀዋል። ${ICON.free} ለሁሉም ሰው ክፍት ሆነዋል — በማንኛውም ጊዜ እንደገና ${PICK_COUNT} ቁጥሮችን መምረጥ ይችላሉ።`;
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

// Reservation completion is two steps for the whole batch: (1) the Telebirr
// transaction ID, then (2) the phone number that was used to pay, so it can
// be masked and shown next to each number on the board / announcement.
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;

  // Step 2: we already have a txn ID for this user and are waiting on the phone number
  const awaitingPhone = pendingPhoneRequests.get(userId);
  if (awaitingPhone) {
    const { tierCode, round, numbers, txnId } = awaitingPhone;
    const allLocked = numbers.every((n) => {
      const row = store.getNumberRow(tierCode, round, n);
      return row && row.status === 'locked';
    });
    if (!allLocked) {
      pendingPhoneRequests.delete(userId);
      return ctx.reply(
        `⚠️ <b>ይህ ማስያዝ ጊዜው አልፎበታል ወይም ተቀይሯል።</b>\n\n` +
        `እባክዎ ከመጀመሪያው ይሞክሩ — ${PICK_COUNT} ቁጥሮች ይምረጡ።`,
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
    for (const n of numbers) {
      store.setPayerPhone(tierCode, round, n, phone);
      store.submitTxn(tierCode, round, n, txnId);
    }

    const masked = maskPhone(phone);
    const tier = TIERS[tierCode];
    const numberList = numbers.map((n) => boldNumber(n)).join('፣ ');

    const countdown = clearCountdown(userId);
    if (countdown) {
      try {
        await bot.telegram.editMessageText(
          countdown.chatId,
          countdown.messageId,
          undefined,
          `${ICON.pending} <b>በክለሳ ላይ</b>\n\nቁጥሮች <b>${numberList}</b> — ${tier.label} መድብ\n<blockquote>የግብይት ቁጥር፦ <code>${txnId}</code>\nስልክ፦ <code>${masked}</code></blockquote>`,
          { parse_mode: 'HTML' }
        );
      } catch (e) { /* ignore */ }
    }

    await typing(ctx);
    await ctx.reply(
      `✅ <b>ተቀበልናል!</b>\n\n` +
      `<blockquote>ቁጥሮች: ${numberList}\nግብይት ቁጥር: <code>${txnId}</code>\nስልክ: <code>${masked}</code></blockquote>\n\n` +
      `📨 ክፍያዎ አሁን እየተረጋገጠ ነው። እባኮትን ትንሽ ደቂቃ ይጠብቁን።`,
      { parse_mode: 'HTML' }
    );

    const numbersCsv = numbers.join(',');
    try {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🆕 <b>አዲስ ክፍያ ገብቷል</b>\n\n` +
          `<blockquote>ደረጃ፦ ${tier.label}\nቁጥሮች፦ ${numbers.join('፣ ')}\nጠቅላላ፦ ${tier.amount * numbers.length} ብር\nተጠቃሚ፦ ${displayName(ctx.from)} (id ${userId})\nየግብይት መታወቂያ፦ <code>${txnId}</code>\nስልክ፦ <code>${masked}</code></blockquote>\n\n` +
          `ከማጽደቅዎ በፊት ከቴሌብር ዝርዝርዎ ጋር እባክዎ ያረጋግጡ።`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            Markup.button.callback('✅ አጽድቅ', `appr:${tierCode}:${numbersCsv}`),
            Markup.button.callback('❌ አትቀበል', `rej:${tierCode}:${numbersCsv}`),
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

  // Step 1: user sends their Telebirr transaction ID for the whole batch
  const lock = store.getActiveLock(userId);
  if (!lock) return; // not in the middle of a reservation — ignore

  const allLocked = lock.numbers.every((n) => {
    const row = store.getNumberRow(lock.tier, lock.round, n);
    return row && row.status === 'locked';
  });
  if (!allLocked) {
    return ctx.reply('የእርስዎ ጥያቄ ለእነዚህ ቁጥሮች አስቀድሞ እየታየ ነው — እባክዎ የእቁቡን አስተባባሪዎች ማረጋገጫ ይጠብቁ።');
  }

  const txnId = ctx.message.text.trim();
  if (txnId.length < 4) {
    return ctx.reply('ይህ ትክክለኛ የግብይት ቁጥር አይመስልም። እባክዎ የቴሌብር ግብይት Transaction ID ይላኩ (ለምሳሌ: TRX123456789)።');
  }

  pendingPhoneRequests.set(userId, { tierCode: lock.tier, round: lock.round, numbers: lock.numbers, txnId });
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

bot.action(/^appr:a:([\d,]+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('Admins only.', { show_alert: true });
  const tierCode = 'a';
  const numbers = ctx.match[1].split(',').map(Number);
  const round = store.getCurrentRound(tierCode);

  const rows = numbers.map((n) => store.getNumberRow(tierCode, round, n));
  if (rows.some((r) => !r || r.status !== 'pending')) {
    return ctx.answerCbQuery('ለእነዚህ ቁጥሮች የሚጠባበቅ ነገር የለም።', { show_alert: true });
  }

  const userId = rows[0].user_id;
  for (const n of numbers) store.confirmNumber(tierCode, round, n);
  if (userId) store.clearActiveLock(userId);
  clearCountdown(userId);
  await ctx.answerCbQuery('✅ ተረጋግጧል።');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ ጸድቋል');

  const tier = TIERS[tierCode];

  if (userId) {
    try {
      const sent = await bot.telegram.sendMessage(userId, '🔍 <b>ክፍያዎ በማረጋገጥ ላይ...እባኮትን ትንሽ ይጠብቁን!</b>', { parse_mode: 'HTML' });
      await sleep(500);
      await bot.telegram.editMessageText(
        userId,
        sent.message_id,
        undefined,
        `🎉 <b>ተረጋግጧል!</b>\n\nለቁጥሮች ${numbers.map(boldNumber).join('፣ ')} (${tier.label} ደረጃ) ያደረጉት ክፍያ ተረጋግጧል! በይፋ እቁቡ ውስጥ ገብተዋል። መልካም ዕድል! 🍀`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { /* ignore */ }
  }

  // Push the FULL board to the announcement channel after confirmation
  await postFullBoardToChannel(tierCode, round);

  const confirmed = store.countConfirmed(tierCode, round);
  if (confirmed >= 100) {
    await runDraw(tierCode, round);
  }
});

bot.action(/^rej:a:([\d,]+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('Admins only.', { show_alert: true });
  const tierCode = 'a';
  const numbers = ctx.match[1].split(',').map(Number);
  const round = store.getCurrentRound(tierCode);

  const rows = numbers.map((n) => store.getNumberRow(tierCode, round, n));
  if (rows.some((r) => !r || r.status !== 'pending')) {
    return ctx.answerCbQuery('ለእነዚህ ቁጥሮች የሚጠባበቅ ነገር የለም።', { show_alert: true });
  }

  const userId = rows[0].user_id;
  for (const n of numbers) store.releaseNumber(tierCode, round, n);
  if (userId) store.clearActiveLock(userId);
  clearCountdown(userId);
  await ctx.answerCbQuery('ተቀባይነት አላገኘም።');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ ውድቅ ሆነ — ቁጥሮቹ ተለቀዋል');

  if (userId) {
    try {
      const sent = await bot.telegram.sendMessage(userId, '🔍 <b>ክፍያዎ በማረጋገጥ ላይ...</b>', { parse_mode: 'HTML' });
      await sleep(500);
      await bot.telegram.editMessageText(
        userId,
        sent.message_id,
        undefined,
        `❌ <b>አልተረጋገጠም</b>\n\nለቁጥሮች ${numbers.join('፣ ')} (${TIERS[tierCode].label} ደረጃ) ያደረጉትን ግብይት ማረጋገጥ አልቻልንም። ቁጥሮቹ ተለቀዋል። ` +
          `ስህተት ነው ብለው ካሰቡ፣ እባክዎ ከግብይት ቁጥርዎ ጋር @eletawiequbsupport ላይ ድጋፍ ያግኙ።`,
        { parse_mode: 'HTML' }
      );
    } catch (e) { /* ignore */ }
  }
});

async function runDraw(tierCode, round) {
  const winnerRow = store.pickWinnerRow(tierCode, round);
  if (!winnerRow) return;
  store.recordWinner(tierCode, round, winnerRow.number, winnerRow.user_id, winnerRow.username);

  const tier = TIERS[tierCode];
  const suspenseFrames = [
    `🎰 <b>ደረጃው ተሞልቷል! ዕጣ በመሽከርከር ላይ</b> ⚙️`,
    `🎰 <b>ደረጃው ተሞልቷል! ዕጣ በመሽከርከር ላይ</b> ⚙️.`,
    `🎰 <b>ደረጃው ተሞልቷል! ዕጣ በመሽከርከር ላይ</b> ⚙️..`,
    `🎰 <b>ደረጃው ተሞልቷል! ዕጣ በመሽከርከር ላይ</b> ⚙️...`,
  ];
  const finalText =
    `🎊 <b>የዕጣ ውጤት — ${tier.label} ደረጃ (ዙር ${round})</b> 🎊\n\n` +
    `🏆 አሸናፊ ቁጥር፦ ${boldNumber(winnerRow.number)}\n` +
    `👤 አሸናፊ፦ ${winnerRow.username || 'ተጠቃሚ ' + winnerRow.user_id}\n\n` +
    `✨ እንኳን ደስ አለዎት! አዲስ ዙር አሁን ይጀምራል — ለመቀላቀል ${PICK_COUNT} ቁጥሮች ይምረጡ።`;

  try {
    const sentAdmin = await bot.telegram.sendMessage(ADMIN_CHAT_ID, suspenseFrames[0], { parse_mode: 'HTML' });
    await playFrames(bot.telegram, ADMIN_CHAT_ID, sentAdmin.message_id, suspenseFrames.slice(1), { parse_mode: 'HTML' }, 500);
    await sleep(500);
    await bot.telegram.editMessageText(ADMIN_CHAT_ID, sentAdmin.message_id, undefined, finalText, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Could not post draw result to ADMIN_CHAT_ID:', e.message);
  }

  if (ANNOUNCE_CHAT_ID) {
    try {
      const sentAnnounce = await bot.telegram.sendMessage(ANNOUNCE_CHAT_ID, suspenseFrames[0], { parse_mode: 'HTML' });
      await playFrames(bot.telegram, ANNOUNCE_CHAT_ID, sentAnnounce.message_id, suspenseFrames.slice(1), { parse_mode: 'HTML' }, 500);
      await sleep(500);
      await bot.telegram.editMessageText(ANNOUNCE_CHAT_ID, sentAnnounce.message_id, undefined, finalText, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Could not post to ANNOUNCE_CHAT_ID:', e.message);
    }
  }

  if (winnerRow.user_id) {
    try {
      await bot.telegram.sendMessage(
        winnerRow.user_id,
        `🏆 <b>እንኳን ደስ አለዎት!</b>\n\nበቁጥር ${boldNumber(winnerRow.number)} የ${tier.label} ዕጣውን አሸንፈዋል! አስተዳዳሪያችን በቅርቡ ያገኝዎታል። 🍾`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {}
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
  const byUser = new Map();
  for (const row of expired) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row);
  }
  for (const [userId, rows] of byUser) {
    for (const row of rows) store.releaseNumber(row.tier, row.round, row.number);
    if (userId) store.clearActiveLock(userId);
    clearCountdown(userId);
    pendingPhoneRequests.delete(userId);
    if (userId) {
      const tierLabel = TIERS[rows[0].tier].label;
      const numberList = rows.map((r) => r.number).join('፣ ');
      bot.telegram
        .sendMessage(userId, `⌛ ቁጥሮች ${numberList} (${tierLabel} ደረጃ) ማስያዝ ጊዜው አልቋል እና ተለቀዋል።`)
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
