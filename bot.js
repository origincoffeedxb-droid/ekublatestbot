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
  b: { amount: 500, label: '500 ብር' },
  c: { amount: 1000, label: '1000 ብር' },
};
const PAGE_SIZE = 50; // numbers per page (5 rows x 10)

function displayName(from) {
  return from.username ? '@' + from.username : (from.first_name || 'ተጠቃሚ');
}

// ---------- "Next-gen" number styling helpers ----------

// Renders a number using bold Unicode math digits (𝟏𝟐𝟑...) so open/actionable
// numbers visually pop against the plain-digit taken/pending ones.
const BOLD_DIGITS = ['𝟎', '𝟏', '𝟐', '𝟑', '𝟒', '𝟓', '𝟔', '𝟕', '𝟖', '𝟗'];
function boldNumber(n) {
  return String(n).split('').map((d) => BOLD_DIGITS[Number(d)]).join('');
}

// Compact 10-block progress bar for a tier's fill status.
function progressBar(filled, total = 100, size = 10) {
  const filledBlocks = Math.max(0, Math.min(size, Math.round((filled / total) * size)));
  return '🟪'.repeat(filledBlocks) + '⬜'.repeat(size - filledBlocks);
}

const STATUS_LABEL = {
  locked: 'ተይዟል',
  pending: 'በክለሳ ላይ',
  confirmed: 'ተረጋግጧል',
};

// ---------- Keyboards ----------

function mainMenuKeyboard() {
  const buttons = Object.entries(TIERS).map(([code, t]) => {
    const round = store.getCurrentRound(code);
    const filled = store.countConfirmed(code, round);
    return [Markup.button.callback(`💎 ${t.label}  •  ${filled}/100 ተይዟል`, `tier:${code}`)];
  });
  return Markup.inlineKeyboard(buttons);
}

function numbersGridKeyboard(tierCode, round, page) {
  const rows = store.getTierNumbers(tierCode, round);
  const statusByNumber = {};
  for (const r of rows) statusByNumber[r.number] = r.status;

  const start = page * PAGE_SIZE + 1;
  const end = Math.min(start + PAGE_SIZE - 1, 100);

  const buttons = [];
  let row = [];
  for (let n = start; n <= end; n++) {
    const status = statusByNumber[n];
    let icon;
    // Open numbers get a bold "gem" chip look; taken/pending numbers stay
    // visually muted/flat so the eye is drawn straight to what's available.
    if (!status) icon = `🔷${boldNumber(n)}`; // open — actionable
    else if (status === 'locked') icon = `🔒${n}`; // reserved (temp hold)
    else if (status === 'pending') icon = `🟠${n}`; // payment under review
    else icon = `⚫${n}`; // confirmed / taken

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
  if (end < 100) nav.push(Markup.button.callback('ወደፊት ▶️', `pg:${tierCode}:${page + 1}`));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback('🔙 ወደ ደረጃዎች ተመለስ', 'menu')]);

  return Markup.inlineKeyboard(buttons);
}

// Persistent bottom menu (reply keyboard) — gives the bot an "app" feel.
function replyMenu() {
  return Markup.keyboard([
    ['🎟 ቁጥር ምረጥ', '📍 ማስያዜ'],
    ['❓ እገዛ'],
  ]).resize();
}

// ---------- Commands ----------

// Temporary helper: reveals the current chat's ID so you can find your ADMIN_CHAT_ID.
// Safe to leave in permanently — it only ever shows the ID of the chat it's used in.
bot.command('whereami', (ctx) => {
  ctx.reply(`Chat ID: ${ctx.chat.id}\nChat type: ${ctx.chat.type}\nChat title: ${ctx.chat.title || '(none — private chat)'}`);
});

bot.start(async (ctx) => {
  await ctx.reply(
    `🎉 <b>እንኳን ወደ ${TELEBIRR_NAME} ዕለታዊ ዕጣ በደህና መጡ!</b>\n\n` +
      `ከታች ያለውን ደረጃ ይምረጡ፣ ከዚያም ከ<b>1</b> እስከ <b>100</b> ውስጥ ክፍት ቁጥር ይያዙ። ` +
      `ክፍያውን በቴሌብር በ<b>${LOCK_MINUTES} ደቂቃ</b> ውስጥ ልከው የግብይት ቁጥሩን ማስገባት ይኖርብዎታል። ` +
      `በደረጃው ውስጥ ያሉት 100 ቁጥሮች ሁሉ ተከፍለው ሲረጋገጡ በራስ-ሰር አንድ አሸናፊ ይመረጣል።\n\n` +
      `<b>መግለጫ</b>\n🔷 ክፍት   🔒 ተይዟል   🟠 በክለሳ ላይ   ⚫ ተረጋግጧል\n\n` +
      `👇 ለመጀመር ደረጃ ይምረጡ፦`,
    { parse_mode: 'HTML', ...mainMenuKeyboard() }
  );
  await ctx.reply('ከታች ያለውን ምናሌ በማንኛውም ጊዜ ይጠቀሙ 👇', replyMenu());
});

