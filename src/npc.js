// Жители домов и погонщики каравана.
// Один тип актёра. «Дома» — свой дом или караван. Житель в основном внутри и иногда выходит на улицы города;
// погонщик в основном идёт рядом с караваном и иногда отходит на несколько метров. Состояние follow зарезервировано
// и пока не используется. Стрелять можно только снаружи: внутри дома лук и так не стреляет, а житель в доме
// для стрелы недосягаем. 5 попаданий — смерть, без множителя в голову. Трупы лежат до конца сессии, заново не появляются.
// Не дерутся. Хозяин комнаты (младший синхронизированный слот, как у медведракона) симулирует и шлёт снимок ~10 Гц.
// Когда мертвы все погонщики, караван замирает на отметке мирового времени — скорость каравана не обнуляется,
// уже оседланный верблюд едет дальше.
import * as THREE from 'three';
import { ROOM, WORLD_SEED, hash32, mulberry32, player, clock } from './state.js';
import { P } from './params.js';
import { scene } from './scene.js';
import { surfaceR } from './terrain.js';
import { townToDir, dirToTown, TOWN_H, TOWN_STREET } from './world.js';
import { houses, houseLocalToTown, townObstacles } from './town.js';
import { ensureInterior, interiorMove } from './house.js';
import { caravan, worldTime, haltCaravan, releaseCaravan } from './caravan.js';
import { onArrowHit } from './bow.js';
import { net, netBroadcast, onNet, addHelloFields } from './net.js';

export const NPC_HP = 5;
const SYNC_ALONE_T = 6;
const SNAP_DT = 0.1;
const IN_SPEED = 1.3;
const OUT_SPEED = 1.6;
const HERD_SPEED = 1.5;
const HERD_BACK = 3.6;
const BODY_R = 0.55;
const CHEST = 1.05;

const ROBES = [0x3d5a80, 0x6b4f3a, 0x8c3a3a, 0x3f6b4a, 0xc4a574, 0x4a3f6b, 0x7a5b3a, 0x355e52];
const CAPS = [0xd8c7a1, 0x2c2a28, 0x8d3b3b, 0x1f3a5f, 0xe8e0d0];

const actors = [];
const homeNpcs = [];
const herderNpcs = [];
let synced = !ROOM;
let snapAcc = 0;

const lowestSlot = () => Math.min(net.slot < 0 ? Infinity : net.slot, ...net.remotes.keys());
export const isNpcHost = () => !ROOM || (synced && (net.slot < 0 ? net.remotes.size === 0 : lowestSlot() === net.slot));

const _up = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const _m = new THREE.Matrix4(), _axis = new THREE.Vector3(), _before = new THREE.Vector3();
const _v2 = new THREE.Vector2(), _v2b = new THREE.Vector2();
const _chest = new THREE.Vector3(), _ab = new THREE.Vector3(), _hit = new THREE.Vector3();

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
    const mid0 = caravan.camels[Math.floor(caravan.camels.length / 2)];
    if (mid0 && mid0.group.position.lengthSq() > 1) n.goalDir.copy(mid0.group.position).normalize();
    else { n.st = 'in'; n.herder.st = 'in'; n.wait = 8; return; }
  }
  if (n.phase === 'stand') {
    n.wait -= dt;
    n.moving = false;
    if (n.wait <= 0) { n.phase = 'back'; n.backT = 0; }
    return;
  }
  if (n.phase === 'back') {
    const mid = caravan.camels[Math.floor(caravan.camels.length / 2)];
    if (mid && mid.group.position.lengthSq() > 1) n.goalDir.copy(mid.group.position).normalize();
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
  n.hp = 0;
  n.st = 'dead';
  n.moving = false;
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
  if (n.kind === 'herder') return n.st === 'in' || n.st === 'out';
  return n.st === 'out';
}
function chestAt(mesh, out) {
  mesh.updateWorldMatrix(true, false);
  mesh.getWorldPosition(out);
  _up.copy(out);
  if (_up.lengthSq() < 1e-6) return out;
  _up.normalize().negate();
  return out.addScaledVector(_up, CHEST);
}
function segHit(from, to, center, r) {
  _ab.copy(to).sub(from);
  const len2 = _ab.lengthSq();
  const t = len2 > 1e-8 ? THREE.MathUtils.clamp(_hit.copy(center).sub(from).dot(_ab) / len2, 0, 1) : 0;
  return _hit.copy(from).addScaledVector(_ab, t).distanceToSquared(center) <= r * r;
}

