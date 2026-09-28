// Городок: постройки.
// Две улицы крест-накрест, по 4 дома в каждом квартале (1–3 этажа, балконы, цветные крыши),
// невысокая стена с воротами на концах улиц и башенками по углам. Каждый объект ставится на сферу
// отдельно (со своей нормалью), иначе на краях города они бы висели в воздухе из-за кривизны.
import * as THREE from 'three';
import { rand } from './state.js';
import { scene } from './scene.js';
import { fogify } from './fow.js';
import { surfaceR, radiusListeners } from './terrain.js';
import { townEz, townToDir, TOWN_H, TOWN_STREET, TOWN_WALL_H } from './world.js';
import { palette } from './props.js';

const townObjects = [];            // { group, x, z, yaw } — чтобы переставлять при смене радиуса
export const townObstacles = [];   // AABB в локальных координатах города: { x0, z0, x1, z1 } — читает player.js
// дома с метаданными — по ним house.js строит интерьеры и находит двери/балконы
export const houses = [];          // { idx, x, z, yaw, w, d, floors, doorX, balconies: [{ f, bx }], wallColor, roofColor }
// площадки, на которых можно стоять над землёй (балконы): AABB в координатах города + высота над стенкой
export const townPlatforms = [];   // { x0, z0, x1, z1, h, house, floor }
export const BALCONY_D = 1.0;      // глубина балкона (м) — плита выступает из фасада

// локальные координаты дома (начало — центр, фасад +Z) -> координаты города; yaw кратен 90°, как в buildTown
export function houseLocalToTown(h, lx, lz, out) {
  const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
  return out.set(h.x + lx * c + lz * s, h.z - lx * s + lz * c);
}
// направление в координатах города, куда смотрит фасад (+Z дома)
export function houseFacing(h, out) { return out.set(Math.sin(h.yaw), Math.cos(h.yaw)); }
const _v = new THREE.Vector2();
// дом, у входной двери которого стоит игрок (точка в 1 м перед дверью, радиус 1.4 м)
export function houseDoorNear(tx, tz) {
  for (const h of houses) {
    houseLocalToTown(h, h.doorX, h.d / 2 + 1.0, _v);
    if (Math.hypot(_v.x - tx, _v.y - tz) < 1.4) return h;
  }
  return null;
}
// площадка под точкой (x, z) города или null
// самая высокая площадка под точкой, не выше h + 0.05 (балконы разных этажей стоят друг над другом)
export function townPlatformAt(tx, tz, h = Infinity) {
  let best = null;
  for (const p of townPlatforms)
    if (tx >= p.x0 && tx <= p.x1 && tz >= p.z0 && tz <= p.z1 && p.h <= h + 0.05 && (!best || p.h > best.h)) best = p;
  return best;
}
const WALL_COLORS = [0xf1e3c8, 0xe9d5b3, 0xf6efe0, 0xd9c2a0, 0xf3d9c5, 0xe0e8f0];
const townWallMat = fogify(new THREE.MeshStandardMaterial({ color: 0xb9a98c, roughness: 1, flatShading: true }));
const townRailMat = fogify(new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: .7 }));
const townDoorMat = fogify(new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: .8 }));                       // дерево
const townGlassMat = fogify(new THREE.MeshStandardMaterial({ color: 0x8fc3e8, emissive: 0x3b6f95, emissiveIntensity: .35, roughness: .25 }));   // стекло

const _tt = new THREE.Vector3(), _tu = new THREE.Vector3(), _tf = new THREE.Vector3(), _tr = new THREE.Vector3(), _m0 = new THREE.Matrix4();
function placeTownObject(o) {
  const { group, x, z, yaw } = o;
  townToDir(x, z, _tt);
  group.position.copy(_tt).multiplyScalar(surfaceR(_tt) - 0.02);
  _tu.copy(_tt).negate();
  _tf.copy(townEz).addScaledVector(_tu, -townEz.dot(_tu)).normalize();   // "север" города в этой точке
  _tr.crossVectors(_tu, _tf);
  group.quaternion.setFromRotationMatrix(_m0.makeBasis(_tr, _tu, _tf));
  group.rotateY(yaw);
}
function addTownObject(group, x, z, yaw = 0) {
  const o = { group, x, z, yaw };
  townObjects.push(o);
  placeTownObject(o);
  scene.add(group);
  return o;
}
function addObstacle(cx, cz, w, d) {
  townObstacles.push({ x0: cx - w / 2, z0: cz - d / 2, x1: cx + w / 2, z1: cz + d / 2 });
}
radiusListeners.push(() => { for (const o of townObjects) placeTownObject(o); });

