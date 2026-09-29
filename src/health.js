// Здоровье игрока: укусы монстра и скорпионов (monster.js) отнимают HP; через 6 с без урона HP восстанавливается.
// HP = 0 — игрок падает, управление замирает, через RESPAWN_T с он встаёт на старте с полным HP (лук остаётся).
// Своё HP считает сам игрок (он и решает, укусили ли его), остальным уходит только флаг dd в pos — «лежит, не цель».
import { player, START_DIR, clock } from './state.js';
import { P } from './params.js';
import { setPlayerOverride } from './player.js';
import { forceDismount, ride } from './ride.js';
import { addPosFields } from './net.js';
import { audio } from './audio.js';

export const HP_MAX = 100;
const REGEN_DELAY = 6, REGEN = 8;   // с без урона до начала лечения; HP/с
const RESPAWN_T = 4;
export const health = { hp: HP_MAX, dead: false, deadT: 0, lastHit: -1e9 };

const hpEl = document.getElementById('hp'), hpFill = document.getElementById('hpFill'), hpText = document.getElementById('hpText');
const hurtEl = document.getElementById('hurt'), deadEl = document.getElementById('dead'), deadText = document.getElementById('deadText');
let flash = 0;

const frozen = { update() {}, mouse() {}, jump() {} };   // пока лежим — ни ходьбы, ни обзора
addPosFields(() => health.dead ? { dd: 1 } : {});

export function damagePlayer(n, by = '') {
  if (health.dead || player.inside || n <= 0) return;
  health.hp = Math.max(0, health.hp - n);
  health.lastHit = clock.elapsedTime;
  flash = Math.min(1, flash + 0.35 + n / 40);
  if (audio) sfxHurt();
  if (health.hp > 0) return;
  health.dead = player.dead = true;
  health.deadT = clock.elapsedTime;
  health.by = by;
  if (ride.camel >= 0) forceDismount();
  player.jumpH = 0; player.jumpV = 0;
  setPlayerOverride(frozen);
}

function respawn() {
  health.dead = player.dead = false;
  health.hp = HP_MAX;
  player.pos.copy(START_DIR).multiplyScalar(P.R - P.EYE);
  player.forward.set(0, 0, -1);
  player.pitch = 0; player.jumpH = 0; player.jumpV = 0;
  setPlayerOverride(null);
}

export function updateHealth(dt) {
  const t = clock.elapsedTime;
  if (health.dead) {
    const left = RESPAWN_T - (t - health.deadT);
    deadText.textContent = `${health.by || 'Монстр'} загрыз вас… возрождение через ${Math.max(1, Math.ceil(left))} с`;
    if (left <= 0) respawn();
  } else if (health.hp < HP_MAX && t - health.lastHit > REGEN_DELAY) {
    health.hp = Math.min(HP_MAX, health.hp + REGEN * dt);
  }
  deadEl.style.display = health.dead ? 'flex' : 'none';   // в CSS display:none — '' вернул бы его
  flash = Math.max(0, flash - dt * 1.6);
  hurtEl.style.opacity = health.dead ? 0.75 : flash.toFixed(3);
  hpEl.style.display = player.inside ? 'none' : 'block';
  hpFill.style.width = `${100 * health.hp / HP_MAX}%`;
  hpText.textContent = `Здоровье ${Math.ceil(health.hp)}`;
}

// глухой удар + короткий выдох — свой звук, без позиции
function sfxHurt() {
  const { ctx, selfBus, noise } = audio, t0 = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(140, t0); o.frequency.exponentialRampToValueAtTime(55, t0 + 0.18);
  g.gain.setValueAtTime(0.35, t0); g.gain.exponentialRampToValueAtTime(0.0003, t0 + 0.22);
  o.connect(g).connect(selfBus); o.start(t0); o.stop(t0 + 0.25);
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), ng = ctx.createGain();
  src.buffer = noise; f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.8;
  ng.gain.setValueAtTime(0, t0); ng.gain.linearRampToValueAtTime(0.12, t0 + 0.02); ng.gain.exponentialRampToValueAtTime(0.0003, t0 + 0.2);
  src.connect(f).connect(ng).connect(selfBus); src.start(t0); src.stop(t0 + 0.22);
}