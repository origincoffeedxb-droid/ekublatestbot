// Reads which tier/round to show from the Mini App's start_param, set by
// bot.js as `?startapp=<tier>_<round>` on the direct link it posts to the
// channel. Falls back to tier "a" round 1 if opened directly (e.g. testing).
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const startParam = tg?.initDataUnsafe?.start_param || 'a_1';
const [paramTier, paramRound] = startParam.split('_');
const TIER = paramTier || 'a';
const ROUND = paramRound || '1';

const statusBanner = document.getElementById('status-banner');
const countdownEl = document.getElementById('countdown');
const winnerCard = document.getElementById('winner-card');
const boardEl = document.getElementById('board');
const wheelCanvas = document.getElementById('wheel');
const ctx = wheelCanvas.getContext('2d');

const COLORS = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#0891b2', '#c026d3', '#65a30d'];

let currentRotation = 0;
let spinLoopHandle = null;
let winnerAnimationStarted = false;
let lastNumbers = [];

function drawWheel(numbers, rotationDeg = 0) {
  const size = wheelCanvas.width;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 6;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotationDeg * Math.PI) / 180);

  const n = numbers.length || 1;
  const slice = (2 * Math.PI) / n;

  numbers.forEach((num, i) => {
    const start = i * slice;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, start, start + slice);
    ctx.closePath();
    ctx.fillStyle = COLORS[i % COLORS.length];
    ctx.fill();

    ctx.save();
    ctx.rotate(start + slice / 2);
    ctx.translate(r * 0.65, 0);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num.number), 0, 0);
    ctx.restore();
  });

  ctx.restore();

  // Pointer at the top.
  ctx.beginPath();
  ctx.moveTo(cx - 12, 4);
  ctx.lineTo(cx + 12, 4);
  ctx.lineTo(cx, 30);
  ctx.closePath();
  ctx.fillStyle = '#fbbf24';
  ctx.fill();
}

function startLoopingSpin() {
  if (spinLoopHandle) return;
  function frame() {
    currentRotation = (currentRotation + 6) % 360;
    drawWheel(lastNumbers, currentRotation);
    spinLoopHandle = requestAnimationFrame(frame);
  }
  spinLoopHandle = requestAnimationFrame(frame);
}

function stopLoopingSpin() {
  if (spinLoopHandle) cancelAnimationFrame(spinLoopHandle);
  spinLoopHandle = null;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// Decelerates from the current spin into a landing on the winning slice —
// called once per draw, right when the server reports spinStatus "done".
function animateToWinner(numbers, winnerNumber, durationMs = 3000) {
  stopLoopingSpin();
  const idx = numbers.findIndex((num) => num.number === winnerNumber);
  const sliceDeg = 360 / (numbers.length || 1);
  const targetSliceCenter = idx >= 0 ? idx * sliceDeg + sliceDeg / 2 : 0;
  const extraSpins = 5 * 360;
  const finalRotation = extraSpins - targetSliceCenter;
  const start = currentRotation;
  const startTime = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - startTime) / durationMs);
    const eased = easeOutCubic(t);
    currentRotation = start + (finalRotation - start) * eased;
    drawWheel(numbers, currentRotation);
    if (t < 1) requestAnimationFrame(frame);
    else tg?.HapticFeedback?.notificationOccurred?.('success');
  }
  requestAnimationFrame(frame);
}

function renderBoard(numbers) {
  const statusIcon = { free: '🟢', pending: '🟡', locked: '🔴', confirmed: '🔴' };
  boardEl.innerHTML = numbers
    .map((n) => {
      const icon = statusIcon[n.status] || '⚪️';
      const phone = n.phoneMasked ? `<span class="phone">📱 ${n.phoneMasked}</span>` : '';
      return `<div class="board-row"><span class="num">${icon} ${n.number}</span>${phone}</div>`;
    })
    .join('');
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function poll() {
  let data;
  try {
    const res = await fetch(`/api/spin/${TIER}/${ROUND}`);
    data = await res.json();
  } catch (e) {
    statusBanner.textContent = '⚠️ ግንኙነት ላይ ችግር አለ — በድጋሚ በመሞከር ላይ...';
    return;
  }

  lastNumbers = data.numbers;
  renderBoard(data.numbers);

  if (data.spinStatus === 'counting') {
    stopLoopingSpin();
    drawWheel(data.numbers, currentRotation);
    statusBanner.textContent = '⏳ ማዞሪያው በቅርቡ ይጀምራል...';
    countdownEl.textContent = formatCountdown(data.spinTargetTime - data.serverNow);
    winnerCard.classList.add('hidden');
    winnerAnimationStarted = false;
  } else if (data.spinStatus === 'spinning') {
    statusBanner.textContent = '🎡 ማዞሪያው በመካሄድ ላይ ነው!';
    countdownEl.textContent = '🎡 🎡 🎡';
    startLoopingSpin();
    winnerCard.classList.add('hidden');
  } else if (data.spinStatus === 'done' && data.winner) {
    statusBanner.textContent = '🎊 ውጤት ወጥቷል!';
    countdownEl.textContent = '';
    if (!winnerAnimationStarted) {
      winnerAnimationStarted = true;
      animateToWinner(data.numbers, data.winner.number, 3000);
    }
    winnerCard.classList.remove('hidden');
    winnerCard.innerHTML =
      `🏆 አሸናፊ ቁጥር <b>${data.winner.number}</b><br/>` +
      `👤 ${data.winner.username || 'ተጠቃሚ'}`;
  } else {
    stopLoopingSpin();
    drawWheel(data.numbers, currentRotation);
    statusBanner.textContent = 'ደረጃው ገና እየተሞላ ነው...';
    countdownEl.textContent = '';
    winnerCard.classList.add('hidden');
  }
}

// Draw a placeholder wheel immediately so there's no blank flash, then
// start polling the live state.
drawWheel([{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }, { number: 5 }]);
poll();
setInterval(poll, 1500);