const r4 = v => Math.round(v * 1e4) / 1e4;
function pack(n) {
  const st = n.st === 'in' ? 0 : n.st === 'out' ? 1 : 2;
  if (n.kind === 'herder' && n.st === 'in') return [n.id, n.hp, st];
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
  if (n.kind === 'herder') {
    if (n.st === 'in') return;
    if (n.dir.lengthSq() < 0.5) return;
    attach(n.mesh, scene);
    n.mesh.visible = true;
    placeOnWall(n.mesh, n.dir, n.face);
    if (n.st === 'dead') n.mesh.rotateZ(Math.PI / 2);
    gait(n.herder, n.moving, n.herder.gaitPhase || 0, n.st === 'dead');
    return;
  }
  if (n.st === 'in') {
    attach(n.mesh, n.it.group);
    n.mesh.visible = !!(player.inside && player.inside.house === n.house);
    n.mesh.position.set(n.pos.x, n.pos.y, n.pos.z);
    n.mesh.rotation.set(0, n.yaw, 0);
    gait(n.parts, n.moving, n.phase, false);
    return;
  }
  attach(n.mesh, scene);
  n.mesh.visible = n.dir.lengthSq() > 0.5;
  if (!n.mesh.visible) return;
  placeOnWall(n.mesh, n.dir, n.face);
  if (n.st === 'dead') n.mesh.rotateZ(Math.PI / 2);
  gait(n.parts, n.moving, n.phase, n.st === 'dead');
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
      outLeft: 0, goalT: 0, phase: rng() * Math.PI * 2, moving: false,
    };
    interiorMove(it, n.pos, 0, 0);
    n.tpos.copy(n.pos);
    actors.push(n);
    homeNpcs.push(n);
  }
  caravan.herders.forEach((h, i) => {
    h.st = 'in';
    h.hp = NPC_HP;
    const n = {
      id: 100 + i, kind: 'herder', hp: NPC_HP, st: 'in', herder: h, mesh: h.group,
      dir: new THREE.Vector3(), face: new THREE.Vector3(), goalDir: new THREE.Vector3(), tdir: new THREE.Vector3(),
      phase: 'go', wait: 12 + i * 6 + Math.random() * 18, backT: 0, moving: false,
    };
    actors.push(n);
    herderNpcs.push(n);
  });
}

export function updateNpc(dt) {
  if (dt <= 0 || !actors.length) return;
  considerSync();
  const host = isNpcHost();
  if (host) {
    for (const n of homeNpcs) if (n.st !== 'dead') (n.st === 'out' ? simStreet(n, dt) : simIndoor(n, dt));
    for (const n of herderNpcs) if (n.st !== 'dead') simHerder(n, dt);
    snapAcc += dt;
    if (ROOM && synced && snapAcc >= SNAP_DT && net.conns.size) {
      snapAcc = 0;
      netBroadcast(Object.assign({ t: 'npc' }, snapshot()));
    }
  } else {
    for (const n of actors) blendRemote(n, dt);
  }
  for (const n of actors) showActor(n);
}

onArrowHit((from, to, arrow) => {
  for (const n of actors) {
    if (!outdoors(n) || n.mesh.parent !== scene) continue;
    if (segHit(from, to, chestAt(n.mesh, _chest), BODY_R)) {
      if (arrow.own) {
        if (isNpcHost()) applyHit(n, 1);
        else netBroadcast({ t: 'nhit', id: n.id, n: 1 });
      }
      return true;
    }
  }
  return false;
});
onNet('npc', (s, slot) => adopt(s, slot));
onNet('hello', (h, slot) => { if (h.npc) adopt(h.npc, slot); });
onNet('nhit', h => { if (isNpcHost()) applyHit(byId(h.id), h.n | 0); });
addHelloFields(() => (synced ? { npc: snapshot() } : {}));

export function npcSummary() {
  return actors.map(n => ({ id: n.id, kind: n.kind, hp: n.hp, st: n.st, house: n.house ?? null }));
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
