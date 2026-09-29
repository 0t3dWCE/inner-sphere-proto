// Шаги: негромкий звук на каждый шаг, пока идём по земле или по полу дома. Каденс — от пройденного пути:
// шаг длиннее, когда идём быстрее (снаружи 12 м/с — ~3,5 шага/с, в доме столько же при 5,4 м/с).
// Покрытие: трава, лес (с хрустом), песок, вода, мостовая города, дерево (балкон, пол в доме).
// Всё синтезируется в audio.selfBus (непозиционно — это звук самого игрока); громкость — P.STEPS × P.VOLUME.
import * as THREE from 'three';
import { player } from './state.js';
import { P } from './params.js';
import { BIOME, TOWN_H } from './world.js';
import { platform, nearTown, townXZ } from './player.js';
import { house } from './house.js';
import { audio } from './audio.js';

const STRIDE_K = 0.28, STRIDE_MIN = 0.5, STRIDE_MAX = 3.5;   // длина шага = скорость × STRIDE_K, м
const TELEPORT = 4;                                          // сдвиг за кадр больше — телепорт/вход в дом, не шаг
const last = new THREE.Vector3(), cur = new THREE.Vector3();
let lastInside = null, acc = 0, speed = 0, wasGrounded = true, foot = 0;

function surface() {
  if (player.inside) return 'wood';
  if (platform) return 'wood';
  if (player.biome === BIOME.WATER) return 'water';
  if (nearTown && Math.abs(townXZ.x) < TOWN_H && Math.abs(townXZ.y) < TOWN_H) return 'stone';
  if (player.biome === BIOME.SAND) return 'sand';
  if (player.biome === BIOME.FOREST) return 'forest';
  return 'grass';
}

export function updateSteps(dt) {
  const a = house.active;
  let grounded;
  if (a) {
    cur.set(a.pos.x, 0, a.pos.z);                       // по лестнице — тоже шаги, считаем только горизонталь
    grounded = a.grounded;
  } else {
    cur.copy(player.pos);
    grounded = (player.jumpH === 0 || !!platform) && player.rideH === 0;   // верхом шагает верблюд, не мы
  }
  const inside = a ? a.h : null;
  const d = inside === lastInside ? cur.distanceTo(last) : Infinity;
  last.copy(cur); lastInside = inside;
  if (d > TELEPORT) { acc = 0; wasGrounded = grounded; return; }

  speed += (d / Math.max(dt, 1e-3) - speed) * Math.min(1, dt * 10);
  const landed = grounded && !wasGrounded;
  wasGrounded = grounded;
  if (!audio || P.STEPS <= 0 || P.VOLUME <= 0) return;
  if (landed) { playStep(surface(), 1.4); acc = 0; return; }
  if (!grounded) return;
  if (d < 1e-4) { acc = Math.max(acc, 0.6); return; }  // стоим: первый шаг после остановки — почти сразу
  const stride = THREE.MathUtils.clamp(speed * STRIDE_K, STRIDE_MIN, STRIDE_MAX);
  acc += d / stride;
  if (acc >= 1) { acc -= Math.floor(acc); playStep(surface(), 1); }
}

// ---------- синтез ----------
// шумовой удар: буфер белого шума (0,25 с) со случайного места через фильтр и короткую огибающую
function burst(t, type, freq, q, gain, attack, decay, out) {
  const { ctx, noise } = audio;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0003, t + attack + decay);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.1); src.stop(t + attack + decay + 0.02);
  return f;
}
// глухой «тук» пяткой: быстро падающий по высоте тон
function thump(t, type, f0, f1, gain, decay, out) {
  const { ctx } = audio;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + decay);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0003, t + decay);
  o.connect(g).connect(out);
  o.start(t); o.stop(t + decay + 0.02);
}

function playStep(kind, loud) {
  const { ctx, selfBus } = audio, t = ctx.currentTime;
  // шаги чуть попеременно слева/справа и с разбросом — иначе звучит как метроном
  foot ^= 1;
  const pan = ctx.createStereoPanner();
  pan.pan.value = (foot ? 0.12 : -0.12);
  const out = ctx.createGain();
  out.gain.value = 1.5 * P.STEPS * loud * (0.8 + Math.random() * 0.4);   // при STEPS=0.5 — примерно как шаги верблюда рядом
  out.connect(pan).connect(selfBus);
  const r = 0.85 + Math.random() * 0.3;
  switch (kind) {
    case 'grass':
      burst(t, 'bandpass', 1100 * r, 0.8, 0.05, 0.012, 0.09, out);
      thump(t, 'sine', 110 * r, 60, 0.05, 0.08, out);
      break;
    case 'forest':   // хвоя и сухие веточки: мягкий шорох + короткий хруст
      burst(t, 'bandpass', 900 * r, 0.7, 0.045, 0.012, 0.1, out);
      burst(t + 0.02, 'bandpass', 3200 * r, 3, 0.035, 0.003, 0.03, out);
      thump(t, 'sine', 100 * r, 55, 0.05, 0.08, out);
      break;
    case 'sand':     // рассыпчатый шелест, мягкая пятка
      burst(t, 'highpass', 2400 * r, 0.5, 0.03, 0.02, 0.14, out);
      thump(t, 'sine', 90 * r, 50, 0.04, 0.07, out);
      break;
    case 'water': {  // всплеск: полоса шума, уходящая вверх
      const f = burst(t, 'bandpass', 500 * r, 1.2, 0.07, 0.015, 0.22, out);
      f.frequency.exponentialRampToValueAtTime(1600 * r, t + 0.18);
      break;
    }
    case 'stone':    // мостовая: сухой щелчок каблука
      burst(t, 'bandpass', 2600 * r, 2.2, 0.04, 0.002, 0.035, out);
      thump(t, 'triangle', 160 * r, 90, 0.05, 0.05, out);
      break;
    case 'wood':     // дощатый пол: глухой деревянный стук
      thump(t, 'triangle', 190 * r, 120, 0.07, 0.09, out);
      burst(t, 'lowpass', 500 * r, 0.7, 0.04, 0.004, 0.06, out);
      break;
  }
}
