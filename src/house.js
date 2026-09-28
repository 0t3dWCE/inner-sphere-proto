// Интерьеры домов.
// Пробел у входной двери (или стоя на балконе) — игрок оказывается внутри: это отдельная сцена houseScene с плоским
// полом и обычной гравитацией вниз. «Внутри» дом больше, чем снаружи (ширина/глубина × 1.7–2.6, у каждого свой
// коэффициент), этажей столько же, между ними лестницы вдоль боковых стен (чередуются: левая, правая). Комнаты разделены перегородками
// с проёмами, мебель расставлена случайно, обои свои на каждом этаже, у каждого дома — своя «особенность».
// Всё генерируется из seed'а мира и номера дома (rand() мира не трогаем), поэтому у всех в комнате одинаково.
// Выход — через входную дверь (появляемся перед ней) или через балконную дверь (появляемся на балконе снаружи).
// Пока игрок внутри, мир живёт дальше (караван, сеть), рендерится только houseScene; аватар у остальных скрыт.
import * as THREE from 'three';
import { WORLD_SEED, hash32, mulberry32, player } from './state.js';
import { P } from './params.js';
import { camera } from './scene.js';
import { townToDir } from './world.js';
import { houses, houseLocalToTown, houseDoorNear, BALCONY_D } from './town.js';
import { onSpace, setPlayerOverride, townXZ, nearTown, platform, keys } from './player.js';

export const houseScene = new THREE.Scene();
houseScene.background = new THREE.Color(0x14141a);
houseScene.add(new THREE.AmbientLight(0xffffff, 0.35));
houseScene.add(new THREE.HemisphereLight(0xfff4e0, 0x6a5a4a, 0.45));

const FH = 3.2;        // высота этажа
const EYE_IN = 1.6;    // глаза над полом
const RAD = 0.35;      // радиус игрока для коллизий
const BODY_H = 1.7;

// active: { h, it, pos (ноги), yaw, pitch, vy, grounded } — либо null; hint — подсказка для HUD
export const house = { active: null, hint: '' };
const built = new Map();   // idx -> интерьер

// ---------- текстуры ----------
function makeWallpaper(rng) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const hue = rng() * 360;
  const base = `hsl(${hue.toFixed(0)},${(25 + rng() * 30).toFixed(0)}%,${(68 + rng() * 17).toFixed(0)}%)`;
  const acc = `hsl(${((hue + (rng() < 0.5 ? 30 : 180)) % 360).toFixed(0)},${(35 + rng() * 35).toFixed(0)}%,${(40 + rng() * 22).toFixed(0)}%)`;
  g.fillStyle = base; g.fillRect(0, 0, 256, 256);
  g.fillStyle = acc; g.strokeStyle = acc;
  const kind = Math.floor(rng() * 6);
  if (kind === 0) {            // полоски
    for (let x = 0; x < 256; x += 32) g.fillRect(x, 0, 10, 256);
  } else if (kind === 1) {     // горошек
    for (let y = 16; y < 256; y += 32) for (let x = 16 + (y % 64 ? 16 : 0); x < 256; x += 32) { g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); }
  } else if (kind === 2) {     // ромбы
    g.lineWidth = 3;
    for (let i = -256; i < 512; i += 48) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 256, 256); g.stroke(); g.beginPath(); g.moveTo(i + 256, 0); g.lineTo(i, 256); g.stroke(); }
  } else if (kind === 3) {     // клетка
    g.lineWidth = 2;
    for (let i = 0; i < 256; i += 32) { g.fillRect(i, 0, 2, 256); g.fillRect(0, i, 256, 2); }
  } else if (kind === 4) {     // гладкие с панелью внизу
    g.fillRect(0, 200, 256, 56); g.fillStyle = base; g.fillRect(0, 206, 256, 4);
  } else {                     // «цветочки»: кольца
    g.lineWidth = 3;
    for (let y = 24; y < 256; y += 48) for (let x = 24; x < 256; x += 48) { g.beginPath(); g.arc(x, y, 9, 0, 7); g.stroke(); g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function makePlanks(rng) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const hue = 20 + rng() * 20, l = 30 + rng() * 25;
  g.fillStyle = `hsl(${hue},45%,${l}%)`; g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 32) {
    g.fillStyle = `hsl(${hue},40%,${l + (rng() - 0.5) * 10}%)`; g.fillRect(0, y, 256, 30);
    g.fillStyle = `hsl(${hue},45%,${l - 12}%)`; g.fillRect(0, y + 30, 256, 2);
    const seam = Math.floor(rng() * 256); g.fillRect(seam, y, 2, 30);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function texMat(tex, rx, ry, extra = {}) {
  const map = tex.clone(); map.repeat.set(rx, ry); map.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ map, roughness: .95, ...extra });
}
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: .85, ...extra });

