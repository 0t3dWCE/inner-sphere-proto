// Игрок: ввод (клавиатура, мышь), ходьба по касательной, прыжок, коллизии с городом и ёлками,
// удержание на поверхности рельефа и установка камеры. Всё состояние — в state.player.
import * as THREE from 'three';
import { player, START_DIR } from './state.js';
import { P } from './params.js';
import { camera } from './scene.js';
import { townDir, dirToTown, townToDir, TOWN_H, BIOME, biomeAt } from './world.js';
import { terrainH } from './terrain.js';
import { townObstacles, townPlatformAt } from './town.js';
import { trees } from './forest.js';

const { pos, forward } = player;
pos.copy(START_DIR).multiplyScalar(P.R - P.EYE);   // стартуем на "экваторе" (вдали от полюсов UV-сетки)

// ---------- расширения ----------
// Пробел: сначала спрашиваем обработчики (вход в дом, выход на балкон…) — если кто-то вернул true, прыжка нет
const spaceHandlers = [];
export function onSpace(fn) { spaceHandlers.push(fn); }
// Другой режим управления (интерьер дома): { update(dt), mouse(dx, dy), jump() } — пока установлен, мир игрока не трогаем
let override = null;
export function setPlayerOverride(o) { override = o; }
// координаты игрока в системе города (обновляются каждый кадр, когда он рядом с городом) — для дверей и балконов
export const townXZ = new THREE.Vector2();
export let nearTown = false;
export let platform = null;   // площадка (балкон), на которой стоим, или null

// ---------- коллизии ----------
// с домами и стеной: круг радиуса PLAYER_RAD против AABB в локальных координатах города
const PLAYER_RAD = 0.45;
const _pl = new THREE.Vector2(), _pd = new THREE.Vector3();
function collideWithTown() {
  _pd.copy(pos).normalize();
  if (_pd.angleTo(townDir) * P.R > TOWN_H * 1.6) return;
  dirToTown(_pd, _pl);
  let moved = false;
  for (const o of townObstacles) {
    const cx = THREE.MathUtils.clamp(_pl.x, o.x0, o.x1), cz = THREE.MathUtils.clamp(_pl.y, o.z0, o.z1);
    const dx = _pl.x - cx, dz = _pl.y - cz, d2 = dx * dx + dz * dz;
    if (d2 >= PLAYER_RAD * PLAYER_RAD) continue;
    if (d2 < 1e-9) {
      // оказались внутри — выталкиваем через ближайшую грань
      const pen = [_pl.x - o.x0, o.x1 - _pl.x, _pl.y - o.z0, o.z1 - _pl.y];
      const k = pen.indexOf(Math.min(...pen));
      if (k === 0) _pl.x = o.x0 - PLAYER_RAD; else if (k === 1) _pl.x = o.x1 + PLAYER_RAD;
      else if (k === 2) _pl.y = o.z0 - PLAYER_RAD; else _pl.y = o.z1 + PLAYER_RAD;
    } else {
      const d = Math.sqrt(d2);
      _pl.x = cx + dx / d * PLAYER_RAD;
      _pl.y = cz + dz / d * PLAYER_RAD;
    }
    moved = true;
  }
  if (moved) { townToDir(_pl.x, _pl.y, _pd); pos.copy(_pd).multiplyScalar(pos.length()); }
}
// со стволами: круг против круга по дуге (750 скалярных произведений в кадр — дёшево)
const _tc = new THREE.Vector3();
function collideWithTrees() {
  _pd.copy(pos).normalize();
  const R = P.R, len = pos.length();
  for (const t of trees) {
    const minA = (PLAYER_RAD + t.h * 0.27 * 0.65) / R;   // не даём залезть камерой в крону (нижний ярус r = 0.27h)
    const cosA = _pd.dot(t.dir);
    if (cosA < Math.cos(minA)) continue;
    const a = Math.acos(Math.min(1, cosA));
    // отталкиваем от ствола в касательной плоскости
    _tc.copy(_pd).addScaledVector(t.dir, -cosA);
    if (_tc.lengthSq() < 1e-12) _tc.copy(forward);
    _tc.normalize();
    _pd.addScaledVector(_tc, minA - a).normalize();
    pos.copy(_pd).multiplyScalar(len);
  }
}

