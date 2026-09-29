// Лук и стрелы.
// Лук лежит в лесу (место — из seed'а мира, свой RNG, rand() мира не тратится); подошёл вплотную — взял, он у тебя в
// левой руке, находка запоминается в localStorage комнаты. Клик без шара-сообщения в руке — выстрел: стрела летит
// туда, куда смотрит камера, со скоростью P.ARROW_SPEED, притягивается к стенке (P.GRAVITY) — дуга; воткнулась в землю —
// остаётся торчать. По сети уходит 'arrow' {p, v, color}: у остальных та же стрела летит и втыкается сама.
import * as THREE from 'three';
import { ROOM, WORLD_SEED, hash32, mulberry32, PLAYER_COLOR, START_DIR, player, clock } from './state.js';
import { P } from './params.js';
import { renderer, scene, camera } from './scene.js';
import { fogify } from './fow.js';
import { surfaceR } from './terrain.js';
import { BIOME, biomeAt } from './world.js';
import { trees } from './forest.js';
import { holding } from './messages.js';
import { audio, sfxTwang } from './audio.js';
import { net, netBroadcast, onNet } from './net.js';

export const bow = { have: false, hint: '', dir: null };   // dir — где лежит лук (единичный вектор)
const PICK_R = 1.8;          // м до лука — «вплотную»
const ARROW_LEN = 0.9;
const MAX_ARROWS = 300;      // торчащих стрел на всех; старые исчезают
const COOLDOWN = 0.35;       // с между выстрелами
const BOW_KEY = 'inner-sphere-bow-' + (ROOM || 'solo');

const woodMat = fogify(new THREE.MeshStandardMaterial({ color: 0x9a6a3a, emissive: 0x3a2210, emissiveIntensity: .4, roughness: .85 }));
const stringMat = fogify(new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: .6 }));
const tipMat = fogify(new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: .35, metalness: .6 }));
const shaftMat = fogify(new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: .8 }));
const fletchMats = new Map();
const fletchMatFor = color => {
  const key = color.getHex();
  if (!fletchMats.has(key)) fletchMats.set(key, fogify(new THREE.MeshStandardMaterial({ color, roughness: .8, side: THREE.DoubleSide })));
  return fletchMats.get(key);
};

// лук: дуга (тор на 200°) в плоскости XY, тетива — хорда; центр дуги в начале координат, «спина» смотрит в −X
function makeBow(scale = 1) {
  const g = new THREE.Group();
  const arc = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.028, 8, 28, Math.PI * 1.1), woodMat);
  arc.rotation.z = -Math.PI * 0.55;    // дуга симметрична относительно оси X, выпуклостью в +X
  const a0 = -Math.PI * 0.55, a1 = Math.PI * 0.55;
  const p0 = new THREE.Vector3(Math.cos(a0) * 0.62, Math.sin(a0) * 0.62, 0), p1 = new THREE.Vector3(Math.cos(a1) * 0.62, Math.sin(a1) * 0.62, 0);
  const str = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, p0.distanceTo(p1), 5), stringMat);
  str.position.copy(p0).add(p1).multiplyScalar(0.5);
  str.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 8), stringMat);
  grip.position.set(0.62, 0, 0);
  g.add(arc, str, grip);
  g.scale.setScalar(scale);
  return g;
}
// стрела: +Z — вперёд, начало координат — середина древка
function makeArrow(color) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, ARROW_LEN, 6).rotateX(Math.PI / 2), shaftMat);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 6).rotateX(Math.PI / 2), tipMat);
  tip.position.z = ARROW_LEN / 2 + 0.06;
  const fm = fletchMatFor(color), fg = new THREE.PlaneGeometry(0.16, 0.09);
  for (let k = 0; k < 3; k++) {                    // три пера через 120°, плоскость каждого — вдоль древка
    const f = new THREE.Mesh(fg, fm);
    f.position.set(0, 0.055, -ARROW_LEN / 2 + 0.1);
    f.rotation.y = Math.PI / 2;
    const holder = new THREE.Group(); holder.rotation.z = k * Math.PI * 2 / 3;
    holder.add(f); g.add(holder);
  }
  // светлый след за стрелой (длина — по скорости, см. updateBow): иначе 0,9 м на 60 м/с глазом не поймать
  const trail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.05, 1, 6, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5),
    new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
  trail.position.z = -ARROW_LEN / 2;   // от хвостовика назад; длина — scale.z
  g.add(shaft, tip, trail);
  g.userData.trail = trail;
  return g;
}

