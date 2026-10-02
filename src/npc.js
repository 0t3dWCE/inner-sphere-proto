// Жители домов и погонщики каравана.
// Один тип актёра. «Дома» — свой дом или караван. Житель в основном внутри и иногда выходит на улицы города;
// погонщик в основном идёт рядом с караваном и иногда отходит на несколько метров. Приказ order
// (follow, home, here, door, town, oasis, forest, lake) приходит от помощника и на время заменяет эту привычку.
// here значит стоять на месте, пока не скажут иначе. Стрелять можно только снаружи: внутри дома лук и так не стреляет, а житель в доме
// для стрелы недосягаем. 5 попаданий — смерть, без множителя в голову. Трупы лежат до конца сессии, заново не появляются.
// Не дерутся. Хозяин комнаты (младший синхронизированный слот, как у медведракона) симулирует и шлёт снимок ~10 Гц.
// Когда мертвы все погонщики, караван замирает на отметке мирового времени — скорость каравана не обнуляется,
// уже оседланный верблюд едет дальше.
import * as THREE from 'three';
import { ROOM, WORLD_SEED, hash32, mulberry32, player, clock } from './state.js';
import { P } from './params.js';
import { scene } from './scene.js';
import { surfaceR } from './terrain.js';
import { townToDir, dirToTown, townDir, TOWN_H, TOWN_STREET, biomeAt, BIOME, bioAxis, lakeDir, LAKE_R } from './world.js';
import { oasisDir } from './oasis.js';
import { houses, houseLocalToTown, townObstacles } from './town.js';
import { ensureInterior, interiorMove } from './house.js';
import { caravan, worldTime, haltCaravan, releaseCaravan } from './caravan.js';
import { noteCamelDead } from './ride.js';
import { onArrowHit } from './bow.js';
import { net, netBroadcast, onNet, addHelloFields } from './net.js';

export const NPC_HP = 5;
const SYNC_ALONE_T = 6;
const SNAP_DT = 0.1;
const IN_SPEED = 1.3;
const OUT_SPEED = 1.6;
const HERD_SPEED = 1.5;
const HERD_BACK = 3.6;
const FOLLOW_GAP = 2.4;
const BODY_R = 0.55;
const CHEST = 1.05;

const ROBES = [0x3d5a80, 0x6b4f3a, 0x8c3a3a, 0x3f6b4a, 0xc4a574, 0x4a3f6b, 0x7a5b3a, 0x355e52];
const CAPS = [0xd8c7a1, 0x2c2a28, 0x8d3b3b, 0x1f3a5f, 0xe8e0d0];

const actors = [];
const homeNpcs = [];
const herderNpcs = [];
const camelNpcs = [];
let synced = !ROOM;
let snapAcc = 0;

const lowestSlot = () => Math.min(net.slot < 0 ? Infinity : net.slot, ...net.remotes.keys());
export const isNpcHost = () => !ROOM || (synced && (net.slot < 0 ? net.remotes.size === 0 : lowestSlot() === net.slot));

const _up = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _goal = new THREE.Vector3();
const _m = new THREE.Matrix4(), _axis = new THREE.Vector3(), _before = new THREE.Vector3();
const _v2 = new THREE.Vector2(), _v2b = new THREE.Vector2();
const _chest = new THREE.Vector3(), _ab = new THREE.Vector3(), _hit = new THREE.Vector3(), _enter = new THREE.Vector3();
const ARROW_TIP = 0.51;   // наконечник впереди центра стрелы

function makePerson(robeColor, capColor) {
  const g = new THREE.Group();
  const robe = new THREE.MeshStandardMaterial({ color: robeColor, roughness: .95, flatShading: true });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc48a62, roughness: .9, flatShading: true });
  const cloth = new THREE.MeshStandardMaterial({ color: capColor, roughness: .95, flatShading: true });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 0.95, 7), robe);
  body.position.y = 0.82;
  const head = new THREE.Group();
  head.position.y = 1.48;
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.15, 7, 6), skin);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.1, 7), cloth);
  cap.position.y = 0.12;
  head.add(face, cap);
  const legGeo = new THREE.BoxGeometry(0.12, 0.55, 0.14); legGeo.translate(0, -0.28, 0);
  const legL = new THREE.Mesh(legGeo, skin); legL.position.set(-0.09, 0.55, 0);
  const legR = new THREE.Mesh(legGeo, skin); legR.position.set(0.09, 0.55, 0);
  const armGeo = new THREE.BoxGeometry(0.1, 0.55, 0.1); armGeo.translate(0, -0.28, 0);
  const armL = new THREE.Mesh(armGeo, robe); armL.position.set(-0.26, 1.22, 0);
  const armR = new THREE.Mesh(armGeo, robe); armR.position.set(0.26, 1.22, 0);
  g.add(body, head, legL, legR, armL, armR);
  return { group: g, body, head, legL, legR, armL, armR };
}