// ---------- генерация интерьера ----------
// Система координат интерьера: начало — центр дома на полу первого этажа, +Z — фасад (там входная дверь и балконы),
// пол этажа f на y = f·FH.
function buildInterior(h) {
  const rng = mulberry32(WORLD_SEED ^ hash32('house:' + h.idx));
  const kx = 1.7 + rng() * 0.9, kz = 1.7 + rng() * 0.9;
  const W = Math.round(h.w * kx * 10) / 10, D = Math.round(h.d * kz * 10) / 10;
  const { floors } = h;
  const g = new THREE.Group();
  const obstacles = [];   // { x0, z0, x1, z1, y0, y1 }
  const stairs = [];      // { f, x0, x1, z0, z1 } — подъём с этажа f вдоль +Z от z0 (низ) к z1 (верх)
  const exits = [];       // { kind: 'door' | 'balcony', x, z, f, bx }
  const lights = [];
  const box = (w, hh, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat); m.position.set(x, y, z); g.add(m); return m; };
  const block = (x0, z0, x1, z1, y0, y1) => obstacles.push({ x0, z0, x1, z1, y0, y1 });

  const planks = makePlanks(rng);
  const ceilMat = std(0xf4f1ea);
  const trimMat = std(0x5a4632);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xdfeefb, emissive: 0xcfe3f5, emissiveIntensity: 1.1, roughness: .3 });
  const doorMat = std(0x4a2f1e);

  // лестницы: снизу (−Z) вверх (+Z) вдоль боковой стены; этажи чередуют стену (1→2 у левой, 2→3 у правой),
  // иначе вторая лестница встала бы ровно над проёмом первой и упёрлась в его ограждение
  const SW = 1.3;   // ширина лестницы
  // первая ступень в 1.6 м от задней стены — свободная площадка, чтобы зайти на лестницу лицом к ней
  const sz0 = -D / 2 + 1.6, L = Math.min(4.8, D - 4.2), sz1 = sz0 + L;
  const stairGeo = f => {                       // геометрия лестницы, ведущей с этажа f на f+1
    const side = f % 2 === 0 ? -1 : 1;
    const x0 = side < 0 ? -W / 2 + 0.2 : W / 2 - 0.2 - SW, x1 = x0 + SW;
    return { f, side, x0, x1, z0: sz0, z1: sz1, ix: side < 0 ? x1 : x0 };   // ix — внутренний (открытый) край
  };

  // «особенность» дома — что-то одно, заметное, на первом этаже у задней стены (до мебели: она её обойдёт)
  addSpecial(h, rng, { W, D, box, block, g, lights });

  for (let f = 0; f < floors; f++) {
    const y0 = f * FH;
    const paper = makeWallpaper(rng);
    const up = f < floors - 1 ? stairGeo(f) : null;      // лестница с этого этажа наверх
    const hole = f > 0 ? stairGeo(f - 1) : null;          // проём в полу над лестницей снизу
    // пол: сплошной на 1 этаже, выше — с проёмом над лестницей
    const floorMat = texMat(planks, W / 2, D / 2);
    let slabs;
    if (!hole) slabs = [[-W / 2, -D / 2, W / 2, D / 2]];
    else {
      const hx0 = hole.side < 0 ? -W / 2 : hole.x0, hx1 = hole.side < 0 ? hole.x1 : W / 2;
      slabs = [[-W / 2, -D / 2, W / 2, hole.z0], [-W / 2, hole.z1, W / 2, D / 2], [-W / 2, hole.z0, hx0, hole.z1], [hx1, hole.z0, W / 2, hole.z1]];
    }
    for (const [x0, z0, x1, z1] of slabs) {
      if (x1 - x0 < 0.05 || z1 - z0 < 0.05) continue;
      box(x1 - x0, 0.12, z1 - z0, floorMat, (x0 + x1) / 2, y0 - 0.06, (z0 + z1) / 2);
    }
    // потолок последнего этажа
    if (f === floors - 1) box(W, 0.12, D, ceilMat, 0, y0 + FH + 0.06, 0);
    // стены с обоями (перед фасадом — окна/двери)
    const wallMat = (len) => texMat(paper, len / 2.4, FH / 2.4);
    box(W, FH, 0.2, wallMat(W), 0, y0 + FH / 2, -D / 2 + 0.1);        // задняя
    box(W, FH, 0.2, wallMat(W), 0, y0 + FH / 2, D / 2 - 0.1);         // фасад
    box(0.2, FH, D, wallMat(D), -W / 2 + 0.1, y0 + FH / 2, 0);        // левая
    box(0.2, FH, D, wallMat(D), W / 2 - 0.1, y0 + FH / 2, 0);         // правая
    // плинтус
    box(W, 0.12, 0.04, trimMat, 0, y0 + 0.06, -D / 2 + 0.22); box(W, 0.12, 0.04, trimMat, 0, y0 + 0.06, D / 2 - 0.22);
    box(0.04, 0.12, D, trimMat, -W / 2 + 0.22, y0 + 0.06, 0); box(0.04, 0.12, D, trimMat, W / 2 - 0.22, y0 + 0.06, 0);
    // окна: на фасаде ±W/4 (кроме места балконной двери), по одному на боковых стенах и на задней
    const balc = h.balconies.find(b => b.f === f);
    const bxIn = balc ? balc.bx * kx : null;
    for (const wx of [-W / 4, W / 4]) {
      if (bxIn !== null && Math.abs(wx - bxIn) < 1.2) continue;
      if (f === 0 && Math.abs(wx - h.doorX * kx) < 1.2) continue;   // не поверх входной двери
      box(1.1, 1.3, 0.06, glassMat, wx, y0 + 1.7, D / 2 - 0.22);
      box(1.3, 0.08, 0.16, trimMat, wx, y0 + 1.02, D / 2 - 0.24);   // подоконник
    }
    box(1.1, 1.3, 0.06, glassMat, -W / 4, y0 + 1.7, -D / 2 + 0.22);
    box(0.06, 1.3, 1.1, glassMat, W / 2 - 0.22, y0 + 1.7, D / 2 - 1.3);    // боковые: у фасада, подальше от лестниц
    box(0.06, 1.3, 1.1, glassMat, -W / 2 + 0.22, y0 + 1.7, D / 2 - 1.3);
    // входная дверь (1 этаж) и балконные двери
    if (f === 0) {
      const dx = h.doorX * kx;
      box(1.0, 2.1, 0.08, doorMat, dx, y0 + 1.05, D / 2 - 0.23);
      box(1.2, 0.1, 0.12, trimMat, dx, y0 + 2.15, D / 2 - 0.23);
      const knob = box(0.08, 0.08, 0.08, std(0xd4af37, { metalness: .8, roughness: .3 }), dx + 0.35, y0 + 1.0, D / 2 - 0.3);
      knob.name = 'knob';
      exits.push({ kind: 'door', x: dx, z: D / 2 - 0.9, f });
    }
    if (balc) {
      box(0.9, 2.0, 0.06, glassMat, bxIn, y0 + 1.05, D / 2 - 0.22);
      box(1.1, 2.15, 0.1, trimMat, bxIn, y0 + 1.07, D / 2 - 0.19);
      box(0.9, 2.0, 0.07, glassMat, bxIn, y0 + 1.05, D / 2 - 0.2);
      exits.push({ kind: 'balcony', x: bxIn, z: D / 2 - 0.9, f, bx: balc.bx });
    }
    // потолочный светильник
    const lamp = new THREE.PointLight(0xfff1dc, 8 + W * D * 0.12, 0, 2);
    lamp.position.set(0, y0 + FH - 0.35, 0);
    g.add(lamp); lights.push(lamp);
    box(0.5, 0.12, 0.5, std(0xfff7e0, { emissive: 0xfff1c0, emissiveIntensity: .9 }), 0, y0 + FH - 0.1, 0);

    // лестница наверх
    if (up) {
      const { x0: sx0, x1: sx1, ix, side } = up;
      const N = 14, stepD = L / N, stepH = FH / N;
      const stepMat = texMat(planks, 1, 0.3);
      for (let i = 0; i < N; i++)
        box(SW, stepH, stepD, stepMat, (sx0 + sx1) / 2, y0 + stepH * (i + 0.5), sz0 + stepD * (i + 0.5));
      // перила с внутренней стороны (наклонный брус) и стойки
      const rx = ix - side * 0.02;
      const rail = box(0.06, 0.08, Math.hypot(L, FH), trimMat, rx, y0 + FH / 2 + 0.95, (sz0 + sz1) / 2);
      rail.rotation.x = -Math.atan2(FH, L);
      for (let i = 0; i <= 4; i++) box(0.05, 0.95, 0.05, trimMat, rx, y0 + FH * i / 4 + 0.47, sz0 + L * i / 4);
      block(Math.min(ix - side * 0.05, ix + side * 0.08), sz0 + 0.3, Math.max(ix - side * 0.05, ix + side * 0.08), sz1, y0, y0 + FH - 0.3);   // не сойти вбок
      // чулан под лестницей — чтобы не заходить под ступени с верхнего конца (блок только для стоящих на полу)
      box(SW, 1.8, 1.0, trimMat, (sx0 + sx1) / 2, y0 + 0.9, sz1 - 0.5);
      block(sx0, sz1 - 1.0, sx1, sz1, y0, y0 + 1.8);
      stairs.push({ f, x0: sx0, x1: sx1, z0: sz0, z1: sz1, side });
    }
    // ограждение проёма над лестницей снизу: вдоль открытого края и поперёк у нижнего конца
    if (hole) {
      const { x0: hx0, x1: hx1, ix, side } = hole;
      const rx = ix - side * 0.02;
      box(0.06, 0.9, L, trimMat, rx, y0 + 0.45, (sz0 + sz1) / 2);
      box(SW, 0.9, 0.06, trimMat, (hx0 + hx1) / 2, y0 + 0.45, sz0 - 0.03);
      block(Math.min(ix - side * 0.05, ix + side * 0.08), sz0 - 0.1, Math.max(ix - side * 0.05, ix + side * 0.08), sz1, y0, y0 + 1.0);
      block(side < 0 ? -W / 2 : hx0, sz0 - 0.1, side < 0 ? hx1 : W / 2, sz0, y0, y0 + 1.0);
    }

    // зона мебели по X: вдоль лестницы и вдоль проёма — свободный проход ≥ 1 м
    const leftBusy = (up && up.side < 0) || (hole && hole.side < 0), rightBusy = (up && up.side > 0) || (hole && hole.side > 0);
    const xMin = leftBusy ? -W / 2 + 0.2 + SW + 1.1 : -W / 2 + 0.3;
    const xMax = rightBusy ? W / 2 - 0.2 - SW - 1.1 : W / 2 - 0.3;
    // перегородки: поперёк (вдоль X) с проёмом; в широких домах ещё одна вдоль Z
    const partMat = () => texMat(paper, 2, FH / 2.4);
    const roomZones = [];   // запретные зоны для мебели: дверные проёмы и перед выходами
    let zp = null;
    if (D >= 7 && xMax - xMin >= 3.2) {
      zp = -D / 2 + 2.8 + rng() * (D - 5.6);
      const px0 = leftBusy ? xMin : -W / 2 + 0.2, px1 = rightBusy ? xMax : W / 2 - 0.2;   // от стены до стены, кроме проходов
      const gapX = xMin + 1.0 + rng() * (xMax - xMin - 2.0);
      const pieces = [[px0, gapX - 0.7], [gapX + 0.7, px1]];   // проём 1.4 м
      for (const [x0, x1] of pieces) {
        if (x1 - x0 < 0.1) continue;
        box(x1 - x0, FH, 0.15, partMat(), (x0 + x1) / 2, y0 + FH / 2, zp);
        block(x0, zp - 0.08, x1, zp + 0.08, y0, y0 + FH);
      }
      box(1.5, 0.1, 0.2, trimMat, gapX, y0 + 2.15, zp);   // притолока
      roomZones.push({ x0: gapX - 1.3, z0: zp - 1.5, x1: gapX + 1.3, z1: zp + 1.5 });
      if (xMax - xMin >= 7) {
        const side = rng() < 0.5 ? -1 : 1;                 // половина по Z, где будет вторая стена
        const xp = xMin + 2.5 + rng() * (xMax - xMin - 5.0);
        const z0 = side < 0 ? -D / 2 + 0.2 : zp + 0.08, z1 = side < 0 ? zp - 0.08 : D / 2 - 0.2;
        const gapZ = z0 + 1.0 + rng() * (z1 - z0 - 2.0);
        for (const [a, b] of [[z0, gapZ - 0.7], [gapZ + 0.7, z1]]) {
          if (b - a < 0.1) continue;
          box(0.15, FH, b - a, partMat(), xp, y0 + FH / 2, (a + b) / 2);
          block(xp - 0.08, a, xp + 0.08, b, y0, y0 + FH);
        }
        roomZones.push({ x0: xp - 1.5, z0: gapZ - 1.3, x1: xp + 1.5, z1: gapZ + 1.3 });
      }
    }
    for (const e of exits) if (e.f === f) roomZones.push({ x0: e.x - 1.2, z0: e.z - 1.4, x1: e.x + 1.2, z1: D / 2 });
    if (up) roomZones.push({ x0: up.x0 - 0.8, z0: sz0 - 1.5, x1: up.x1 + 0.8, z1: sz1 + 1.5 });        // подход к лестнице
    if (hole) roomZones.push({ x0: hole.x0 - 0.8, z0: sz0 - 0.3, x1: hole.x1 + 0.8, z1: sz1 + 1.6 });  // выход с лестницы

    // мебель
    placeFurniture(f, y0, rng, { W, D, box, block, obstacles, roomZones, g, xMin, xMax, leftWall: !leftBusy, rightWall: !rightBusy, lights });
  }

  return { h, group: g, W, D, floors, obstacles, stairs, exits, kx };
}