bot.command('numbers', (ctx) => {
  ctx.reply('ቁጥሮችን ለማየት ደረጃ ይምረጡ፦', mainMenuKeyboard());
});
bot.hears('🎟 ቁጥር ምረጥ', (ctx) => {
  ctx.reply('ቁጥሮችን ለማየት ደረጃ ይምረጡ፦', mainMenuKeyboard());
});

function mynumberReply(ctx) {
  const lock = store.getActiveLock(ctx.from.id);
  if (!lock) return ctx.reply('❕ አሁን ምንም ንቁ ማስያዝ የለዎትም።');
  const row = store.getNumberRow(lock.tier, lock.round, lock.number);
  const status = row ? (STATUS_LABEL[row.status] || row.status) : 'የማይታወቅ';
  ctx.reply(
    `📍 <b>የእርስዎ ማስያዝ፦</b> ቁጥር ${boldNumber(lock.number)} በ${TIERS[lock.tier].label} ደረጃ።\n` +
      `ሁኔታ፦ ${status}`,
    { parse_mode: 'HTML' }
  );
}
bot.command('mynumber', mynumberReply);
bot.hears('📍 ማስያዜ', mynumberReply);

bot.hears('❓ እገዛ', (ctx) => ctx.reply('🛟 ድጋፍ ካስፈለገዎት፦ @yourusername'));

bot.action('noop', (ctx) => ctx.answerCbQuery('ይህ ቁጥር አስቀድሞ ተይዟል።'));

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('ደረጃ ይምረጡ፦', mainMenuKeyboard());
});

bot.action(/^tier:([a-c])$/, async (ctx) => {
  const tierCode = ctx.match[1];
  await ctx.answerCbQuery();
  const round = store.getCurrentRound(tierCode);
  const filled = store.countConfirmed(tierCode, round);
  await ctx.editMessageText(
    `💎 <b>${TIERS[tierCode].label} ደረጃ</b>\n${progressBar(filled)}  ${filled}/100\n\n` +
      `ማንኛውንም 🔷 ክፍት ቁጥር ይምረጡ (1–100)፦`,
    { parse_mode: 'HTML', ...numbersGridKeyboard(tierCode, round, 0) }
  );
});

bot.action(/^pg:([a-c]):(\d+)$/, async (ctx) => {
  const tierCode = ctx.match[1];
  const page = parseInt(ctx.match[2], 10);
  await ctx.answerCbQuery();
  const round = store.getCurrentRound(tierCode);
  const filled = store.countConfirmed(tierCode, round);
  await ctx.editMessageText(
    `💎 <b>${TIERS[tierCode].label} ደረጃ</b>\n${progressBar(filled)}  ${filled}/100\n\n` +
      `ማንኛውንም 🔷 ክፍት ቁጥር ይምረጡ (1–100)፦`,
    { parse_mode: 'HTML', ...numbersGridKeyboard(tierCode, round, page) }
  );
});