function streetPoint() {
  const along = (Math.random() - 0.5) * TOWN_H * 1.5;
  const side = (Math.random() - 0.5) * (TOWN_STREET - 1.4);
  return Math.random() < 0.5 ? { x: along, z: side } : { x: side, z: along };
}
function hitTown(x, z) {
  const r = 0.4;
  for (const o of townObstacles) {
    const cx = THREE.MathUtils.clamp(x, o.x0, o.x1), cz = THREE.MathUtils.clamp(z, o.z0, o.z1);
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}
function indoorsBlocked(it, x, z) {
  if (it.stairs.some(s => x >= s.x0 - 0.25 && x <= s.x1 + 0.25 && z >= s.z0 - 0.2 && z <= s.z1 + 0.2)) return true;
  for (const o of it.obstacles) {
    if (o.y1 < 0.4 || o.y0 > 1.2) continue;
    if (x > o.x0 - 0.25 && x < o.x1 + 0.25 && z > o.z0 - 0.25 && z < o.z1 + 0.25) return true;
  }
  return false;
}
function rememberFace(n, before) {
  _fwd.copy(n.dir).sub(before);
  _fwd.addScaledVector(n.dir, -_fwd.dot(n.dir));
  if (_fwd.lengthSq() > 1e-8) n.face.copy(_fwd).normalize();
}
function stepToward(dir, goal, speed, dt) {
  _axis.crossVectors(dir, goal);
  const sin = _axis.length();
  const ang = Math.atan2(sin, THREE.MathUtils.clamp(dir.dot(goal), -1, 1));
  if (!(ang > 1e-4) || sin < 1e-8) { dir.copy(goal); return true; }
  dir.applyAxisAngle(_axis.multiplyScalar(1 / sin), Math.min(ang, speed * dt / P.R)).normalize();
  return ang <= speed * dt / P.R + 1e-5;
}
function stepTown(n, tx, tz, dt) {
  dirToTown(n.dir, _v2);
  const dx = tx - _v2.x, dz = tz - _v2.y;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.45) { n.moving = false; return true; }
  const step = Math.min(dist, OUT_SPEED * dt);
  const ux = dx / dist, uz = dz / dist;
  const lim = TOWN_H - 1.15;
  let nx = THREE.MathUtils.clamp(_v2.x + ux * step, -lim, lim);
  let nz = THREE.MathUtils.clamp(_v2.y + uz * step, -lim, lim);
  if (hitTown(nx, nz)) {
    const ax = THREE.MathUtils.clamp(_v2.x + ux * step, -lim, lim);
    const az = THREE.MathUtils.clamp(_v2.y + uz * step, -lim, lim);
    if (!hitTown(ax, _v2.y)) { nx = ax; nz = _v2.y; }
    else if (!hitTown(_v2.x, az)) { nx = _v2.x; nz = az; }
    else { n.moving = false; return false; }
  }
  _before.copy(n.dir);
  townToDir(nx, nz, n.dir);
  rememberFace(n, _before);
  n.moving = true;
  return false;
}

function pickIndoor(n) {
  const it = n.it;
  for (let i = 0; i < 12; i++) {
    const x = (Math.random() - 0.5) * (it.W - 1.6);
    const z = (Math.random() - 0.5) * (it.D - 1.6);
    if (indoorsBlocked(it, x, z)) continue;
    n.goal = { x, z };
    n.mode = 'walk';
    n.goalT = 0;
    return;
  }
  n.goal = { x: n.door.x, z: n.door.z - 1.2 };
  n.mode = 'walk';
  n.goalT = 0;
}
function goOutside(n) {
  const h = houses[n.house];
  houseLocalToTown(h, h.doorX, h.d / 2 + 1.35, _v2);
  townToDir(_v2.x, _v2.y, n.dir);
  houseLocalToTown(h, h.doorX, h.d / 2 + 3.2, _v2b);
  townToDir(_v2b.x, _v2b.y, n.face);
  n.st = 'out';
  n.mode = 'street';
  n.outLeft = 8 + Math.random() * 12;
  n.goalTown = streetPoint();
  n.goalT = 0;
  n.moving = true;
}
function enterHouse(n) {
  n.st = 'in';
  n.pos.set(n.door.x, 0, n.door.z - 0.7);
  n.yaw = Math.PI;
  interiorMove(n.it, n.pos, 0, 0);
  n.mode = 'pause';
  n.pause = 12 + Math.random() * 18;
  n.moving = false;
  n.goalT = 0;
}
function simIndoor(n, dt) {
  if (n.mode === 'pause') {
    n.pause -= dt;
    n.moving = false;
    if (n.pause <= 0) {
      if (Math.random() < 0.25) {
        n.mode = 'leave';
        n.goal = { x: n.door.x, z: n.door.z };
        n.goalT = 0;
      } else pickIndoor(n);
    }
    return;
  }
  const dx = n.goal.x - n.pos.x, dz = n.goal.z - n.pos.z;
  const dist = Math.hypot(dx, dz);
  n.goalT += dt;
  if (dist < 0.4 || n.goalT > 8) {
    if (n.mode === 'leave' && dist < 0.7) goOutside(n);
    else { n.mode = 'pause'; n.pause = 5 + Math.random() * 12; n.moving = false; }
    return;
  }
  const step = Math.min(dist, IN_SPEED * dt);
  const ox = n.pos.x, oz = n.pos.z;
  interiorMove(n.it, n.pos, dx / dist * step, dz / dist * step);
  n.yaw = Math.atan2(dx, dz);
  n.moving = Math.hypot(n.pos.x - ox, n.pos.z - oz) > 0.004;
}
function simStreet(n, dt) {
  if (n.mode === 'camp') {
    n.moving = false;
    if (oasisDir.lengthSq() > 0.5) n.face.copy(oasisDir);
    return;
  }
  if (n.mode !== 'home') {
    n.outLeft -= dt;
    if (n.outLeft <= 0) {
      const h = houses[n.house];
      houseLocalToTown(h, h.doorX, h.d / 2 + 1.35, _v2);
      n.mode = 'home';
      n.goalTown = { x: _v2.x, z: _v2.y };
      n.goalT = 0;
    }
  }
  if (!n.goalTown) n.goalTown = streetPoint();
  n.goalT += dt;
  const arrived = stepTown(n, n.goalTown.x, n.goalTown.z, dt);
  if (n.mode === 'home' && (arrived || n.goalT > 12)) enterHouse(n);
  else if (n.mode === 'street' && (arrived || n.goalT > 8)) { n.goalTown = streetPoint(); n.goalT = 0; }
}
function beginHerderTrip(n) {
  const g = n.herder.group;
  if (g.position.lengthSq() < 1) { n.wait = 1; return; }
  g.updateMatrix();
  n.dir.copy(g.position).normalize();
  _right.setFromMatrixColumn(g.matrix, 0);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
  const dist = 4 + Math.random() * 2;
  const a = dist / P.R;
  n.goalDir.copy(n.dir).multiplyScalar(Math.cos(a)).addScaledVector(_right, Math.sin(a) * (n.herder.side || 1)).normalize();
  n.face.copy(n.goalDir);
  n.st = 'out';
  n.herder.st = 'out';
  n.phase = 'go';
  n.moving = true;
}
function simHerder(n, dt) {
  if (n.st === 'in') {
    n.wait -= dt;
    n.moving = false;
    if (n.wait <= 0) beginHerderTrip(n);
    return;
  }
  if (n.goalDir.lengthSq() < 0.5) {
    n.phase = 'back';
    n.backT = n.backT || 0;
    if (herdHomeDir(n.goalDir).lengthSq() < 0.5) { n.st = 'in'; n.herder.st = 'in'; n.wait = 8; return; }
  }
  if (n.phase === 'stand') {
    n.wait -= dt;
    n.moving = false;
    if (n.wait <= 0) { n.phase = 'back'; n.backT = 0; }
    return;
  }
  if (n.phase === 'back') {
    herdHomeDir(n.goalDir);
    n.backT += dt;
  }
  _before.copy(n.dir);
  const arrived = stepToward(n.dir, n.goalDir, n.phase === 'back' ? HERD_BACK : HERD_SPEED, dt);
  rememberFace(n, _before);
  n.moving = !arrived;
  if (n.phase === 'go' && arrived) { n.phase = 'stand'; n.wait = 1.5 + Math.random() * 1.5; n.moving = false; }
  if (n.phase === 'back') {
    const distM = n.dir.angleTo(n.goalDir) * P.R;
    if (distM < 2.2 || n.backT > 8) {
      n.st = 'in';
      n.herder.st = 'in';
      n.wait = 14 + Math.random() * 26;
      n.moving = false;
    }
  }
}