function placeFurniture(f, y0, rng, ctx) {
  const { W, D, box, block, obstacles, roomZones, g, xMin, xMax, leftWall, rightWall } = ctx;
  const woods = [0x8b5a2b, 0x6f4e37, 0xa47148, 0x4b3621];
  const cloths = [0x9b2226, 0x005f73, 0x6a994e, 0xbc6c25, 0x5e548e, 0xe07a5f];
  const wood = () => std(woods[Math.floor(rng() * woods.length)]);
  const cloth = () => std(cloths[Math.floor(rng() * cloths.length)]);
  const kinds = [
    { w: 1.6, d: 2.0, build(x, z, m) {   // стол со стульями (габарит — вместе со стульями)
      box(1.6, 0.06, 0.9, m, x, y0 + 0.76, z);
      for (const [dx, dz] of [[-0.7, -0.35], [0.7, -0.35], [-0.7, 0.35], [0.7, 0.35]]) box(0.07, 0.75, 0.07, m, x + dx, y0 + 0.37, z + dz);
      for (const dz of [-0.8, 0.8]) { box(0.45, 0.06, 0.45, m, x, y0 + 0.46, z + dz); box(0.45, 0.5, 0.06, m, x, y0 + 0.74, z + dz + Math.sign(dz) * 0.2); }
      return [x - 0.8, z - 1.0, x + 0.8, z + 1.0];
    } },
    { w: 1.5, d: 2.1, build(x, z, m) {   // кровать
      box(1.5, 0.35, 2.1, m, x, y0 + 0.2, z);
      box(1.4, 0.2, 1.9, cloth(), x, y0 + 0.47, z);
      box(1.2, 0.15, 0.4, std(0xf6f2ea), x, y0 + 0.65, z - 0.75);
      box(1.5, 0.9, 0.08, m, x, y0 + 0.5, z - 1.05);
      return [x - 0.75, z - 1.1, x + 0.75, z + 1.05];
    } },
    { w: 1.2, d: 0.6, build(x, z, m) {   // шкаф
      box(1.2, 2.1, 0.6, m, x, y0 + 1.05, z);
      box(0.05, 0.3, 0.04, std(0xd4af37), x - 0.05, y0 + 1.1, z + 0.32); box(0.05, 0.3, 0.04, std(0xd4af37), x + 0.05, y0 + 1.1, z + 0.32);
      return [x - 0.6, z - 0.3, x + 0.6, z + 0.3];
    } },
    { w: 1.0, d: 0.35, build(x, z, m) {   // книжный стеллаж
      box(1.0, 1.9, 0.35, m, x, y0 + 0.95, z);
      for (let s = 0; s < 4; s++) for (let b = 0; b < 6; b++) box(0.12, 0.25 + rng() * 0.1, 0.22, cloth(), x - 0.4 + b * 0.16, y0 + 0.32 + s * 0.45, z + 0.02);
      return [x - 0.5, z - 0.2, x + 0.5, z + 0.2];
    } },
    { w: 1.9, d: 0.85, build(x, z, m) {   // диван
      const c = cloth();
      box(1.9, 0.45, 0.85, c, x, y0 + 0.25, z); box(1.9, 0.5, 0.25, c, x, y0 + 0.7, z - 0.3);
      box(0.2, 0.3, 0.85, c, x - 0.85, y0 + 0.6, z); box(0.2, 0.3, 0.85, c, x + 0.85, y0 + 0.6, z);
      return [x - 0.95, z - 0.45, x + 0.95, z + 0.45];
    } },
    { w: 0.6, d: 0.6, build(x, z) {   // растение в кадке
      box(0.5, 0.5, 0.5, std(0xb5651d), x, y0 + 0.25, z);
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), std(0x3f7d3a)); leaf.position.set(x, y0 + 1.1, z); leaf.scale.y = 1.3; g.add(leaf);
      return [x - 0.3, z - 0.3, x + 0.3, z + 0.3];
    } },
    { w: 0.5, d: 0.5, build(x, z) {   // торшер
      box(0.05, 1.6, 0.05, std(0x333333), x, y0 + 0.8, z);
      box(0.4, 0.3, 0.4, std(0xfff2cc, { emissive: 0xffd28a, emissiveIntensity: .8 }), x, y0 + 1.7, z);
      const l = new THREE.PointLight(0xffd8a0, 2.5, 0, 2); l.position.set(x, y0 + 1.6, z); g.add(l); ctx.lights.push(l);
      return [x - 0.25, z - 0.25, x + 0.25, z + 0.25];
    } },
    { w: 2.2, d: 1.6, noBlock: true, build(x, z) {   // ковёр
      box(2.2, 0.02, 1.6, cloth(), x, y0 + 0.01, z);
      return null;
    } },
  ];
  // Проходимость: между любыми двумя препятствиями (мебель, перегородки, перила) остаётся ≥ GAP, к стене предмет
  // либо прижат (щель < 0.3 — туда всё равно не пройти), либо стоит от неё на ≥ GAP. Игрок — круг диаметром 0.7.
  const GAP = 1.0;
  const wallOk = d => d < 0.3 || d >= GAP;
  // xMin/xMax — зона мебели по X; если с той стороны стена (а не проход вдоль лестницы), к ней можно прижаться
  const fits = (x0, z0, x1, z1) => {
    if (x0 < xMin || x1 > xMax || z0 < -D / 2 + 0.2 || z1 > D / 2 - 0.2) return false;
    if (!wallOk(z0 + D / 2 - 0.2) || !wallOk(D / 2 - 0.2 - z1)) return false;
    if (leftWall && !wallOk(x0 + W / 2 - 0.2)) return false;
    if (rightWall && !wallOk(W / 2 - 0.2 - x1)) return false;
    for (const o of obstacles) if (o.y0 < y0 + FH && o.y1 > y0 && x0 < o.x1 + GAP && x1 > o.x0 - GAP && z0 < o.z1 + GAP && z1 > o.z0 - GAP) return false;
    for (const r of roomZones) if (x0 < r.x1 && x1 > r.x0 && z0 < r.z1 && z1 > r.z0) return false;
    return true;
  };
  const n = Math.round((xMax - xMin) * D / 16) + 1;
  for (let i = 0; i < n; i++) {
    const k = kinds[Math.floor(rng() * kinds.length)];
    if (xMax - xMin < k.w + 0.2) continue;
    for (let t = 0; t < 40; t++) {
      let x = xMin + k.w / 2 + rng() * (xMax - xMin - k.w);
      let z = -D / 2 + 0.2 + k.d / 2 + rng() * (D - k.d - 0.4);
      // прижать к стене, если оказались близко
      if (z - k.d / 2 < -D / 2 + 0.9) z = -D / 2 + 0.25 + k.d / 2;
      else if (z + k.d / 2 > D / 2 - 0.9) z = D / 2 - 0.25 - k.d / 2;
      if (rightWall && x + k.w / 2 > W / 2 - 0.9) x = W / 2 - 0.25 - k.w / 2;
      else if (leftWall && x - k.w / 2 < -W / 2 + 0.9) x = -W / 2 + 0.25 + k.w / 2;
      if (!fits(x - k.w / 2, z - k.d / 2, x + k.w / 2, z + k.d / 2)) continue;
      const bb = k.build(x, z, wood());
      if (bb && !k.noBlock) block(bb[0], bb[1], bb[2], bb[3], y0, y0 + 1.2);
      if (k.noBlock) roomZones.push({ x0: x - k.w / 2, z0: z - k.d / 2, x1: x + k.w / 2, z1: z + k.d / 2 });
      break;
    }
  }
  // картины на задней стене
  const pics = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < pics; i++) {
    const x = xMin + 1 + rng() * Math.max(0.5, xMax - xMin - 2), pw = 0.6 + rng() * 0.8, ph = 0.5 + rng() * 0.6;
    box(pw + 0.1, ph + 0.1, 0.05, std(0x3b2a1a), x, y0 + 1.7, -D / 2 + 0.23);
    box(pw, ph, 0.05, std(new THREE.Color().setHSL(rng(), 0.5, 0.5)), x, y0 + 1.7, -D / 2 + 0.25);
  }
}

