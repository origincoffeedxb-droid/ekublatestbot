const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tier_state (
  tier TEXT PRIMARY KEY,
  current_round INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS numbers (
  tier TEXT NOT NULL,
  round INTEGER NOT NULL,
  number INTEGER NOT NULL,
  status TEXT NOT NULL, -- locked | pending | confirmed
  user_id INTEGER,
  username TEXT,
  locked_at INTEGER,
  txn_id TEXT,
  phone TEXT, -- phone number the payer sent Telebirr from
  PRIMARY KEY (tier, round, number)
);

CREATE TABLE IF NOT EXISTS active_locks (
  user_id INTEGER PRIMARY KEY,
  tier TEXT NOT NULL,
  round INTEGER NOT NULL,
  number INTEGER NOT NULL,
  locked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS winners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tier TEXT NOT NULL,
  round INTEGER NOT NULL,
  number INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT,
  drawn_at INTEGER NOT NULL
);
`);

// Migration: databases created before the phone-capture feature won't have
// this column yet — CREATE TABLE IF NOT EXISTS above is a no-op on tables
// that already exist, so add it here if it's missing.
const hasPhoneColumn = db.prepare("PRAGMA table_info(numbers)").all().some((col) => col.name === 'phone');
if (!hasPhoneColumn) {
  db.exec('ALTER TABLE numbers ADD COLUMN phone TEXT');
}

// Migration: databases from the short-lived multi-pick experiment have a
// `numbers` (plural, CSV) column on active_locks instead of a single
// `number` column. Rebuild the table for the single-pick design — any rows
// here are just in-flight (unpaid) reservations, so it's safe to reset.
const activeLocksCols = db.prepare("PRAGMA table_info(active_locks)").all().map((col) => col.name);
if (activeLocksCols.length && !activeLocksCols.includes('number')) {
  db.exec(`
    DROP TABLE active_locks;
    CREATE TABLE active_locks (
      user_id INTEGER PRIMARY KEY,
      tier TEXT NOT NULL,
      round INTEGER NOT NULL,
      number INTEGER NOT NULL,
      locked_at INTEGER NOT NULL
    );
  `);
}

// Migration: databases created before the scheduled-draw feature won't have
// these columns yet — add them if missing (same pattern as the phone-column
// migration above). `status` tracks where a round is in the full -> scheduled
// -> drawing -> open lifecycle; `draw_time` holds the admin-announced time.
const tierStateCols = db.prepare("PRAGMA table_info(tier_state)").all().map((col) => col.name);
if (!tierStateCols.includes('status')) {
  db.exec("ALTER TABLE tier_state ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
}
if (!tierStateCols.includes('draw_time')) {
  db.exec('ALTER TABLE tier_state ADD COLUMN draw_time TEXT');
}

function getCurrentRound(tier) {
  const row = db.prepare('SELECT current_round FROM tier_state WHERE tier = ?').get(tier);
  if (row) return row.current_round;
  db.prepare('INSERT INTO tier_state (tier, current_round) VALUES (?, 1)').run(tier);
  return 1;
}

// ---------- Round lifecycle: open -> full -> scheduled -> drawing -> open ----------

function getTierStatus(tier) {
  getCurrentRound(tier); // ensures a tier_state row exists
  const row = db.prepare('SELECT status FROM tier_state WHERE tier = ?').get(tier);
  return row ? row.status : 'open';
}

function setTierStatus(tier, status) {
  getCurrentRound(tier);
  db.prepare('UPDATE tier_state SET status = ? WHERE tier = ?').run(status, tier);
}

function setDrawTime(tier, drawTime) {
  getCurrentRound(tier);
  db.prepare('UPDATE tier_state SET draw_time = ? WHERE tier = ?').run(drawTime, tier);
}

function getDrawTime(tier) {
  const row = db.prepare('SELECT draw_time FROM tier_state WHERE tier = ?').get(tier);
  return row ? row.draw_time : null;
}

function getNumberRow(tier, round, number) {
  return db.prepare(
    'SELECT * FROM numbers WHERE tier = ? AND round = ? AND number = ?'
  ).get(tier, round, number);
}

function getTierNumbers(tier, round) {
  return db.prepare(
    'SELECT * FROM numbers WHERE tier = ? AND round = ?'
  ).all(tier, round);
}

function getActiveLock(userId) {
  return db.prepare('SELECT * FROM active_locks WHERE user_id = ?').get(userId);
}

// Looks up every reserved number (any tier/round, any status) a given
// Telegram user has ever placed — used to show "my numbers" without
// needing to ask for a phone number.
function getNumbersByUser(userId) {
  return db.prepare(
    `SELECT * FROM numbers WHERE user_id = ? ORDER BY tier, round, number`
  ).all(userId);
}

// Looks up every reserved number (any tier/round, any status) whose payer
// phone matches exactly. Phone should already be normalized the same way
// it was stored (see normalizePhone() in bot.js) before calling this.
function getNumbersByPhone(phone) {
  return db.prepare(
    `SELECT * FROM numbers WHERE phone = ? ORDER BY tier, round, number`
  ).all(phone);
}

function lockNumber(tier, round, number, userId, username) {
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO numbers (tier, round, number, status, user_id, username, locked_at)
       VALUES (?, ?, ?, 'locked', ?, ?, ?)`
    ).run(tier, round, number, userId, username, now);
    db.prepare(
      `INSERT INTO active_locks (user_id, tier, round, number, locked_at) VALUES (?, ?, ?, ?, ?)`
    ).run(userId, tier, round, number, now);
  });
  tx();
}

