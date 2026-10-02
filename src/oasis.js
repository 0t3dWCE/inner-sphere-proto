// Оазис в пустыне: пальмы, открытая палатка кочевников (ковёр, кальян), колодец с лужей,
// привязь для верблюдов и утварь. Место — из seed'а мира, своим RNG: rand() мира не тратится,
// у всех в комнате оазис в одной точке. Цветные пропсы, попавшие в поляну, переставляются
// (тоже своим RNG). Караван от поляны отскакивает, как от города.
import * as THREE from 'three';
import { WORLD_SEED, hash32, mulberry32 } from './state.js';
import { P } from './params.js';
import { scene } from './scene.js';
import { fogify } from './fow.js';
import { surfaceR, radiusListeners, addTerrainFlat } from './terrain.js';
import { BIOME, biomeAt, bioAxis, townDir, TOWN_H } from './world.js';
import { props, placeOnWall } from './props.js';

export const OASIS_AVOID = 12;          // м — ближе караван не заходит
const CLEAR_R = 20;                     // м — поляна без случайных пропсов
const FLAT_R = 14, FLAT_BLEND = 24;     // м — ровная земля под лагерем, дальше холмы возвращаются (как у города)
const POOL_R = 2.3;

export const oasisDir = new THREE.Vector3();
export const oasisBlocks = [];          // { dir, rad } — круги, в которые игрок не проходит
const placed = [];                      // { obj, x, z, yaw, dir } — метры от центра; dir пересчитывается при смене R

const rng = mulberry32(WORLD_SEED ^ hash32('oasis'));
const rnd = () => rng();

const mat = o => fogify(new THREE.MeshStandardMaterial(Object.assign({ roughness: .9, flatShading: true }, o)));
const trunkMat = mat({ color: 0x8a6239 });
const trunkDark = mat({ color: 0x6e4b2c });
const leafMat = mat({ color: 0x3e7a32, roughness: .8 });
const leafDark = mat({ color: 0x2d5c28, roughness: .8 });
const clothMat = mat({ color: 0xd8c4a0, roughness: .95, side: THREE.DoubleSide });
const stripeMat = mat({ color: 0x8d3d32, roughness: .95, side: THREE.DoubleSide });
const woodMat = mat({ color: 0x6b4423 });
const stoneMat = mat({ color: 0xa39c90, roughness: 1 });
const waterMat = mat({ color: 0x1c4e58, roughness: .25, metalness: .15, emissive: 0x0c3038, emissiveIntensity: .4 });
const ropeMat = mat({ color: 0xc2b48a });
const clayMat = mat({ color: 0xb5523a });
const packMat = mat({ color: 0x6a5332 });
const brassMat = mat({ color: 0xc6a15a, roughness: .45, metalness: .6 });
const glassMat = mat({ color: 0x2f6b52, roughness: .15, metalness: .1, emissive: 0x143828, emissiveIntensity: .3 });
const coalMat = mat({ color: 0x2a2a2a, emissive: 0xff5a1a, emissiveIntensity: .8 });
const cushionA = mat({ color: 0x2c4a6e });
const cushionB = mat({ color: 0x8a3a2a });

function carpetTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#7a1e2b'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#e0b15a'; g.lineWidth = 8; g.strokeRect(6, 6, 116, 116);
  g.lineWidth = 3; g.strokeRect(16, 16, 96, 96);
  g.fillStyle = '#c4843a';
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    g.beginPath(); g.ellipse(34 + i * 30, 44 + j * 40, 7, 11, 0, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const carpetMat = mat({ map: carpetTexture(), roughness: .85 });

const mesh = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); return o; };
const cyl = (r0, r1, h, m, seg = 7) => new THREE.CylinderGeometry(r0, r1, h, seg);

