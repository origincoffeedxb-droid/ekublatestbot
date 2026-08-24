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

function getActiveLock(userId) {
  return db.prepare('SELECT * FROM active_locks WHERE user_id = ?').get(userId);
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
  lockNumber,
  releaseNumber,
  submitTxn,
  confirmNumber,
  countConfirmed,
  pickWinnerRow,
  recordWinner,
  startNewRound,
  findExpiredLocks,
};