function herdHomeDir(out) {
  const live = caravan.camels.find(c => c.st?.away !== 'dead' && c.group.position.lengthSq() > 1)
    || caravan.camels[Math.floor(caravan.camels.length / 2)];
  return live && live.group.position.lengthSq() > 1 ? out.copy(live.group.position).normalize() : out.set(0, 0, 0);
}
function maybeHalt() {
  if (caravan.haltAt > 0) return;
  if (herderNpcs.length && herderNpcs.every(n => n.st === 'dead')) haltCaravan(worldTime());
}
function markDead(n) {
  if (n.st === 'dead') return;
  if (n.kind === 'herder') {
    if (n.st === 'in' && n.herder.group.position.lengthSq() > 1) {
      n.dir.copy(n.herder.group.position).normalize();
      n.face.copy(n.dir);
    }
    n.herder.st = 'dead';
    n.herder.hp = 0;
  }
  if (n.kind === 'camel') {
    if (n.camel.group.position.lengthSq() > 1) {
      n.dir.copy(n.camel.group.position).normalize();
      n.face.copy(n.camel.group.getWorldDirection(_fwd));
    }
    noteCamelDead(n.id - 200);
  }
  n.hp = 0;
  n.st = 'dead';
  n.moving = false;
  n.order = null;
  endAct(n);
  if (n.kind === 'herder') maybeHalt();
}
function applyHit(n, k) {
  if (!n || n.st === 'dead' || n.hp <= 0 || !(k > 0)) return;
  if (n.kind === 'home' && n.st !== 'out') return;
  n.hp = Math.max(0, n.hp - k);
  if (n.herder) n.herder.hp = n.hp;
  if (n.hp <= 0) markDead(n);
}
function outdoors(n) {
  if (n.st === 'dead') return false;
  if (n.kind === 'herder' || n.kind === 'camel') return true;
  return n.st === 'out';
}
function chestAt(mesh, out, lift) {
  mesh.updateWorldMatrix(true, false);
  mesh.getWorldPosition(out);
  _up.copy(out);
  if (_up.lengthSq() < 1e-6) return out;
  _up.normalize().negate();
  return out.addScaledVector(_up, lift);
}
// точка входа отрезка в шар — в _enter; _ab остаётся from→to
function segHit(from, to, center, r) {
  _ab.copy(to).sub(from);
  const len2 = _ab.lengthSq();
  const t = len2 > 1e-8 ? THREE.MathUtils.clamp(_hit.copy(center).sub(from).dot(_ab) / len2, 0, 1) : 0;
  _hit.copy(from).addScaledVector(_ab, t);
  const d2 = _hit.distanceToSquared(center);
  if (d2 > r * r) return false;
  const back = len2 > 1e-8 ? Math.sqrt(Math.max(0, r * r - d2)) / Math.sqrt(len2) : 0;
  _enter.copy(from).addScaledVector(_ab, Math.max(0, t - back));
  return true;
}
function stickArrow(arrow, mesh, embed) {
  const len = _ab.length();
  if (len < 1e-6) return;
  _ab.multiplyScalar(1 / len);
  arrow.g.position.copy(_enter).addScaledVector(_ab, embed - ARROW_TIP);
  arrow.g.userData.trail.visible = false;
  mesh.attach(arrow.g);
}

