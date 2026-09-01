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
  numbers TEXT NOT NULL, -- comma-separated numbers this user currently has locked, e.g. "12,45,67,88,3"
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

// Migration: older databases have a single `number` column on active_locks
// (one locked number per user at a time). The multi-pick flow needs a user
// to hold several numbers at once for a single reservation, so this table
// now stores them as a comma-separated list instead. Rows here are only
// ever in-flight (unpaid) reservations, so it's safe to rebuild it empty.
const activeLocksCols = db.prepare("PRAGMA table_info(active_locks)").all().map((col) => col.name);
if (activeLocksCols.length && !activeLocksCols.includes('numbers')) {
  db.exec(`
    DROP TABLE active_locks;
    CREATE TABLE active_locks (
      user_id INTEGER PRIMARY KEY,
      tier TEXT NOT NULL,
      round INTEGER NOT NULL,
      numbers TEXT NOT NULL,
      locked_at INTEGER NOT NULL
    );
  `);
}

function getCurrentRound(tier) {
  const row = db.prepare('SELECT current_round FROM tier_state WHERE tier = ?').get(tier);
  if (row) return row.current_round;
  db.prepare('INSERT INTO tier_state (tier, current_round) VALUES (?, 1)').run(tier);
  return 1;
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

// Returns the user's current in-flight reservation — the batch of numbers
// they've picked but not yet paid for / been confirmed on — or null.
function getActiveLock(userId) {
  const row = db.prepare('SELECT * FROM active_locks WHERE user_id = ?').get(userId);
  if (!row) return null;
  return { ...row, numbers: row.numbers.split(',').filter(Boolean).map(Number) };
}

// Creates or replaces the user's active reservation batch.
function setActiveLock(userId, tier, round, numbers, lockedAt) {
  db.prepare(
    `INSERT INTO active_locks (user_id, tier, round, numbers, locked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, round = excluded.round,
       numbers = excluded.numbers, locked_at = excluded.locked_at`
  ).run(userId, tier, round, numbers.join(','), lockedAt);
}

function clearActiveLock(userId) {
  db.prepare('DELETE FROM active_locks WHERE user_id = ?').run(userId);
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
  db.prepare(
    `INSERT INTO numbers (tier, round, number, status, user_id, username, locked_at)
     VALUES (?, ?, ?, 'locked', ?, ?, ?)`
  ).run(tier, round, number, userId, username, now);
}

function releaseNumber(tier, round, number) {
  db.prepare('DELETE FROM numbers WHERE tier = ? AND round = ? AND number = ?').run(tier, round, number);
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

function confirmNumber(tier, round, number) {
  db.prepare(
    `UPDATE numbers SET status = 'confirmed' WHERE tier = ? AND round = ? AND number = ?`
  ).run(tier, round, number);
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
    `INSERT INTO tier_state (tier, current_round) VALUES (?, ?)
     ON CONFLICT(tier) DO UPDATE SET current_round = excluded.current_round`
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
  setActiveLock,
  clearActiveLock,
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