// ---------- лук в лесу ----------
const pickup = makeBow(1.4);
// столб мягкого света над луком — среди ёлок иначе не разглядеть; сам лук всё равно надо найти
const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.5, 5, 12, 1, true).translate(0, 1.8, 0),
  new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
pickup.add(beam);   // ось столба — локальный +Y = up стоящего лука
pickup.visible = false;
scene.add(pickup);
const _n = new THREE.Vector3(), _t = new THREE.Vector3(), _m = new THREE.Matrix4();
// шаг сборки (после леса): место — в лесу, не ближе 1,5 м к стволу, не ближе 40 м к старту
export function buildBow() {
  const rnd = mulberry32(WORLD_SEED ^ hash32('bow'));
  const d = new THREE.Vector3();
  for (let tries = 0; tries < 20000; tries++) {
    d.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (d.lengthSq() < 1e-4) continue;
    d.normalize();
    if (biomeAt(d) !== BIOME.FOREST || d.angleTo(START_DIR) * P.R < 40) continue;
    if (trees.some(t => t.dir.angleTo(d) * P.R < 1.5)) continue;
    bow.dir = d.clone();
    break;
  }
  if (!bow.dir) bow.dir = new THREE.Vector3(0, 0, 1);   // леса нет (не бывает, но пусть будет куда идти)
  try { bow.have = localStorage.getItem(BOW_KEY) === '1'; } catch { /* нет доступа */ }
  handBow.visible = bow.have;
  pickup.visible = !bow.have;
}
function placePickup(t) {
  // стоит над землёй, чуть покачивается и медленно вращается — чтобы заметить среди ёлок
  _n.copy(bow.dir);
  pickup.position.copy(_n).multiplyScalar(surfaceR(_n) - 1.0 - Math.sin(t * 1.5) * 0.08);
  _t.set(0, 1, 0); if (Math.abs(_t.dot(_n)) > 0.9) _t.set(1, 0, 0);
  const up = _n.clone().negate(), fwd = _t.addScaledVector(_n, -_t.dot(_n)).normalize().applyAxisAngle(up, t * 0.8);
  const z = new THREE.Vector3().crossVectors(fwd, up);
  pickup.quaternion.setFromRotationMatrix(_m.makeBasis(fwd, up, z));   // тетива вертикально (локальный Y = up)
}
function take() {
  bow.have = true;
  handBow.visible = true;
  pickup.visible = false;
  try { localStorage.setItem(BOW_KEY, '1'); } catch { /* нет доступа */ }
}

// ---------- лук в руке ----------
const handBow = makeBow(0.55);
handBow.position.set(-0.75, -0.55, -1.6);
handBow.rotation.set(0.25, 0.55, 0.15);
handBow.visible = false;
camera.add(handBow);   // камера уже в scene (messages.js)