const r4 = v => Math.round(v * 1e4) / 1e4;
function pack(n) {
  const st = n.st === 'in' ? 0 : n.st === 'out' ? 1 : 2;
  if ((n.kind === 'herder' || n.kind === 'camel') && n.st === 'in') return [n.id, n.hp, st];
  if (n.kind === 'home' && n.st === 'in') return [n.id, n.hp, st, r4(n.pos.x), r4(n.pos.y), r4(n.pos.z), r4(n.yaw)];
  return [n.id, n.hp, st, r4(n.dir.x), r4(n.dir.y), r4(n.dir.z)];
}
function snapshot() {
  return { halt: caravan.haltAt || 0, a: actors.map(pack) };
}
const byId = id => actors.find(n => n.id === id);
function adopt(s, slot) {
  if (!s || !Array.isArray(s.a)) return;
  if (synced && (isNpcHost() || slot !== lowestSlot())) return;
  const first = !synced;
  if (first) { synced = true; releaseCaravan(s.halt || 0); }
  else if (s.halt > 0) haltCaravan(s.halt);
  for (const row of s.a) {
    const n = byId(row[0]);
    if (!n) continue;
    n.hp = row[1];
    const st = row[2] === 0 ? 'in' : row[2] === 1 ? 'out' : 'dead';
    n.st = st;
    if (n.herder) { n.herder.st = st; n.herder.hp = n.hp; }
    if (n.kind === 'camel' && st === 'dead') noteCamelDead(n.id - 200);
    if (row.length >= 7) {
      n.tpos.set(row[3], row[4], row[5]);
      n.tyaw = row[6];
      if (first) { n.pos.copy(n.tpos); n.yaw = n.tyaw; }
    } else if (row.length >= 6) {
      n.tdir.set(row[3], row[4], row[5]);
      if (n.tdir.lengthSq() > 0) n.tdir.normalize();
      if (first || n.dir.lengthSq() < 0.5) { n.dir.copy(n.tdir); n.face.copy(n.tdir); }
    }
  }
}
function considerSync() {
  if (synced || clock.elapsedTime <= SYNC_ALONE_T) return;
  const alone = net.remotes.size === 0;
  const lowest = net.slot < 0 || lowestSlot() === net.slot;
  if (alone || lowest) { synced = true; releaseCaravan(caravan.haltAt || 0); }
}