// одна заметная деталь на дом: камин, аквариум, рояль, глобус, витраж
function addSpecial(h, rng, ctx) {
  const { W, D, box, block, g, lights } = ctx;
  const kind = Math.floor(rng() * 5);
  const x = W / 2 - 1.3 - rng() * Math.max(0.5, W / 2 - 3), z = -D / 2 + 0.6;
  if (kind === 0) {          // камин
    box(1.6, 1.3, 0.7, std(0x8c7b6b), x, 0.65, z); box(1.8, 0.12, 0.8, std(0x5a4632), x, 1.36, z);
    box(1.0, 0.8, 0.5, std(0x1a1a1a), x, 0.45, z + 0.12);
    box(0.5, 0.35, 0.3, std(0xff7a1a, { emissive: 0xff5a00, emissiveIntensity: 1.6 }), x, 0.25, z + 0.15);
    const l = new THREE.PointLight(0xff7a30, 4, 0, 2); l.position.set(x, 0.7, z + 0.5); g.add(l); lights.push(l);
    block(x - 0.8, z - 0.35, x + 0.8, z + 0.35, 0, 1.4);
  } else if (kind === 1) {   // аквариум
    box(1.8, 0.7, 0.6, std(0x3a3a3a), x, 0.35, z); block(x - 0.9, z - 0.3, x + 0.9, z + 0.3, 0, 1.6);
    const water = new THREE.MeshStandardMaterial({ color: 0x3aa0d8, emissive: 0x1c6ea0, emissiveIntensity: .9, transparent: true, opacity: .75 });
    box(1.7, 0.8, 0.5, water, x, 1.1, z);
    for (let i = 0; i < 5; i++) box(0.12, 0.07, 0.04, std(0xffb347), x - 0.7 + rng() * 1.4, 0.8 + rng() * 0.55, z + (rng() - 0.5) * 0.3);
    const l = new THREE.PointLight(0x4fb3ff, 3, 0, 2); l.position.set(x, 1.3, z + 0.6); g.add(l); lights.push(l);
  } else if (kind === 2) {   // рояль
    const black = std(0x101010, { roughness: .3, metalness: .2 });
    box(1.5, 0.25, 1.9, black, x, 0.85, z + 0.6); box(1.5, 0.1, 0.5, black, x, 0.75, z + 1.75);
    box(1.4, 0.06, 0.2, std(0xf5f5f5), x, 0.82, z + 1.75);
    for (const [dx, dz] of [[-0.6, 0.0], [0.6, 0.0], [0, 1.4]]) box(0.08, 0.75, 0.08, black, x + dx, 0.37, z + dz);
    box(0.5, 0.45, 0.35, black, x, 0.22, z + 2.3);
    block(x - 0.8, z - 0.4, x + 0.8, z + 2.5, 0, 1.0);
  } else if (kind === 3) {   // глобус
    box(0.06, 1.0, 0.06, std(0x5a4632), x, 0.5, z + 0.3); box(0.5, 0.05, 0.5, std(0x5a4632), x, 0.03, z + 0.3);
    const globe = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), std(0x2f6fb0)); globe.position.set(x, 1.35, z + 0.3); g.add(globe);
    for (let i = 0; i < 6; i++) { const land = new THREE.Mesh(new THREE.SphereGeometry(0.15 + rng() * 0.1, 8, 6), std(0x6a9a3a)); land.position.set(x + (rng() - 0.5) * 0.5, 1.35 + (rng() - 0.5) * 0.5, z + 0.3 + (rng() - 0.5) * 0.5); land.position.sub(globe.position).setLength(0.38).add(globe.position); g.add(land); }
    block(x - 0.3, z, x + 0.3, z + 0.6, 0, 1.6);
  } else {                   // витраж: цветное окно на задней стене с подсветкой
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++)
      box(0.35, 0.4, 0.06, std(new THREE.Color().setHSL(rng(), 0.75, 0.55), { emissive: new THREE.Color().setHSL(rng(), 0.75, 0.45), emissiveIntensity: .9 }), x - 0.55 + i * 0.37, 1.2 + j * 0.42, -D / 2 + 0.22);
    const l = new THREE.PointLight(0xffe0ff, 2.5, 0, 2); l.position.set(x, 1.6, -D / 2 + 0.8); g.add(l); lights.push(l);
  }
}