// дом: начало координат — на земле по центру, фасад смотрит в +Z
function makeHouse(w, d, floors, wallColor, roofColor) {
  const g = new THREE.Group();
  const H = floors * 3;
  const wall = fogify(new THREE.MeshStandardMaterial({ color: wallColor, roughness: .95 }));
  const roof = fogify(new THREE.MeshStandardMaterial({ color: roofColor, roughness: .8, flatShading: true }));
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, H, d), wall);
  body.position.y = H / 2;
  g.add(body);
  // крыша: четырёхскатная или плоская с парапетом
  if (rand() < 0.65) {
    // пирамида: конус с 4 гранями, повёрнутый на 45° (углы на ±0.707) и растянутый под прямоугольник со свесом
    const rh = 1.6 + rand();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1, rh, 4), roof);
    cone.rotation.y = Math.PI / 4;
    cone.scale.set((w / 2 + 0.35) / Math.SQRT1_2, 1, (d / 2 + 0.35) / Math.SQRT1_2);
    cone.position.y = H + rh / 2;
    g.add(cone);
  } else {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.3, d + 0.4), roof);
    slab.position.y = H + 0.15;
    g.add(slab);
    const parapet = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.5, 0.2), roof);
    parapet.position.set(0, H + 0.55, d / 2 + 0.1);
    g.add(parapet);
  }
  // дверь и окна на фасаде
  const doorX = (rand() - 0.5) * (w - 2);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2, 0.12), townDoorMat);
  door.position.set(doorX, 1, d / 2 + 0.05);
  g.add(door);
  // балконы на верхних этажах (и балконная дверь за ними — через неё выходят изнутри)
  const balconies = [];
  for (let f = 1; f < floors; f++) {
    if (rand() < 0.3) continue;
    const bx = (rand() < 0.5 ? -1 : 1) * w / 4;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.14, BALCONY_D), wall);
    slab.position.set(bx, f * 3 + 0.07, d / 2 + BALCONY_D / 2);
    const railF = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 0.06), townRailMat);
    railF.position.set(bx, f * 3 + 0.5, d / 2 + BALCONY_D - 0.03);
    const railGeo = new THREE.BoxGeometry(0.06, 0.7, BALCONY_D);
    const railL = new THREE.Mesh(railGeo, townRailMat); railL.position.set(bx - 0.87, f * 3 + 0.5, d / 2 + BALCONY_D / 2);
    const railR = new THREE.Mesh(railGeo, townRailMat); railR.position.set(bx + 0.87, f * 3 + 0.5, d / 2 + BALCONY_D / 2);
    const bdoor = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.9, 0.1), townDoorMat);
    bdoor.position.set(bx, f * 3 + 1.1, d / 2 + 0.04);
    g.add(slab, railF, railL, railR, bdoor);
    balconies.push({ f, bx });
  }
  // окна на фасаде — после балконов (rand() не тратят), чтобы не ставить их поверх дверей
  const winGeo = new THREE.BoxGeometry(0.7, 0.9, 0.12);
  for (let f = 0; f < floors; f++) {
    for (const sx of [-1, 1]) {
      const wx = sx * w / 4;
      if (f === 0 && Math.abs(wx - doorX) < 0.9) continue;                              // входная дверь
      if (balconies.some(b => b.f === f && Math.abs(b.bx - wx) < 0.9)) continue;          // балконная дверь
      const win = new THREE.Mesh(winGeo, townGlassMat);
      win.position.set(wx, f * 3 + 1.8, d / 2 + 0.05);
      g.add(win);
    }
  }
  return { group: g, doorX, balconies };
}