function releaseNumber(tier, round, number, userId) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM numbers WHERE tier = ? AND round = ? AND number = ?').run(tier, round, number);
    if (userId) db.prepare('DELETE FROM active_locks WHERE user_id = ?').run(userId);
  });
  tx();
}

function setPayerPhone(tier, round, number, phone) {
  db.prepare(
    `UPDATE numbers SET phone = ? WHERE tier = ? AND round = ? AND number = ?`
  ).run(phone, tier, round, number);
}

function submitTxn(tier, round, number, txnId) {
  db.prepare(
    `UPDATE numbers SET status = 'pending', txn_id = ? WHERE tier = ? AND round = ? AND number = ?`
  ).run(txnId, tier, round, number);
}

function confirmNumber(tier, round, number, userId) {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE numbers SET status = 'confirmed' WHERE tier = ? AND round = ? AND number = ?`
    ).run(tier, round, number);
    if (userId) db.prepare('DELETE FROM active_locks WHERE user_id = ?').run(userId);
  });
  tx();
}

function countConfirmed(tier, round) {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM numbers WHERE tier = ? AND round = ? AND status = 'confirmed'`
  ).get(tier, round);
  return row.c;
}

function pickWinnerRow(tier, round) {
  const rows = db.prepare(
    `SELECT * FROM numbers WHERE tier = ? AND round = ? AND status = 'confirmed'`
  ).all(tier, round);
  if (rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

function recordWinner(tier, round, number, userId, username) {
  db.prepare(
    `INSERT INTO winners (tier, round, number, user_id, username, drawn_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(tier, round, number, userId, username, Date.now());
}

function startNewRound(tier) {
  const row = db.prepare('SELECT current_round FROM tier_state WHERE tier = ?').get(tier);
  const next = (row ? row.current_round : 1) + 1;
  db.prepare(
    `INSERT INTO tier_state (tier, current_round, status, draw_time) VALUES (?, ?, 'open', NULL)
     ON CONFLICT(tier) DO UPDATE SET current_round = excluded.current_round, status = 'open', draw_time = NULL`
  ).run(tier, next);
  return next;
}

function findExpiredLocks(cutoffMs) {
  return db.prepare(
    `SELECT * FROM numbers WHERE status = 'locked' AND locked_at < ?`
  ).all(cutoffMs);
}

module.exports = {
  db,
  getCurrentRound,
  getNumberRow,
  getTierNumbers,
  getActiveLock,
  getTierStatus,
  setTierStatus,
  setDrawTime,
  getDrawTime,
  getNumbersByUser,
  getNumbersByPhone,
  lockNumber,
  releaseNumber,
  setPayerPhone,
  submitTxn,
  confirmNumber,
  countConfirmed,
  pickWinnerRow,
  recordWinner,
  startNewRound,
  findExpiredLocks,
};