// ---------- место ----------
function pickCenter() {
  const pole = bioAxis.clone().negate();
  const ref = Math.abs(pole.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const e1 = new THREE.Vector3().crossVectors(ref, pole).normalize();
  const e2 = new THREE.Vector3().crossVectors(pole, e1).normalize();
  for (let i = 0; i < 40; i++) {
    const theta = 0.4 + rnd() * 0.5, az = rnd() * Math.PI * 2;
    const dir = pole.clone().multiplyScalar(Math.cos(theta))
      .addScaledVector(e1, Math.sin(theta) * Math.cos(az))
      .addScaledVector(e2, Math.sin(theta) * Math.sin(az)).normalize();
    if (biomeAt(dir) === BIOME.SAND) return dir;
  }
  return pole;
}
// локальные оси поляны: +Z — к траве (вход палатки смотрит на выход из пустыни), +X — вправо, +Y — вверх
function axesAt(dir, yaw, right, up, fwd) {
  up.copy(dir).negate();
  fwd.copy(bioAxis).addScaledVector(dir, -bioAxis.dot(dir));
  if (fwd.lengthSq() < 1e-8) fwd.set(1, 0, 0).addScaledVector(dir, -dir.x);
  fwd.normalize();
  if (yaw) fwd.applyAxisAngle(up, yaw);
  right.crossVectors(up, fwd).normalize();
  fwd.crossVectors(right, up).normalize();
}
const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3(), _m = new THREE.Matrix4();
function orient(obj, dir, yaw = 0) {
  axesAt(dir, yaw, _r, _u, _f);
  obj.position.copy(dir).multiplyScalar(surfaceR(dir));
  obj.quaternion.setFromRotationMatrix(_m.makeBasis(_r, _u, _f));
}
// точка в метрах от центра поляны по её осям (плоскость → сфера)
function offsetDir(x, z, out) {
  axesAt(oasisDir, 0, _r, _u, _f);
  const d = Math.hypot(x, z);
  if (d < 1e-4) return out.copy(oasisDir);
  const a = d / P.R;
  return out.copy(oasisDir).multiplyScalar(Math.cos(a))
    .addScaledVector(_r, Math.sin(a) * x / d).addScaledVector(_f, Math.sin(a) * z / d).normalize();
}

function seatAll() {
  for (const p of placed) {
    offsetDir(p.x, p.z, p.dir);
    orient(p.obj, p.dir, p.yaw);
  }
  for (const b of oasisBlocks) offsetDir(b.x, b.z, b.dir);   // круги коллизий — туда же, куда меши
}
function put(obj, x, z, yaw = 0) {
  const rec = { obj, x, z, yaw, dir: new THREE.Vector3() };
  placed.push(rec);
  offsetDir(x, z, rec.dir);
  orient(obj, rec.dir, yaw);
  scene.add(obj);
}
function block(x, z, rad) { oasisBlocks.push({ x, z, rad, dir: offsetDir(x, z, new THREE.Vector3()) }); }
radiusListeners.push(seatAll);

const plantedPalms = [];
const PALM_MAX = 24;
function seatPalm(mesh, dir) {
  mesh.position.copy(dir).multiplyScalar(surfaceR(dir));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
}
export function plantPalm(dir) {
  if (plantedPalms.length >= PALM_MAX) return false;
  const d = dir.clone().normalize();
  const g = makePalm(6 + Math.random() * 4);
  seatPalm(g, d);
  scene.add(g);
  oasisBlocks.push({ dir: d, rad: 0.45 });
  plantedPalms.push({ mesh: g, dir: d });
  return true;
}
radiusListeners.push(() => { for (const p of plantedPalms) seatPalm(p.mesh, p.dir); });

// ---------- модели: локальный +Y вверх, земля — y = 0 ----------
function makePalm(h) {
  const g = new THREE.Group();
  const trunkH = h * 0.82;
  // один прямой ствол, крона — его ребёнок на торце: с любого ракурса листья сидят на дереве
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.3, trunkH, 7), trunkMat);
  trunk.geometry.translate(0, trunkH / 2, 0);
  g.add(trunk);
  const crown = new THREE.Group();
  crown.position.y = trunkH;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), trunkDark);
  cap.scale.y = 0.65;
  crown.add(cap);
  const n = 8, len = h * 0.34;
  for (let i = 0; i < n; i++) {
    const fr = new THREE.Mesh(new THREE.ConeGeometry(0.2, len, 4), i % 2 ? leafDark : leafMat);
    fr.geometry.translate(0, len / 2 - 0.28, 0);   // основание листа утоплено в макушку
    fr.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i / n * Math.PI * 2)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.05));
    crown.add(fr);
  }
  g.add(crown);
  return g;
}