// шаг сборки мира (после пропсов, до каравана — порядок rand() важен)
export function buildTown() {
  // дома: в каждом квартале 2×2 участка, фасадом к ближайшей улице
  const slots = [TOWN_STREET / 2 + 4.2, TOWN_STREET / 2 + 11.5];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const cx of slots) for (const cz of slots) {
    const w = 4 + rand() * 2.2, d = 4 + rand() * 2.2;
    const floors = 1 + Math.floor(rand() * 3);
    const wallColor = WALL_COLORS[Math.floor(rand() * WALL_COLORS.length)];
    const roofColor = palette[Math.floor(rand() * palette.length)];
    const house = makeHouse(w, d, floors, wallColor, roofColor);
    const x = sx * cx, z = sz * cz;
    // фасад — к ближайшей улице: yaw поворачивает +Z в направлении v
    const v = cx < cz ? [-sx, 0] : [0, -sz];
    const yaw = Math.atan2(v[0], v[1]);
    addTownObject(house.group, x, z, yaw);
    // AABB: дом повёрнут на кратное 90°, поэтому при повороте на ±90° w и d меняются местами
    const swap = Math.abs(v[0]) > 0;
    addObstacle(x, z, swap ? d : w, swap ? w : d);
    const h = { idx: houses.length, x, z, yaw, w, d, floors, doorX: house.doorX, balconies: house.balconies, wallColor, roofColor };
    houses.push(h);
    // балконы — площадки: плита 1.8 × BALCONY_D перед фасадом; высота над стенкой = верх плиты (+0.02 — дом стоит чуть над ней)
    const a = new THREE.Vector2(), b = new THREE.Vector2();
    for (const { f, bx } of house.balconies) {
      houseLocalToTown(h, bx - 0.9, d / 2, a);
      houseLocalToTown(h, bx + 0.9, d / 2 + BALCONY_D, b);
      townPlatforms.push({ x0: Math.min(a.x, b.x), z0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), z1: Math.max(a.y, b.y), h: f * 3 + 0.16, house: h, floor: f });
    }
  }
  // стена: сегменты по 4 м, ворота шириной 7 м на концах улиц
  const seg = 4, half = TOWN_H, gate = 3.5;
  for (let c = -half + seg / 2; c < half; c += seg) {
    if (Math.abs(c) < gate) continue;
    for (const s of [-1, 1]) {
      const wz = new THREE.Mesh(new THREE.BoxGeometry(seg + 0.15, TOWN_WALL_H, 0.8), townWallMat);
      wz.position.y = TOWN_WALL_H / 2;
      addTownObject(new THREE.Group().add(wz), c, s * half, 0);
      addObstacle(c, s * half, seg + 0.15, 0.8);
      const wx = new THREE.Mesh(new THREE.BoxGeometry(0.8, TOWN_WALL_H, seg + 0.15), townWallMat);
      wx.position.y = TOWN_WALL_H / 2;
      addTownObject(new THREE.Group().add(wx), s * half, c, 0);
      addObstacle(s * half, c, 0.8, seg + 0.15);
    }
  }
  // угловые башенки и столбы ворот
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(2, 3.4, 2), townWallMat);
    t.position.y = 1.7;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.6, 1.2, 4), fogify(new THREE.MeshStandardMaterial({ color: 0x8c3b2e, flatShading: true })));
    cap.position.y = 4.0; cap.rotation.y = Math.PI / 4;
    addTownObject(new THREE.Group().add(t, cap), sx * half, sz * half, 0);
    addObstacle(sx * half, sz * half, 2, 2);
  }
  for (const s of [-1, 1]) for (const g of [-gate, gate]) {
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 1), townWallMat); p1.position.y = 1.5;
    addTownObject(new THREE.Group().add(p1), g, s * half, 0);
    addObstacle(g, s * half, 1, 1);
    const p2 = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 1), townWallMat); p2.position.y = 1.5;
    addTownObject(new THREE.Group().add(p2), s * half, g, 0);
    addObstacle(s * half, g, 1, 1);
  }
}