bot.action(/^pick:([a-c]):(\d+)$/, async (ctx) => {
  const tierCode = ctx.match[1];
  const number = parseInt(ctx.match[2], 10);
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
  await ctx.answerCbQuery('ቁጥር ተይዟል! 🔷');

  await ctx.reply(
    `✅ ቁጥር <b>${boldNumber(number)}</b> በ${tier.label} ደረጃ ውስጥ ለ<b>${LOCK_MINUTES} ደቂቃ</b> ለእርስዎ ተይዟል። ⏱️\n\n` +
      `📲 <b>${tier.amount} ብር</b> በቴሌብር ወደ፦\n<code>${TELEBIRR_NUMBER}</code> (${TELEBIRR_NAME})\n\n` +
      `ከላኩ በኋላ የቴሌብር ግብይት ቁጥርዎን (ለምሳሌ ABC123XYZ) ጊዜው ከማለቁ በፊት እዚህ ይላኩልን። ` +
      `በሰዓቱ ካልደረሰን፣ ቁጥሩ ለሁሉም ሰው ክፍት ይሆናል።`,
    { parse_mode: 'HTML' }
  );

  setTimeout(async () => {
    const row = store.getNumberRow(tierCode, round, number);
    if (row && row.status === 'locked') {
      store.releaseNumber(tierCode, round, number, userId);
      try {
        await bot.telegram.sendMessage(
          userId,
          `⏰ ጊዜው አልቋል — ቁጥር ${number} (${TIERS[tierCode].label} ደረጃ) በሰዓቱ ስላልተረጋገጠ ተለቋል። በማንኛውም ጊዜ ሌላ ቁጥር መምረጥ ይችላሉ።`
        );
      } catch (e) { /* user may have blocked the bot */ }
    }
  }, LOCK_MINUTES * 60 * 1000);
});