function makeHookah() {
  const g = new THREE.Group();
  g.add(mesh(new THREE.SphereGeometry(0.13, 10, 8), glassMat, 0, 0.16, 0));
  g.add(mesh(cyl(0.025, 0.03, 0.42, 6), brassMat, 0, 0.42, 0));
  g.add(mesh(cyl(0.11, 0.11, 0.02, 8), brassMat, 0, 0.6, 0));
  g.add(mesh(new THREE.SphereGeometry(0.06, 8, 6), brassMat, 0, 0.68, 0));
  g.add(mesh(new THREE.SphereGeometry(0.035, 6, 5), coalMat, 0, 0.74, 0));
  const hose = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.016, 6, 14, Math.PI * 1.15), brassMat);
  hose.rotation.y = Math.PI / 2; hose.rotation.x = Math.PI * 0.5; hose.position.set(-0.16, 0.34, 0.02);
  g.add(hose);
  return g;
}

function makeTent() {
  const g = new THREE.Group();
  const pole = (x, z, h = 2.15) => mesh(cyl(0.045, 0.06, h, 6), woodMat, x, h / 2, z);
  g.add(pole(-1.75, -1.55), pole(1.75, -1.55), pole(-1.75, 1.15, 1.9), pole(1.75, 1.15, 1.9));
  // стены: левая, правая, задняя; фасад открыт
  g.add(mesh(new THREE.BoxGeometry(0.05, 1.65, 2.75), clothMat, -1.75, 0.85, -0.2));
  g.add(mesh(new THREE.BoxGeometry(0.05, 1.65, 2.75), clothMat, 1.75, 0.85, -0.2));
  g.add(mesh(new THREE.BoxGeometry(3.5, 1.65, 0.05), clothMat, 0, 0.85, -1.55));
  g.add(mesh(new THREE.BoxGeometry(3.5, 0.28, 0.05), stripeMat, 0, 1.35, -1.52));
  const roof = (x, rz) => {
    const o = mesh(new THREE.BoxGeometry(2.15, 0.05, 3.15), x < 0 ? clothMat : stripeMat, x, 2.12, -0.15);
    o.rotation.z = rz;
    return o;
  };
  g.add(roof(-0.95, 0.32), roof(0.95, -0.32));
  const awning = mesh(new THREE.BoxGeometry(3.3, 0.045, 1.05), clothMat, 0, 1.78, 1.55);
  awning.rotation.x = 0.22;
  g.add(awning);
  // ковёр на всю палатку, чтобы был виден от входа; кальян и подушки ближе к середине
  g.add(mesh(new THREE.BoxGeometry(3.15, 0.045, 2.7), carpetMat, 0, 0.03, -0.05));
  const cush = (m, x, z, ry) => { const o = mesh(cyl(0.42, 0.46, 0.16, 10), m, x, 0.12, z); o.rotation.y = ry; return o; };
  g.add(cush(cushionA, -0.7, 0.35, 0.4), cush(cushionB, 0.05, 0.55, -0.2));
  const hookah = makeHookah();
  hookah.scale.setScalar(1.6);
  hookah.position.set(0.45, 0, -0.15);
  g.add(hookah);
  return g;
}

function makeWell() {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.13, 8, 16), stoneMat);
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.62;
  g.add(rim);
  g.add(mesh(cyl(0.66, 0.74, 0.55, 10), stoneMat, 0, 0.28, 0));
  g.add(mesh(cyl(0.4, 0.4, 0.04, 12), waterMat, 0, 0.48, 0));
  g.add(mesh(cyl(0.05, 0.06, 1.45, 6), woodMat, -0.62, 1.2, 0));
  g.add(mesh(cyl(0.05, 0.06, 1.45, 6), woodMat, 0.62, 1.2, 0));
  const bar = mesh(cyl(0.04, 0.04, 1.4, 6), woodMat, 0, 1.88, 0); bar.rotation.z = Math.PI / 2;
  g.add(bar);
  g.add(mesh(cyl(0.012, 0.012, 0.6, 4), ropeMat, 0.18, 1.52, 0));
  g.add(mesh(cyl(0.1, 0.13, 0.22, 8), woodMat, 0.18, 1.12, 0));
  return g;
}