// ---------- стрелы ----------
const flying = [];   // { g, vel, own } — own: выпущена нами (о попадании сообщаем мы)
const stuck = [];    // торчащие, FIFO
export const arrows = { flying, stuck };   // для отладки
// цели (monster.js): fn(from, to, arrow) -> true, если стрела попала и цель её забрала (воткнула в себя или убрала)
const hitTests = [];
export function onArrowHit(fn) { hitTests.push(fn); }
function spawnArrow(p, v, color, own = false) {
  const g = makeArrow(color);
  g.position.copy(p);
  g.quaternion.setFromUnitVectors(_t.set(0, 0, 1), _n.copy(v).normalize());
  g.userData.trail.scale.z = Math.min(4, v.length() * 0.05);
  scene.add(g);
  flying.push({ g, vel: v.clone(), own });
}
let lastShot = -1;
function shoot() {
  if (!bow.have || holding() || player.inside || player.dead) return;
  const now = clock.elapsedTime;
  if (now - lastShot < COOLDOWN) return;
  lastShot = now;
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const p = camera.getWorldPosition(new THREE.Vector3()).addScaledVector(dir, 0.8);
  const v = dir.multiplyScalar(P.ARROW_SPEED);
  spawnArrow(p, v, PLAYER_COLOR, true);
  if (audio) sfxTwang();
  netBroadcast({ t: 'arrow', p: p.toArray(), v: v.toArray(), color: PLAYER_COLOR.getHex() });
}
// до канваса клик доходит только при захваченной мыши (иначе — оверлей). capture — чтобы проверить holding() ДО того,
// как messages.js бросит шар и опустошит руку (иначе один клик и бросал бы, и стрелял)
renderer.domElement.addEventListener('mousedown', e => { if (e.button === 0) shoot(); }, { capture: true });
onNet('arrow', (m, slot) => {
  const r = net.remotes.get(slot);
  spawnArrow(new THREE.Vector3().fromArray(m.p), new THREE.Vector3().fromArray(m.v),
             new THREE.Color(m.color ?? (r ? r.color.getHex() : 0xffffff)));
});

// ---------- кадр ----------
const _g = new THREE.Vector3(), _d = new THREE.Vector3(), _from = new THREE.Vector3();
export function updateBow(dt) {
  const t = clock.elapsedTime;
  bow.hint = '';
  // лук в лесу
  if (!bow.have) {
    placePickup(t);
    if (!player.inside) {
      const dist = _d.copy(player.pos).normalize().angleTo(bow.dir) * P.R;
      if (dist < PICK_R) take();
      else if (dist < 12) bow.hint = 'Лук! Подойдите, чтобы взять';
    }
  } else if (!player.inside && !holding()) bow.hint = 'Лук в руках  ·  клик — выстрел';

  // полёт: притяжение к стенке, нос — по скорости; воткнулась — остаётся
  for (let i = flying.length - 1; i >= 0; i--) {
    const a = flying[i];
    _g.copy(a.g.position).normalize().multiplyScalar(P.GRAVITY);
    a.vel.addScaledVector(_g, dt);
    _from.copy(a.g.position);
    a.g.position.addScaledVector(a.vel, dt);
    _d.copy(a.vel).normalize();
    a.g.quaternion.setFromUnitVectors(_t.set(0, 0, 1), _d);
    a.g.userData.trail.scale.z = Math.min(4, a.vel.length() * 0.05);
    if (hitTests.some(fn => fn(_from, a.g.position, a))) {
      a.g.userData.trail.visible = false;
      flying.splice(i, 1);
      continue;
    }
    _n.copy(a.g.position).normalize();
    // наконечник (на +Z от центра) достиг земли
    const tipR = a.g.position.length() + _d.dot(_n) * (ARROW_LEN / 2 + 0.2);
    if (tipR >= surfaceR(_n)) {
      // сдвигаем так, чтобы наконечник ушёл в землю на 0,25 м и стрела торчала под углом падения
      const over = tipR - surfaceR(_n);
      a.g.position.addScaledVector(_d, -over / Math.max(0.25, _d.dot(_n)) + 0.25);
      a.g.userData.trail.visible = false;
      flying.splice(i, 1);
      stuck.push(a.g);
      if (stuck.length > MAX_ARROWS) { const old = stuck.shift(); scene.remove(old); }
    } else if (a.g.position.lengthSq() > (P.R + 5) ** 2) {   // улетела за стенку (не должно) — убираем
      scene.remove(a.g); flying.splice(i, 1);
    }
  }
}
