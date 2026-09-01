// Mini App server: serves the static countdown/spin UI (public/) and a
// small read-only JSON API backed by the SAME SQLite database bot.js
// writes to. This process never mutates draw state itself — bot.js is the
// single source of truth for who won; this just lets every viewer poll the
// same state so their wheels animate in sync.
require('dotenv').config();
const express = require('express');
const path = require('path');
const store = require('../db');

const PORT = process.env.WEBAPP_PORT || process.env.PORT || 3000;
const TOTAL_NUMBERS = 5; // keep in sync with TOTAL_NUMBERS in bot.js
const SPIN_ANIMATION_MS = 6000; // keep in sync with SPIN_ANIMATION_MS in bot.js and app.js

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

function maskPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return digits;
  const first3 = digits.slice(0, 3);
  const last3 = digits.slice(-3);
  return `${first3}${'*'.repeat(Math.max(digits.length - 6, 3))}${last3}`;
}

// GET /api/spin/:tier/:round -> board state + countdown/spin status.
// Polled every ~1.5s by the frontend; cheap SQLite reads, no auth needed
// since it only ever exposes masked phone numbers (same as the channel board).
app.get('/api/spin/:tier/:round', (req, res) => {
  const { tier } = req.params;
  const round = parseInt(req.params.round, 10);
  if (!tier || !Number.isFinite(round)) {
    return res.status(400).json({ error: 'invalid tier/round' });
  }

  const spin = store.getSpinState(tier);
  const rows = store.getTierNumbers(tier, round);
  const byNumber = {};
  for (const r of rows) byNumber[r.number] = r;

  const numbers = [];
  for (let n = 1; n <= TOTAL_NUMBERS; n++) {
    const r = byNumber[n];
    numbers.push({
      number: n,
      status: r ? r.status : 'free',
      phoneMasked: r ? maskPhone(r.phone) : null,
    });
  }

  let winner = null;
  if (spin.winner_number) {
    const w = byNumber[spin.winner_number];
    winner = w
      ? { number: w.number, username: w.username, phoneMasked: maskPhone(w.phone) }
      : { number: spin.winner_number };
  }

  res.json({
    tier,
    round,
    totalNumbers: TOTAL_NUMBERS,
    numbers,
    spinStatus: spin.spin_status, // idle | counting | spinning | done
    spinTargetTime: spin.spin_target_time,
    spinAnimationMs: SPIN_ANIMATION_MS,
    winner,
    serverNow: Date.now(),
  });
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`Mini App server listening on port ${PORT}`);
});