function attach(mesh, parent) {
  if (mesh.parent !== parent) parent.add(mesh);
}
function placeOnWall(mesh, dir, face) {
  _up.copy(dir).negate();
  _fwd.copy(face && face.lengthSq() > 0.1 ? face : dir);
  _fwd.addScaledVector(_up, -_fwd.dot(_up));
  if (_fwd.lengthSq() < 1e-8) {
    _fwd.set(0, 1, 0);
    if (Math.abs(_up.dot(_fwd)) > 0.9) _fwd.set(1, 0, 0);
    _fwd.addScaledVector(_up, -_fwd.dot(_up));
  }
  _fwd.normalize();
  _right.crossVectors(_up, _fwd).normalize();
  mesh.position.copy(dir).multiplyScalar(surfaceR(dir) - 0.02);
  mesh.quaternion.setFromRotationMatrix(_m.makeBasis(_right, _up, _fwd));
}
function rigOf(n) {
  return n.kind === 'herder' ? n.herder : n.parts;
}
function restY(mesh) {
  if (mesh.userData.restY == null) mesh.userData.restY = mesh.position.y;
  return mesh.userData.restY;
}
function resetRig(p) {
  if (!p || !p.legL) return;
  for (const m of [p.legL, p.legR, p.armL, p.armR, p.head, p.body]) {
    if (m) m.rotation.set(0, 0, 0);
  }
  if (p.body) p.body.position.y = restY(p.body);
  if (p.head) p.head.position.y = restY(p.head);
}
function endAct(n) {
  if (!n || !n.act) return;
  resetRig(rigOf(n));
  n.act = null;
  n.hop = 0;
  n.hopV = 0;
  if (n.herder) {
    n.herder.acting = false;
    n.herder.hop = 0;
    n.herder.actBase = null;
  }
}
function beginAct(n, what) {
  if (what !== 'sing' && what !== 'dance' && what !== 'jump' && what !== 'sit') return false;
  if (n.act) resetRig(rigOf(n));
  n.act = what;
  n.hop = 0;
  n.hopV = what === 'jump' ? 5.4 : 0;
  n.actUntil = clock.elapsedTime + (what === 'sing' ? 8 : what === 'dance' ? 6 : what === 'sit' ? 12 : 2);
  if (n.herder) {
    n.herder.acting = n.st === 'in';
    n.herder.hop = 0;
    n.herder.actBase = n.st === 'in' ? n.herder.group.position.clone() : null;
  }
  return true;
}
function tickAct(n, dt) {
  if (!n.act) return false;
  n.moving = false;
  if (n.act === 'jump') {
    n.hopV -= 18 * dt;
    n.hop = Math.max(0, n.hop + n.hopV * dt);
    if (n.herder) n.herder.hop = n.hop;
    if (n.hop === 0 && n.hopV < 0) endAct(n);
    return !!n.act;
  }
  if (clock.elapsedTime >= n.actUntil) endAct(n);
  return !!n.act;
}
function pose(n) {
  const p = rigOf(n);
  if (!p || !p.legL || !n.act || n.act === 'jump') return;
  const ph = clock.elapsedTime * 6.5 + (typeof n.phase === 'number' ? n.phase : (n.herder && n.herder.gaitPhase) || 0);
  if (n.act === 'sit') {
    p.legL.rotation.x = 1.35;
    p.legR.rotation.x = 1.35;
    p.armL.rotation.x = 0.45;
    p.armR.rotation.x = 0.4;
    p.body.position.y = restY(p.body) - 0.36;
    p.head.position.y = restY(p.head) - 0.36;
    return;
  }
  if (n.act === 'dance') {
    p.legL.rotation.x = Math.sin(ph) * 0.4;
    p.legR.rotation.x = -Math.sin(ph) * 0.4;
    p.armL.rotation.set(-1.15 + Math.sin(ph) * 0.45, 0, 0.55);
    p.armR.rotation.set(-1.15 + Math.sin(ph + 1.2) * 0.45, 0, -0.55);
    p.body.rotation.y = Math.sin(ph * 0.5) * 0.45;
    p.head.rotation.z = Math.sin(ph) * 0.18;
    return;
  }
  p.armL.rotation.x = -0.55;
  p.armR.rotation.x = -0.25 + Math.sin(ph * 0.45) * 0.2;
  p.body.rotation.y = Math.sin(ph * 0.35) * 0.14;
  p.head.rotation.x = Math.sin(ph) * 0.08;
}
function liftOffWall(mesh, dir, hop) {
  if (hop > 0) mesh.position.addScaledVector(dir, -hop);
}
function gait(parts, moving, phase, dead) {
  if (!parts) return;
  if (dead) {
    parts.legL.rotation.x = 0.35;
    parts.legR.rotation.x = -0.15;
    parts.armL.rotation.x = 0.4;
    parts.armR.rotation.x = -0.45;
    return;
  }
  const ph = clock.elapsedTime * (moving ? 6.2 : 1.1) + phase;
  const amp = moving ? 0.48 : 0.04;
  parts.legL.rotation.x = Math.sin(ph) * amp;
  parts.legR.rotation.x = -Math.sin(ph) * amp;
  parts.armL.rotation.x = -Math.sin(ph) * amp * 0.65;
  parts.armR.rotation.x = Math.sin(ph) * amp * 0.65;
}
function blendRemote(n, dt) {
  const k = 1 - Math.exp(-8 * dt);
  if (n.kind === 'home' && n.st === 'in') {
    n.moving = n.pos.distanceTo(n.tpos) > 0.05;
    n.pos.lerp(n.tpos, k);
    const dy = Math.atan2(Math.sin(n.tyaw - n.yaw), Math.cos(n.tyaw - n.yaw));
    n.yaw += dy * k;
    return;
  }
  if ((n.st === 'out' || n.st === 'dead') && n.tdir.lengthSq() > 0.2) {
    _before.copy(n.dir);
    n.moving = n.dir.distanceTo(n.tdir) > 0.002;
    n.dir.lerp(n.tdir, k).normalize();
    rememberFace(n, _before);
  }
}
function showActor(n) {
  if (n.kind === 'camel') {
    if (n.st !== 'dead') return;
    if (n.dir.lengthSq() < 0.5 && n.mesh.position.lengthSq() > 1) n.dir.copy(n.mesh.position).normalize();
    if (n.dir.lengthSq() < 0.5) return;
    n.mesh.visible = true;
    placeOnWall(n.mesh, n.dir, n.face);
    n.mesh.rotateZ(Math.PI / 2);
    return;
  }
  if (n.kind === 'herder') {
    if (n.st === 'in') {
      if (!n.act) return;
      const g = n.herder.group;
      if (n.herder.actBase) {
        g.position.copy(n.herder.actBase);
        liftOffWall(g, n.herder.actBase.clone().normalize(), n.hop || 0);
      }
      pose(n);
      return;
    }
    if (n.dir.lengthSq() < 0.5) return;
    attach(n.mesh, scene);
    n.mesh.visible = true;
    placeOnWall(n.mesh, n.dir, n.face);
    liftOffWall(n.mesh, n.dir, n.hop || 0);
    if (n.st === 'dead') n.mesh.rotateZ(Math.PI / 2);
    if (n.act && n.act !== 'jump') pose(n);
    else gait(n.herder, n.moving, n.herder.gaitPhase || 0, n.st === 'dead');
    return;
  }
  if (n.st === 'in') {
    attach(n.mesh, n.it.group);
    n.mesh.visible = !!(player.inside && player.inside.house === n.house);
    n.mesh.position.set(n.pos.x, n.pos.y + (n.hop || 0), n.pos.z);
    n.mesh.rotation.set(0, n.yaw, 0);
    if (n.act && n.act !== 'jump') pose(n);
    else gait(n.parts, n.moving, n.phase, false);
    return;
  }
  attach(n.mesh, scene);
  n.mesh.visible = n.dir.lengthSq() > 0.5;
  if (!n.mesh.visible) return;
  placeOnWall(n.mesh, n.dir, n.face);
  liftOffWall(n.mesh, n.dir, n.hop || 0);
  if (n.st === 'dead') n.mesh.rotateZ(Math.PI / 2);
  if (n.act && n.act !== 'jump') pose(n);
  else gait(n.parts, n.moving, n.phase, n.st === 'dead');
}