// ---------- ввод ----------
const isTyping = e => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
const keys = new Set();
addEventListener('keydown', e => {
  if (isTyping(e)) return;
  if (e.code === 'Enter') { e.preventDefault(); document.getElementById('msg').focus(); return; }
  keys.add(e.code);
  if (e.code === 'Space') {
    if (e.repeat) return;   // автоповтор не должен дёргать вход/выход туда-обратно
    for (const fn of spaceHandlers) if (fn()) return;
    if (override) { override.jump(); return; }
    const onGround = player.jumpH === 0 || (platform && Math.abs(player.jumpH - platform.h) < 0.05);
    if (onGround) player.jumpV = P.JUMP_V;
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
export { keys };

const _up = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3(), _m = new THREE.Matrix4();
addEventListener('mousemove', e => {
  if (!document.pointerLockElement) return;
  if (override) { override.mouse(e.movementX, e.movementY); return; }
  _up.copy(pos).normalize().negate();
  forward.applyAxisAngle(_up, -e.movementX * P.MOUSE_SENS);
  player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * P.MOUSE_SENS, -Math.PI * 0.45, Math.PI * 0.45);
});
export const setPitch = v => { player.pitch = v; };

// ---------- кадр ----------
export function updatePlayer(dt) {
  if (override) { override.update(dt); return; }
  // локальный базис: up — к центру сферы, forward — переносим в касательную плоскость
  _up.copy(pos).normalize().negate();
  forward.addScaledVector(_up, -forward.dot(_up)).normalize();
  _right.crossVectors(forward, _up).normalize();

  // ходьба по касательной
  _move.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) _move.add(forward);
  if (keys.has('KeyS') || keys.has('ArrowDown')) _move.sub(forward);
  if (keys.has('KeyD') || keys.has('ArrowRight')) _move.add(_right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) _move.sub(_right);
  // в воде бредём вдвое медленнее
  if (_move.lengthSq() > 0) pos.addScaledVector(_move.normalize(), P.SPEED * dt * (player.biome === BIOME.WATER ? 0.45 : 1));
  collideWithTown();
  collideWithTrees();
  player.biome = biomeAt(_pd.copy(pos).normalize());
  // координаты в системе города и площадка под ногами (балкон)
  nearTown = _pd.angleTo(townDir) * P.R < TOWN_H * 1.6;
  if (nearTown) dirToTown(_pd, townXZ); else townXZ.set(1e9, 1e9);
  const plat = nearTown ? townPlatformAt(townXZ.x, townXZ.y) : null;

  // прыжок: "притяжение" тянет обратно к стенке
  if (player.jumpH > 0 || player.jumpV > 0) {
    player.jumpV -= P.GRAVITY * dt;
    player.jumpH = Math.max(0, player.jumpH + player.jumpV * dt);
    if (player.jumpH === 0) player.jumpV = 0;
  }
  // балкон: если падаем на плиту (или стоим на ней) — остаёмся на её высоте; сошли с края — падаем как обычно
  platform = null;
  if (plat && player.jumpV <= 0 && player.jumpH <= plat.h + 0.05 && player.jumpH >= plat.h - 0.6) {
    player.jumpH = plat.h; player.jumpV = 0; platform = plat;
  }

  // держим игрока на поверхности рельефа (R - h - EYE - jumpH) — это и есть "притяжение к внутренней поверхности"
  player.groundH = terrainH(_pd.x, _pd.y, _pd.z);   // _pd — направление на игрока (после коллизий)
  pos.setLength(P.R - player.groundH - P.EYE - player.jumpH);

  // камера: X = right, Y = up, Z = -forward, затем наклон по pitch
  camera.position.copy(pos);
  _m.makeBasis(_right, _up, forward.clone().negate());
  camera.quaternion.setFromRotationMatrix(_m);
  camera.rotateX(player.pitch);
}