// ---------- вход / выход ----------
let shown = null;   // интерьер, который сейчас лежит в houseScene
function enter(h, floor, x, z, yaw) {
  let it = built.get(h.idx);
  if (!it) { it = buildInterior(h); built.set(h.idx, it); }
  if (shown && shown !== it) houseScene.remove(shown.group);   // в сцене интерьера — только один дом
  if (!it.group.parent) houseScene.add(it.group);
  shown = it;
  house.active = { h, it, pos: new THREE.Vector3(x, floor * FH, z), yaw, pitch: 0, vy: 0, grounded: true };
  player.inside = { house: h.idx, floor };
  setPlayerOverride(controller);
  house.hint = '';
}
const _t2 = new THREE.Vector2(), _t3 = new THREE.Vector2(), _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3();
function exitToWorld(h, lx, lz, jumpH) {
  houseLocalToTown(h, lx, lz, _t2); townToDir(_t2.x, _t2.y, _d1);
  houseLocalToTown(h, lx, lz + 1, _t3); townToDir(_t3.x, _t3.y, _d2);
  player.pos.copy(_d1).multiplyScalar(P.R - P.EYE - jumpH);   // точную длину выставит updatePlayer (рельеф под городом ровный)
  player.forward.copy(_d2).sub(_d1).normalize();
  player.pitch = 0; player.jumpH = jumpH; player.jumpV = 0;
  player.inside = null;
  house.active = null;
  setPlayerOverride(null);
  house.hint = '';
}
function nearExit(a) {
  for (const e of a.it.exits) {
    if (Math.abs(a.pos.y - e.f * FH) > 0.5) continue;
    if (Math.hypot(a.pos.x - e.x, a.pos.z - e.z) < 1.3) return e;
  }
  return null;
}
onSpace(() => {
  const a = house.active;
  if (a) {
    const e = nearExit(a);
    if (!e) return false;
    if (e.kind === 'door') exitToWorld(a.h, a.h.doorX, a.h.d / 2 + 1.2, 0);
    else exitToWorld(a.h, e.bx, a.h.d / 2 + BALCONY_D / 2, e.f * 3 + 0.16);
    return true;
  }
  if (platform) {            // стоим на балконе — внутрь через балконную дверь
    const ph = platform.house, it = built.get(ph.idx) || (built.set(ph.idx, buildInterior(ph)), built.get(ph.idx));
    const e = it.exits.find(x => x.kind === 'balcony' && x.f === platform.floor);
    if (e) { enter(ph, e.f, e.x, e.z - 0.3, 0); return true; }
  }
  if (nearTown) {
    const h = houseDoorNear(townXZ.x, townXZ.y);
    if (h) {
      const it = built.get(h.idx) || (built.set(h.idx, buildInterior(h)), built.get(h.idx));
      const e = it.exits.find(x => x.kind === 'door');
      enter(h, 0, e.x, e.z - 0.3, 0);
      return true;
    }
  }
  return false;
});