export function buildNpc() {
  for (const h of houses) {
    const rng = mulberry32(WORLD_SEED ^ hash32('npc:' + h.idx));
    const person = makePerson(ROBES[Math.floor(rng() * ROBES.length)], CAPS[Math.floor(rng() * CAPS.length)]);
    person.group.scale.setScalar(0.92 + rng() * 0.16);
    const it = ensureInterior(h);
    const door = it.exits.find(e => e.kind === 'door') || { x: 0, z: it.D / 2 - 0.9, f: 0 };
    const n = {
      id: h.idx, kind: 'home', hp: NPC_HP, st: 'in', house: h.idx, it, door,
      mesh: person.group, parts: person,
      pos: new THREE.Vector3(door.x + (rng() - 0.5) * 1.4, 0, door.z - 1.1),
      yaw: Math.PI, dir: new THREE.Vector3(), face: new THREE.Vector3(0, 0, 1),
      tpos: new THREE.Vector3(), tyaw: Math.PI, tdir: new THREE.Vector3(),
      goal: null, goalTown: null, mode: 'pause', pause: 8 + rng() * 22,
      outLeft: 0, goalT: 0, phase: rng() * Math.PI * 2, moving: false, order: null,
    };
    interiorMove(it, n.pos, 0, 0);
    n.tpos.copy(n.pos);
    actors.push(n);
    homeNpcs.push(n);
  }
  placeNearOasis(homeNpcs[0]);
  caravan.herders.forEach((h, i) => {
    h.st = 'in';
    h.hp = NPC_HP;
    const n = {
      id: 100 + i, kind: 'herder', hp: NPC_HP, st: 'in', herder: h, mesh: h.group,
      dir: new THREE.Vector3(), face: new THREE.Vector3(), goalDir: new THREE.Vector3(), tdir: new THREE.Vector3(),
      phase: 'go', wait: 12 + i * 6 + Math.random() * 18, backT: 0, moving: false, order: null,
    };
    actors.push(n);
    herderNpcs.push(n);
  });
  caravan.camels.forEach((c, i) => {
    const n = {
      id: 200 + i, kind: 'camel', hp: NPC_HP, st: 'in', camel: c, mesh: c.group,
      dir: new THREE.Vector3(), face: new THREE.Vector3(), tdir: new THREE.Vector3(), moving: false,
    };
    actors.push(n);
    camelNpcs.push(n);
  });
}

