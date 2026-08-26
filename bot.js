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
  a: { amount: 200, label: '200 ETB' },
  b: { amount: 500, label: '500 ETB' },
  c: { amount: 1000, label: '1000 ETB' },
};
const PAGE_SIZE = 50; // numbers per page (5 rows x 10)

function displayName(from) {
  return from.username ? '@' + from.username : (from.first_name || 'user');
}

// ---------- Keyboards ----------

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    Object.entries(TIERS).map(([code, t]) =>
      Markup.button.callback(t.label, `tier:${code}`)
    ),
  ]);
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
    if (!status) icon = `${n}`; // open
    else if (status === 'locked') icon = `🔒${n}`;
    else if (status === 'pending') icon = `🟡${n}`;
    else icon = `🔴${n}`; // confirmed / taken

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
  if (page > 0) nav.push(Markup.button.callback('⬅️ Prev', `pg:${tierCode}:${page - 1}`));
  if (end < 100) nav.push(Markup.button.callback('Next ➡️', `pg:${tierCode}:${page + 1}`));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback('⬅️ Back to tiers', 'menu')]);

  return Markup.inlineKeyboard(buttons);
}

// ---------- Commands ----------

// Temporary helper: reveals the current chat's ID so you can find your ADMIN_CHAT_ID.
// Safe to leave in permanently — it only ever shows the ID of the chat it's used in.
bot.command('whereami', (ctx) => {
  ctx.reply(`Chat ID: ${ctx.chat.id}\nChat type: ${ctx.chat.type}\nChat title: ${ctx.chat.title || '(none — private chat)'}`);
});

bot.start((ctx) => {
  ctx.reply(
    `Welcome to ${TELEBIRR_NAME}'s daily draw! 🎉\n\n` +
      `Pick a tier, then pick a free number from 1–100. You'll get 5 minutes to send the ` +
      `deposit via Telebirr and submit your transaction number. Once all 100 numbers in a ` +
      `tier are paid and confirmed, one winner is drawn automatically.\n\n` +
      `Legend: plain number = open, 🔒 = reserved by someone, 🟡 = payment under review, 🔴 = confirmed/taken.`,
    mainMenuKeyboard()
  );
});

bot.command('numbers', (ctx) => {
  ctx.reply('Choose a tier to view its numbers:', mainMenuKeyboard());
});

bot.command('mynumber', (ctx) => {
  const lock = store.getActiveLock(ctx.from.id);
  if (!lock) return ctx.reply("You don't have an active reservation right now.");
  const row = store.getNumberRow(lock.tier, lock.round, lock.number);
  ctx.reply(
    `Your reservation: number ${lock.number} in the ${TIERS[lock.tier].label} tier.\n` +
      `Status: ${row ? row.status : 'unknown'}.`
  );
});

bot.action('noop', (ctx) => ctx.answerCbQuery('That number is already taken.'));

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Choose a tier:', mainMenuKeyboard());
});

bot.action(/^tier:([a-c])$/, async (ctx) => {
  const tierCode = ctx.match[1];
  await ctx.answerCbQuery();
  const round = store.getCurrentRound(tierCode);
  await ctx.editMessageText(
    `${TIERS[tierCode].label} tier — pick any open number (1–100):`,
    numbersGridKeyboard(tierCode, round, 0)
  );
});

bot.action(/^pg:([a-c]):(\d+)$/, async (ctx) => {
  const tierCode = ctx.match[1];
  const page = parseInt(ctx.match[2], 10);
  await ctx.answerCbQuery();
  const round = store.getCurrentRound(tierCode);
  await ctx.editMessageText(
    `${TIERS[tierCode].label} tier — pick any open number (1–100):`,
    numbersGridKeyboard(tierCode, round, page)
  );
});

