'use strict';
// ============================================================
//  wheel-render.js — draws a real, colorful prize wheel (like
//  the classic "Spin the Wheel" apps) instead of a text row,
//  and renders the whole draw as ONE animated GIF that always
//  coasts to a stop on the already-picked winner.
//
//  Requires (npm install):
//    @napi-rs/canvas   — Canvas API, ships prebuilt binaries
//                         (no build tools needed on the server)
//    gifenc             — small, pure-JS GIF encoder/quantizer
// ============================================================

const { createCanvas } = require('@napi-rs/canvas');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const SIZE = 640;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 30;
const HUB_RADIUS = 70;

// Cycled across slices — a classic prize-wheel palette.
const SLICE_COLORS = [
  '#29B6F6', // cyan
  '#EC407A', // pink
  '#AB47BC', // purple
  '#FF9800', // orange
  '#E53935', // red
  '#8E24AA', // deep purple
  '#43A047', // green
  '#FDD835', // yellow
];

function drawWheel(ctx, numbers, rotation) {
  const n = numbers.length;
  const segAngle = (2 * Math.PI) / n;

  ctx.clearRect(0, 0, SIZE, SIZE);

  // Outer rim
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, RADIUS + 14, 0, Math.PI * 2);
  ctx.fillStyle = '#14213d';
  ctx.fill();

  // Rim lights (fixed — do not rotate with the wheel)
  const lightCount = 20;
  for (let i = 0; i < lightCount; i++) {
    const a = (i / lightCount) * Math.PI * 2;
    const lx = CENTER + Math.cos(a) * (RADIUS + 14);
    const ly = CENTER + Math.sin(a) * (RADIUS + 14);
    ctx.beginPath();
    ctx.arc(lx, ly, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#FFE082';
    ctx.fill();
  }

  ctx.save();
  ctx.translate(CENTER, CENTER);
  ctx.rotate(rotation);

  for (let i = 0; i < n; i++) {
    const start = i * segAngle;
    const end = start + segAngle;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, RADIUS, start, end);
    ctx.closePath();
    ctx.fillStyle = SLICE_COLORS[i % SLICE_COLORS.length];
    ctx.fill();
    ctx.strokeStyle = '#0d1b33';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Number label, upright-ish along the slice's mid-angle
    ctx.save();
    ctx.rotate(start + segAngle / 2);
    ctx.translate(RADIUS * 0.62, 0);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(numbers[i]), 0, 0);
    ctx.restore();
  }
  ctx.restore();

  // Hub
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, HUB_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = '#14213d';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SPIN', CENTER, CENTER);

  // Pointer — fixed at the top, never rotates
  ctx.beginPath();
  ctx.moveTo(CENTER - 28, 6);
  ctx.lineTo(CENTER + 28, 6);
  ctx.lineTo(CENTER, 60);
  ctx.closePath();
  ctx.fillStyle = '#FFB300';
  ctx.fill();
  ctx.strokeStyle = '#0d1b33';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Still PNG of the wheel at rest — used for the "loaded, waiting for
 * admin approval" idle post in the channel.
 * @param {number[]} numbers
 * @returns {Buffer} PNG bytes
 */
function renderIdleWheelPng(numbers) {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  drawWheel(ctx, numbers, 0);
  return canvas.toBuffer('image/png');
}

/**
 * The full draw as ONE animated GIF: several fast laps that smoothly
 * decelerate and land exactly on winnerNumber under the fixed pointer —
 * the whole "process of the draw" baked into a single clip, never faked
 * after the fact.
 * @param {number[]} numbers
 * @param {number} winnerNumber
 * @param {object} [opts]
 * @param {number} [opts.laps=6] full rotations before landing
 * @param {number} [opts.frameCount=70] total frames
 * @param {number} [opts.frameDelayMs=45] ms shown per frame (except the last)
 * @param {number} [opts.finalHoldMs=1800] ms the final, landed frame holds
 * @returns {{ buffer: Buffer, durationMs: number }}
 */
function renderSpinGif(numbers, winnerNumber, opts = {}) {
  const n = numbers.length;
  const segAngle = (2 * Math.PI) / n;
  const winnerIdx = numbers.indexOf(winnerNumber);
  const winnerCenterAngle = winnerIdx * segAngle + segAngle / 2;

  // Pointer sits at angle -PI/2 (top). Solve for the rotation that lands
  // the winner's slice center exactly there, plus a few extra full laps
  // purely for visual effect.
  const laps = opts.laps ?? 6;
  const targetMod = (((-Math.PI / 2 - winnerCenterAngle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const totalRotation = laps * Math.PI * 2 + targetMod;

  const frameCount = opts.frameCount ?? 70;
  const frameDelayMs = opts.frameDelayMs ?? 45;
  const finalHoldMs = opts.finalHoldMs ?? 1800;

  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const gif = GIFEncoder();

  for (let i = 0; i < frameCount; i++) {
    const t = i / (frameCount - 1);
    const rotation = totalRotation * easeOutCubic(t);
    drawWheel(ctx, numbers, rotation);

    const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
    const palette = quantize(data, 128);
    const index = applyPalette(data, palette);
    const delay = i === frameCount - 1 ? finalHoldMs : frameDelayMs;
    gif.writeFrame(index, SIZE, SIZE, { palette, delay });
  }
  gif.finish();

  const buffer = Buffer.from(gif.bytes());
  const durationMs = (frameCount - 1) * frameDelayMs + finalHoldMs;
  return { buffer, durationMs };
}

module.exports = { renderIdleWheelPng, renderSpinGif, SIZE };