// ---------- управление внутри ----------
// высота пола под точкой: плита этажа (кроме проёма над лестницей) или наклон лестницы; берём самое высокое из того,
// что не выше ног + 0.6 (чтобы подниматься по ступеням, но не «телепортироваться» на этаж выше)
function groundAt(it, x, z, y) {
  let best = -Infinity;
  for (let f = 0; f < it.floors; f++) {
    const sy = f * FH;
    if (sy > y + 0.6) break;
    const hole = f > 0 && it.stairs.find(s => s.f === f - 1 && x >= s.x0 - 0.2 && x <= s.x1 + 0.2 && z >= s.z0 && z <= s.z1);
    if (!hole) best = Math.max(best, sy);
  }
  for (const s of it.stairs) {
    if (x < s.x0 - 0.2 || x > s.x1 + 0.2 || z < s.z0 || z > s.z1 + 1.0) continue;
    const t = THREE.MathUtils.clamp((z - s.z0) / (s.z1 - s.z0), 0, 1);
    const ry = s.f * FH + t * FH;
    if (ry <= y + 0.6) best = Math.max(best, ry);
  }
  return best === -Infinity ? 0 : best;
}
const _fw = new THREE.Vector3(), _rt = new THREE.Vector3(), _mv = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const controller = {
  update(dt) {
    const a = house.active, it = a.it;
    _fw.set(-Math.sin(a.yaw), 0, -Math.cos(a.yaw));
    _rt.set(Math.cos(a.yaw), 0, -Math.sin(a.yaw));
    _mv.set(0, 0, 0);
    if (keys.has('KeyW') || keys.has('ArrowUp')) _mv.add(_fw);
    if (keys.has('KeyS') || keys.has('ArrowDown')) _mv.sub(_fw);
    if (keys.has('KeyD') || keys.has('ArrowRight')) _mv.add(_rt);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) _mv.sub(_rt);
    if (_mv.lengthSq() > 0) a.pos.addScaledVector(_mv.normalize(), P.SPEED * 0.45 * dt);
    // коллизии: круг против AABB, только с теми, что пересекают тело по высоте; наружные стены — просто границы
    const p = a.pos;
    p.x = THREE.MathUtils.clamp(p.x, -it.W / 2 + 0.2 + RAD, it.W / 2 - 0.2 - RAD);
    p.z = THREE.MathUtils.clamp(p.z, -it.D / 2 + 0.2 + RAD, it.D / 2 - 0.2 - RAD);
    for (const o of it.obstacles) {
      if (p.y >= o.y1 || p.y + BODY_H <= o.y0) continue;
      const cx = THREE.MathUtils.clamp(p.x, o.x0, o.x1), cz = THREE.MathUtils.clamp(p.z, o.z0, o.z1);
      const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
      if (d2 >= RAD * RAD) continue;
      if (d2 < 1e-9) {
        const pen = [p.x - o.x0, o.x1 - p.x, p.z - o.z0, o.z1 - p.z];
        const k = pen.indexOf(Math.min(...pen));
        if (k === 0) p.x = o.x0 - RAD; else if (k === 1) p.x = o.x1 + RAD; else if (k === 2) p.z = o.z0 - RAD; else p.z = o.z1 + RAD;
      } else { const d = Math.sqrt(d2); p.x = cx + dx / d * RAD; p.z = cz + dz / d * RAD; }
    }
    // вертикаль: гравитация, пол/лестница, потолок
    const ground = groundAt(it, p.x, p.z, p.y);
    if (a.grounded && a.vy <= 0 && p.y - ground < 0.7) { p.y = ground; a.vy = 0; }   // идём по полу/ступеням, не отрываясь
    else {
      a.vy -= P.GRAVITY * dt;
      p.y += a.vy * dt;
      if (p.y <= ground) { p.y = ground; a.vy = 0; a.grounded = true; } else a.grounded = false;
    }
    // потолок — кроме лестничного проёма, там над головой открыто до следующего этажа
    const onStair = it.stairs.some(s => p.x >= s.x0 - 0.2 && p.x <= s.x1 + 0.2 && p.z >= s.z0 && p.z <= s.z1);
    const ceil = onStair ? it.floors * FH : (Math.floor(p.y / FH + 0.01) + 1) * FH;
    if (p.y + EYE_IN + 0.2 > ceil) { p.y = ceil - EYE_IN - 0.2; a.vy = Math.min(a.vy, 0); }
    player.inside.floor = Math.round(p.y / FH);

    camera.position.set(p.x, p.y + EYE_IN, p.z);
    camera.quaternion.setFromEuler(_e.set(a.pitch, a.yaw, 0));
    camera.updateMatrixWorld();   // камера живёт в мировой scene; при рендере houseScene её матрицу никто не обновит
    const e = nearExit(a);
    house.hint = e ? (e.kind === 'door' ? 'Пробел — выйти на улицу' : 'Пробел — выйти на балкон') : '';
  },
  mouse(dx, dy) {
    const a = house.active;
    a.yaw -= dx * P.MOUSE_SENS;
    a.pitch = THREE.MathUtils.clamp(a.pitch - dy * P.MOUSE_SENS, -Math.PI * 0.45, Math.PI * 0.45);
  },
  jump() {
    const a = house.active;
    if (a.grounded) { a.vy = Math.min(P.JUMP_V, 5.5); a.grounded = false; }
  },
};

// снаружи: подсказка у двери / на балконе (вызывается каждый кадр из main)
export function updateHouse() {
  if (house.active) return;
  if (platform) house.hint = 'Пробел — войти с балкона';
  else if (nearTown && houseDoorNear(townXZ.x, townXZ.y)) house.hint = 'Пробел — войти в дом';
  else house.hint = '';
}
// для отладки: войти в дом по номеру
export const debugEnter = (idx, floor = 0) => {
  const h = houses[idx]; if (!h) return;
  const it = built.get(h.idx) || (built.set(h.idx, buildInterior(h)), built.get(h.idx));
  const e = it.exits.find(x => x.kind === 'door');
  enter(h, floor, e.x, e.z - 0.3, 0);
};
export const debugExit = () => { const a = house.active; if (a) exitToWorld(a.h, a.h.doorX, a.h.d / 2 + 1.2, 0); };