function placeNearOasis(n) {
  if (!n || oasisDir.lengthSq() < 0.5) return;
  _fwd.copy(bioAxis).addScaledVector(oasisDir, -oasisDir.dot(bioAxis));
  if (_fwd.lengthSq() < 1e-6) _fwd.set(1, 0, 0);
  _fwd.normalize();
  const gap = 14 / P.R;
  n.dir.copy(oasisDir).multiplyScalar(Math.cos(gap)).addScaledVector(_fwd, Math.sin(gap)).normalize();
  n.face.copy(oasisDir);
  n.st = 'out';
  n.mode = 'camp';
  n.anchor = 'oasis';
  n.moving = false;
}
function doorTown(n, extra) {
  const h = houses[n.house];
  houseLocalToTown(h, h.doorX, h.d / 2 + extra, _v2);
  return { x: _v2.x, z: _v2.y };
}
function aimAtPlayer() {
  if (player.inside) {
    const h = houses[player.inside.house];
    if (h) {
      houseLocalToTown(h, h.doorX, h.d / 2 + FOLLOW_GAP, _v2);
      townToDir(_v2.x, _v2.y, _goal);
      return;
    }
  }
  _goal.copy(player.pos);
  if (_goal.lengthSq() > 1) _goal.normalize();
}
function followOnSphere(n, dt, speed) {
  aimAtPlayer();
  if (_goal.lengthSq() < 0.5 || n.dir.lengthSq() < 0.5) return;
  if (n.dir.angleTo(_goal) * P.R < FOLLOW_GAP) {
    n.moving = false;
    n.face.copy(_goal);
    return;
  }
  dirToTown(n.dir, _v2b);
  dirToTown(_goal, _v2);
  const here = Math.abs(_v2b.x) < TOWN_H && Math.abs(_v2b.y) < TOWN_H;
  const there = Math.abs(_v2.x) < TOWN_H && Math.abs(_v2.y) < TOWN_H;
  if (n.kind === 'home' && here && there) {
    const dx = _v2.x - _v2b.x, dz = _v2.y - _v2b.y;
    const d = Math.hypot(dx, dz) || 1;
    stepTown(n, _v2.x - dx / d * FOLLOW_GAP, _v2.y - dz / d * FOLLOW_GAP, dt);
    return;
  }
  _before.copy(n.dir);
  stepToward(n.dir, _goal, speed, dt);
  rememberFace(n, _before);
  n.moving = true;
}
function leaveHouse(n) {
  if (n.mode === 'leave') return;
  n.mode = 'leave';
  n.goal = { x: n.door.x, z: n.door.z };
  n.goalT = 0;
}
function hold(n) {
  n.order = 'here';
  n.moving = false;
  n.goalT = 0;
}
function landmarkDir(where, out) {
  if (where === 'oasis') return out.copy(oasisDir);
  if (where === 'forest') return out.copy(bioAxis);
  if (where === 'lake') return out.copy(lakeDir);
  if (where === 'town') return out.copy(townDir);
  return out.set(0, 0, 0);
}
function simLandmark(n, dt, speed) {
  landmarkDir(n.order, _goal);
  if (_goal.lengthSq() < 0.5 || n.dir.lengthSq() < 0.5) return;
  const dist = n.dir.angleTo(_goal) * P.R;
  const biome = biomeAt(n.dir);
  let done = dist < 4;
  if (n.order === 'oasis') done = dist < 6;
  if (n.order === 'town') done = dist < 3;
  if (n.order === 'forest') done = biome === BIOME.FOREST;
  if (n.order === 'lake') done = biome === BIOME.WATER || dist < LAKE_R * P.R + 6;
  n.goalT += dt;
  if (done || n.goalT > 90) {
    hold(n);
    n.face.copy(_goal);
    return;
  }
  if (n.kind === 'home') {
    dirToTown(n.dir, _v2b);
    dirToTown(_goal, _v2);
    const here = Math.abs(_v2b.x) < TOWN_H && Math.abs(_v2b.y) < TOWN_H;
    const there = Math.abs(_v2.x) < TOWN_H && Math.abs(_v2.y) < TOWN_H;
    if (here && there) {
      stepTown(n, _v2.x, _v2.y, dt);
      return;
    }
  }
  _before.copy(n.dir);
  stepToward(n.dir, _goal, speed, dt);
  rememberFace(n, _before);
  n.moving = true;
}
function simHomeOrder(n, dt) {
  if (n.order === 'here') {
    n.moving = false;
    if (n.st === 'out' && player.pos.lengthSq() > 1) n.face.copy(player.pos).normalize();
    return;
  }
  if (n.order === 'home') {
    if (n.st === 'in') { n.order = null; return; }
    if (n.mode !== 'home') {
      const spot = doorTown(n, 1.35);
      n.mode = 'home';
      n.goalTown = spot;
      n.goalT = 0;
    }
    simStreet(n, dt);
    if (n.st === 'in') n.order = null;
    return;
  }
  if (n.order === 'door') {
    if (n.st === 'in') { leaveHouse(n); simIndoor(n, dt); return; }
    const spot = doorTown(n, 3.2);
    n.goalT += dt;
    if (stepTown(n, spot.x, spot.z, dt) || n.goalT > 20) hold(n);
    return;
  }
  if (n.st === 'in') { leaveHouse(n); simIndoor(n, dt); return; }
  if (n.order === 'follow') {
    if (player.inside && player.inside.house === n.house) { n.order = 'home'; return; }
    followOnSphere(n, dt, OUT_SPEED);
    return;
  }
  simLandmark(n, dt, OUT_SPEED);
}
function simHerderOrder(n, dt) {
  if (n.order === 'here') {
    if (n.st === 'in' && n.dir.lengthSq() < 0.5) beginHerderTrip(n);
    n.moving = false;
    if (n.st === 'out' && player.pos.lengthSq() > 1) n.face.copy(player.pos).normalize();
    return;
  }
  if (n.order === 'home') {
    if (n.st === 'in') { n.order = null; return; }
    n.phase = 'back';
    simHerder(n, dt);
    if (n.st === 'in') n.order = null;
    return;
  }
  if (n.dir.lengthSq() < 0.5) beginHerderTrip(n);
  if (n.st !== 'out' || n.dir.lengthSq() < 0.5) return;
  if (n.order === 'door') {
    if (n.goalDir.lengthSq() < 0.5) beginHerderTrip(n);
    _before.copy(n.dir);
    const arrived = stepToward(n.dir, n.goalDir, HERD_SPEED, dt);
    rememberFace(n, _before);
    n.moving = !arrived;
    n.goalT += dt;
    if (arrived || n.goalT > 20) hold(n);
    return;
  }
  if (n.order === 'follow') { followOnSphere(n, dt, HERD_SPEED); return; }
  simLandmark(n, dt, HERD_SPEED);
}
function applyOrder(n, where) {
  if (where === 'stop') {
    n.order = null;
    if (n.kind === 'home' && n.st === 'out') {
      if (n.anchor === 'oasis') {
        n.mode = 'camp';
        n.moving = false;
        n.goalTown = null;
      } else {
        n.mode = 'street';
        n.outLeft = 8;
        n.goalTown = streetPoint();
        n.goalT = 0;
      }
    }
    if (n.kind === 'herder' && n.st === 'out') { n.phase = 'back'; n.backT = 0; }
    return true;
  }
  if (where === 'out') where = 'door';
  if (where !== 'follow' && where !== 'home' && where !== 'door' && where !== 'here'
    && where !== 'town' && where !== 'oasis' && where !== 'forest' && where !== 'lake') return false;
  n.order = where;
  n.goalT = 0;
  return true;
}
export function npcOrder(id, where) {
  const n = byId(id);
  if (!n || n.st === 'dead' || (n.kind !== 'home' && n.kind !== 'herder')) return false;
  if (!isNpcHost()) {
    netBroadcast({ t: 'norder', id, where });
    return true;
  }
  return applyOrder(n, where);
}

export function npcAct(id, what) {
  const n = byId(id);
  if (!n || n.st === 'dead' || (n.kind !== 'home' && n.kind !== 'herder')) return false;
  if (!beginAct(n, what)) return false;
  netBroadcast({ t: 'nact', id, what });
  return true;
}