bot.action(/^pick:([a-c]):(\d+)$/, async (ctx) => {
  const tierCode = ctx.match[1];
  const number = parseInt(ctx.match[2], 10);
  const tier = TIERS[tierCode];
  const userId = ctx.from.id;

  const existingLock = store.getActiveLock(userId);
  if (existingLock) {
    await ctx.answerCbQuery('You already have a reserved number. Finish that one first.', { show_alert: true });
    return;
  }

  const round = store.getCurrentRound(tierCode);
  const current = store.getNumberRow(tierCode, round, number);
  if (current) {
    await ctx.answerCbQuery('Sorry, someone just took that number.', { show_alert: true });
    return;
  }

  store.lockNumber(tierCode, round, number, userId, displayName(ctx.from));
  await ctx.answerCbQuery('Number reserved!');

  await ctx.reply(
    `✅ Number ${number} in the ${tier.label} tier is reserved for you for ${LOCK_MINUTES} minutes.\n\n` +
      `📲 Send ${tier.amount} ETB via Telebirr to:\n` +
      `   ${TELEBIRR_NUMBER} (${TELEBIRR_NAME})\n\n` +
      `Then reply here with your Telebirr transaction number (e.g. ABC123XYZ) BEFORE the timer runs out. ` +
      `If we don't receive it in time, the number is released back to everyone.`
  );

  setTimeout(async () => {
    const row = store.getNumberRow(tierCode, round, number);
    if (row && row.status === 'locked') {
      store.releaseNumber(tierCode, round, number, userId);
      try {
        await bot.telegram.sendMessage(
          userId,
          `⏰ Time's up — number ${number} (${tier.label} tier) wasn't confirmed in time and has been released. You can pick another number anytime.`
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
    return ctx.reply('Your submission for this number is already under review — please wait for admin confirmation.');
  }

  const txnId = ctx.message.text.trim();
  if (txnId.length < 4) {
    return ctx.reply('That doesn\'t look like a valid transaction number. Please send the Telebirr transaction ID.');
  }

  store.submitTxn(lock.tier, lock.round, lock.number, txnId);
  await ctx.reply('📨 Received! Your payment is now under review by an admin. You\'ll be notified once confirmed.');

  const tier = TIERS[lock.tier];
  try {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🆕 Deposit submitted\n` +
        `Tier: ${tier.label}\n` +
        `Number: ${lock.number}\n` +
        `User: ${displayName(ctx.from)} (id ${userId})\n` +
        `Transaction ID: ${txnId}\n\n` +
        `Please verify this against your Telebirr statement before approving.`,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Approve', `appr:${lock.tier}:${lock.number}`),
        Markup.button.callback('❌ Reject', `rej:${lock.tier}:${lock.number}`),
      ])
    );
  } catch (e) {
    console.error('Failed to notify admin chat — check ADMIN_CHAT_ID is set correctly:', e.message);
    await ctx.reply(
      "We received your submission, but couldn't reach the admin team right now. Please contact support directly with your transaction ID."
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
    return ctx.answerCbQuery('Nothing pending for this number.', { show_alert: true });
  }

  store.confirmNumber(tierCode, round, number, row.user_id);
  await ctx.answerCbQuery('Confirmed.');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ APPROVED');

  if (row.user_id) {
    try {
      await bot.telegram.sendMessage(
        row.user_id,
        `🎉 Your payment for number ${number} (${TIERS[tierCode].label} tier) is confirmed! You're officially in the draw. Good luck!`
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
    return ctx.answerCbQuery('Nothing pending for this number.', { show_alert: true });
  }

  store.releaseNumber(tierCode, round, number, row.user_id);
  await ctx.answerCbQuery('Rejected.');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ REJECTED — number released');

  if (row.user_id) {
    try {
      await bot.telegram.sendMessage(
        row.user_id,
        `❌ We couldn't verify your transaction for number ${number} (${TIERS[tierCode].label} tier). The number has been released. ` +
          `If you believe this is an error, please contact support with your transaction ID.`
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
    `🎊 DRAW RESULT — ${tier.label} tier (round ${round}) 🎊\n\n` +
    `Winning number: ${winnerRow.number}\n` +
    `Winner: ${winnerRow.username || 'user ' + winnerRow.user_id}\n\n` +
    `Congratulations! A new round starts now — pick a number to join.`;

  await bot.telegram.sendMessage(ADMIN_CHAT_ID, text);
  if (ANNOUNCE_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(ANNOUNCE_CHAT_ID, text);
    } catch (e) {
      console.error('Could not post to ANNOUNCE_CHAT_ID:', e.message);
    }
  }
  if (winnerRow.user_id) {
    try {
      await bot.telegram.sendMessage(
        winnerRow.user_id,
        `🏆 Congratulations! You won the ${tier.label} tier draw with number ${winnerRow.number}! Our admin will contact you shortly.`
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
    return ctx.reply('Usage: /newround a|b|c   (a=200 ETB, b=500 ETB, c=1000 ETB)');
  }
  const next = store.startNewRound(tierCode);
  ctx.reply(`Started round ${next} for ${TIERS[tierCode].label} tier. All numbers are open again.`);
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
          `⏰ Number ${row.number} (${TIERS[row.tier].label} tier) reservation expired and was released.`
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