function makeHitch() {
  const g = new THREE.Group();
  for (const x of [-1.5, 1.5]) g.add(mesh(cyl(0.07, 0.09, 1.25, 6), woodMat, x, 0.62, 0));
  const rail = mesh(cyl(0.04, 0.04, 3, 6), woodMat, 0, 1.12, 0); rail.rotation.z = Math.PI / 2;
  g.add(rail);
  const coil = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.022, 6, 10), ropeMat);
  coil.rotation.x = Math.PI / 2; coil.position.set(-1.5, 0.4, 0);
  g.add(coil);
  const saddle = mesh(new THREE.BoxGeometry(0.55, 0.28, 0.38), packMat, 0.35, 0.16, 0.75);
  saddle.rotation.y = 0.5;
  g.add(saddle);
  g.add(mesh(cyl(0.14, 0.18, 0.48, 8), clayMat, -0.55, 0.24, 0.85));
  g.add(mesh(cyl(0.1, 0.13, 0.32, 8), clayMat, -0.85, 0.16, 0.6));
  g.add(mesh(new THREE.SphereGeometry(0.1, 7, 6), clayMat, -0.55, 0.52, 0.85));
  return g;
}

function clearProps() {
  const rndDir = () => {
    const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(Math.max(0, 1 - z * z));
    return new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z);
  };
  for (const p of props) {
    if (p.n.angleTo(oasisDir) * P.R >= CLEAR_R) continue;
    for (let i = 0; i < 50; i++) {
      const d = rndDir(), b = biomeAt(d);
      if (b === BIOME.FOREST || b === BIOME.WATER) continue;
      if (d.angleTo(townDir) * P.R < TOWN_H * 1.7) continue;
      if (d.angleTo(oasisDir) * P.R < CLEAR_R) continue;
      p.n.copy(d);
      placeOnWall(p.mesh, p.n, p.h);
      break;
    }
  }
}

export function buildOasis() {
  oasisDir.copy(pickCenter());
  addTerrainFlat(oasisDir, FLAT_R, FLAT_BLEND);   // до applyRadius: и меши, и стенка читают уже ровную высоту
  clearProps();
  // пальмы вокруг стоянки, разной высоты. Первые восемь — всегда, остальные добираются до 15.
  // Точки снаружи палатки, лужи и привязи, внутри ровной поляны (FLAT_R).
  const spots = [
    [-8.2, -6.4], [-3.2, -9.4], [3.4, -9.2], [8.6, -6.0],
    [10.2, 2.2], [6.8, 7.6], [-7.2, 7.4], [-9.6, 0.8],
    [-11.2, -3.6], [-6.8, -10.6], [0.2, -11.6], [6.6, -10.2],
    [11.4, -2.4], [11.0, 5.2], [-11.4, 4.6],
  ];
  const nPalm = 8 + Math.floor(rnd() * 8);
  for (let i = 0; i < nPalm; i++) {
    const h = 6 + rnd() * 5.5;
    put(makePalm(h), spots[i][0], spots[i][1], rnd() * Math.PI * 2);
    block(spots[i][0], spots[i][1], 0.45);
  }
  put(makeTent(), 0, 0);
  // лужа и колодец на её краю, справа от входа
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(POOL_R, POOL_R, 0.06, 22), waterMat);
  pool.geometry.translate(0, 0.04, 0);
  put(pool, 5.4, 0.4);
  const wellZ = 0.4 + POOL_R + 0.2;   // на ближнем к входу краю лужи
  put(makeWell(), 5.4, wellZ);
  block(5.4, wellZ, 0.9);
  put(makeHitch(), -5.6, 1.6);
  block(-7.1, 1.6, 0.3);
  block(-4.1, 1.6, 0.3);
}