export function updateNpc(dt) {
  if (dt <= 0 || !actors.length) return;
  considerSync();
  const host = isNpcHost();
  if (host) {
    for (const n of homeNpcs) if (n.st !== 'dead') {
      if (!tickAct(n, dt)) (n.order ? simHomeOrder(n, dt) : (n.st === 'out' ? simStreet(n, dt) : simIndoor(n, dt)));
    }
    for (const n of herderNpcs) if (n.st !== 'dead') {
      if (!tickAct(n, dt)) (n.order ? simHerderOrder(n, dt) : simHerder(n, dt));
    }
    snapAcc += dt;
    if (ROOM && synced && snapAcc >= SNAP_DT && net.conns.size) {
      snapAcc = 0;
      netBroadcast(Object.assign({ t: 'npc' }, snapshot()));
    }
  } else {
    for (const n of actors) {
      if (n.st !== 'dead') tickAct(n, dt);
      blendRemote(n, dt);
    }
  }
  for (const n of actors) showActor(n);
}

onArrowHit((from, to, arrow) => {
  for (const n of actors) {
    if (!outdoors(n) || n.mesh.parent !== scene) continue;
    const sc = n.kind === 'camel' ? n.mesh.scale.x : 1;
    const r = n.kind === 'camel' ? 1.15 * sc : BODY_R;
    const lift = n.kind === 'camel' ? 1.45 * sc : CHEST;
    if (!segHit(from, to, chestAt(n.mesh, _chest, lift), r)) continue;
    stickArrow(arrow, n.mesh, n.kind === 'camel' ? 0.4 : 0.22);
    if (arrow.own) {
      if (isNpcHost()) applyHit(n, 1);
      else netBroadcast({ t: 'nhit', id: n.id, n: 1 });
    }
    return true;
  }
  return false;
});
onNet('npc', (s, slot) => adopt(s, slot));
onNet('hello', (h, slot) => { if (h.npc) adopt(h.npc, slot); });
onNet('nhit', h => { if (isNpcHost()) applyHit(byId(h.id), h.n | 0); });
onNet('norder', h => {
  if (!isNpcHost()) return;
  const n = byId(h.id);
  if (n) applyOrder(n, h.where);
});
onNet('nact', h => {
  const n = byId(h.id);
  if (n) beginAct(n, h.what);
});
addHelloFields(() => (synced ? { npc: snapshot() } : {}));

const _talkMe = new THREE.Vector3(), _talkAt = new THREE.Vector3();
function withOrder(n, place) {
  const tail = {
    follow: ', идёт за тобой',
    home: ', идёт домой',
    door: ', идёт к двери и будет стоять',
    here: ', стоит где сказали',
    town: ', идёт в центр города',
    oasis: ', идёт к оазису',
    forest: ', идёт к опушке',
    lake: ', идёт к берегу',
  }[n.order];
  return tail ? place + tail : place;
}

// Кто из говорящих рядом: житель (внутри — только своего дома), погонщик. Верблюды молчат.
export function talkSnapshot(maxM) {
  _talkMe.copy(player.pos).normalize();
  const inside = player.inside ? player.inside.house : null;
  const out = [];
  for (const n of actors) {
    if (n.hp <= 0 || n.st === 'dead') continue;
    if (n.kind !== 'home' && n.kind !== 'herder') continue;
    if (n.kind === 'home' && n.st === 'in') {
      if (inside !== n.house) continue;
      out.push({
        id: n.id, kind: 'resident', name: `житель дома ${n.house}`,
        hp: n.hp, st: 'in', arcM: 1, place: withOrder(n, 'в своём доме'),
      });
      continue;
    }
    if (inside !== null || !n.mesh) continue;
    n.mesh.getWorldPosition(_talkAt);
    if (_talkAt.lengthSq() < 1) continue;
    const arcM = Math.round(_talkMe.angleTo(_talkAt.normalize()) * P.R * 10) / 10;
    if (arcM > maxM) continue;
    const resident = n.kind === 'home';
    const atOasis = resident && n.dir.lengthSq() > 0.5 && oasisDir.lengthSq() > 0.5
      && n.dir.angleTo(oasisDir) * P.R < 24;
    out.push({
      id: n.id,
      kind: resident ? 'resident' : 'herder',
      name: resident ? `житель дома ${n.house}` : 'погонщик',
      hp: n.hp,
      st: n.st,
      arcM,
      place: withOrder(n, atOasis ? 'у оазиса' : (resident ? 'на улице' : 'у каравана')),
    });
  }
  return out;
}

export function npcMouth(id, out) {
  const n = byId(id);
  if (!n || !n.mesh) return false;
  n.mesh.getWorldPosition(out);
  return out.lengthSq() > 1;
}

export function npcSummary() {
  return actors.map(n => ({
    id: n.id, kind: n.kind, hp: n.hp, st: n.st, house: n.house ?? null, order: n.order || null,
  }));
}
export function debugNpcHit(id = 0, k = 1) {
  const n = byId(id);
  if (!n) return null;
  if (isNpcHost()) applyHit(n, k);
  else netBroadcast({ t: 'nhit', id, n: k });
  return { id: n.id, hp: n.hp, st: n.st, haltAt: caravan.haltAt };
}
export function debugNpcOut(id = 0) {
  const n = byId(id);
  if (!n || n.st === 'dead' || !isNpcHost()) return n ? n.st : null;
  if (n.kind === 'herder') beginHerderTrip(n);
  else goOutside(n);
  return n.st;
}