// User sends their Telebirr transaction ID as a plain text message
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const lock = store.getActiveLock(userId);
  if (!lock) return; // not in the middle of a reservation — ignore

  const row = store.getNumberRow(lock.tier, lock.round, lock.number);
  if (!row || row.status !== 'locked') {
    return ctx.reply('የእርስዎ ማመልከቻ ለዚህ ቁጥር አስቀድሞ በክለሳ ላይ ነው — እባክዎ የአስተዳዳሪ ማረጋገጫን ይጠብቁ።');
  }

  const txnId = ctx.message.text.trim();
  if (txnId.length < 4) {
    return ctx.reply('ይህ ትክክለኛ የግብይት ቁጥር አይመስልም። እባክዎ የቴሌብር ግብይት መታወቂያውን ይላኩ።');
  }

  store.submitTxn(lock.tier, lock.round, lock.number, txnId);
  await ctx.reply('📨 ደርሶናል! ክፍያዎ አሁን በአስተዳዳሪ በክለሳ ላይ ነው። ሲረጋገጥ ይነገርዎታል።');

  const tier = TIERS[lock.tier];
  try {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🆕 <b>አዲስ ክፍያ ገብቷል</b>\n` +
        `ደረጃ፦ ${tier.label}\n` +
        `ቁጥር፦ ${lock.number}\n` +
        `ተጠቃሚ፦ ${displayName(ctx.from)} (id ${userId})\n` +
        `የግብይት መታወቂያ፦ <code>${txnId}</code>\n\n` +
        `ከማጽደቅዎ በፊት ከቴሌብር ዝርዝርዎ ጋር እባክዎ ያረጋግጡ።`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          Markup.button.callback('✅ አጽድቅ', `appr:${lock.tier}:${lock.number}`),
          Markup.button.callback('❌ አትቀበል', `rej:${lock.tier}:${lock.number}`),
        ]),
      }
    );
  } catch (e) {
    console.error('Failed to notify admin chat — check ADMIN_CHAT_ID is set correctly:', e.message);
    await ctx.reply(
      'ማመልከቻዎ ደርሶናል፣ ነገር ግን አሁን የአስተዳዳሪ ቡድኑን ማግኘት አልቻልንም። እባክዎ ከግብይት ቁጥርዎ ጋር በቀጥታ ድጋፍን ያግኙ።'
    );
  }
});

// ---------- Admin approve/reject ----------

function isAdminChat(ctx) {
  return String(ctx.chat.id) === String(ADMIN_CHAT_ID);
}

bot.action(/^appr:([a-c]):(\d+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('Admins only.', { show_alert: true });
  const tierCode = ctx.match[1];
  const number = parseInt(ctx.match[2], 10);
  const round = store.getCurrentRound(tierCode);
  const row = store.getNumberRow(tierCode, round, number);
  if (!row || row.status !== 'pending') {
    return ctx.answerCbQuery('ለዚህ ቁጥር የሚጠባበቅ ነገር የለም።', { show_alert: true });
  }

  store.confirmNumber(tierCode, round, number, row.user_id);
  await ctx.answerCbQuery('ተረጋግጧል።');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ ጸድቋል');

  if (row.user_id) {
    try {
      await bot.telegram.sendMessage(
        row.user_id,
        `🎉 ለቁጥር ${number} (${TIERS[tierCode].label} ደረጃ) ያደረጉት ክፍያ ተረጋግጧል! በይፋ በዕጣው ውስጥ ገብተዋል። መልካም ዕድል!`
      );
    } catch (e) {}
  }

  const confirmed = store.countConfirmed(tierCode, round);
  if (confirmed >= 100) {
    await runDraw(tierCode, round);
  }
});

bot.action(/^rej:([a-c]):(\d+)$/, async (ctx) => {
  if (!isAdminChat(ctx)) return ctx.answerCbQuery('Admins only.', { show_alert: true });
  const tierCode = ctx.match[1];
  const number = parseInt(ctx.match[2], 10);
  const round = store.getCurrentRound(tierCode);
  const row = store.getNumberRow(tierCode, round, number);
  if (!row || row.status !== 'pending') {
    return ctx.answerCbQuery('ለዚህ ቁጥር የሚጠባበቅ ነገር የለም።', { show_alert: true });
  }

  store.releaseNumber(tierCode, round, number, row.user_id);
  await ctx.answerCbQuery('ተቀባይነት አላገኘም።');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ ውድቅ ሆነ — ቁጥሩ ተለቋል');

  if (row.user_id) {
    try {
      await bot.telegram.sendMessage(
        row.user_id,
        `❌ ለቁጥር ${number} (${TIERS[tierCode].label} ደረጃ) ያደረጉትን ግብይት ማረጋገጥ አልቻልንም። ቁጥሩ ተለቋል። ` +
          `ስህተት ነው ብለው ካሰቡ፣ እባክዎ ከግብይት ቁጥርዎ ጋር ድጋፍን ያግኙ።`
      );
    } catch (e) {}
  }
});

async function runDraw(tierCode, round) {
  const winnerRow = store.pickWinnerRow(tierCode, round);
  if (!winnerRow) return;
  store.recordWinner(tierCode, round, winnerRow.number, winnerRow.user_id, winnerRow.username);

  const tier = TIERS[tierCode];
  const text =
    `🎊 <b>የዕጣ ውጤት — ${tier.label} ደረጃ (ዙር ${round})</b> 🎊\n\n` +
    `አሸናፊ ቁጥር፦ ${boldNumber(winnerRow.number)}\n` +
    `አሸናፊ፦ ${winnerRow.username || 'ተጠቃሚ ' + winnerRow.user_id}\n\n` +
    `እንኳን ደስ አለዎት! አዲስ ዙር አሁን ይጀምራል — ለመቀላቀል ቁጥር ይምረጡ።`;

  await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'HTML' });
  if (ANNOUNCE_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(ANNOUNCE_CHAT_ID, text, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Could not post to ANNOUNCE_CHAT_ID:', e.message);
    }
  }
  if (winnerRow.user_id) {
    try {
      await bot.telegram.sendMessage(
        winnerRow.user_id,
        `🏆 እንኳን ደስ አለዎት! በቁጥር ${winnerRow.number} የ${tier.label} ደረጃ ዕጣውን አሸንፈዋል! አስተዳዳሪያችን በቅርቡ ያገኝዎታል።`
      );
    } catch (e) {}
  }

  store.startNewRound(tierCode);
}

// Admin-only manual command to force-start a fresh round for a tier (e.g. to reset a stalled one)
bot.command('newround', async (ctx) => {
  if (!isAdminChat(ctx)) return;
  const parts = ctx.message.text.split(' ');
  const tierCode = parts[1];
  if (!TIERS[tierCode]) {
    return ctx.reply('Usage: /newround a|b|c   (a=200 ብር, b=500 ብር, c=1000 ብር)');
  }
  const next = store.startNewRound(tierCode);
  ctx.reply(`ለ${TIERS[tierCode].label} ደረጃ ዙር ${next} ተጀምሯል። ሁሉም ቁጥሮች እንደገና ክፍት ናቸው።`);
});

// ---------- Safety net: periodic sweep for expired locks (covers server restarts) ----------
setInterval(() => {
  const cutoff = Date.now() - LOCK_MINUTES * 60 * 1000;
  const expired = store.findExpiredLocks(cutoff);
  for (const row of expired) {
    store.releaseNumber(row.tier, row.round, row.number, row.user_id);
    if (row.user_id) {
      bot.telegram
        .sendMessage(
          row.user_id,
          `⏰ ቁጥር ${row.number} (${TIERS[row.tier].label} ደረጃ) ማስያዝ ጊዜው አልቋል እና ተለቋል።`
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
