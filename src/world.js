// Разметка мира: где стоит город, оси биомов, озеро, CPU-шум и функция biomeAt.
// Чистая геометрия по направлениям на сфере — ни одного меша. Первый потребитель rand() (townDir).
import * as THREE from 'three';
import { START_DIR, rand } from './state.js';
import { P, DEFAULTS } from './params.js';

// ---------- городок: где стоит ----------
// Старт игрока — на "экваторе" в START_DIR; город ставим в ~0.6 рад от него (≈48 м при R=80) со случайным азимутом.
export const TOWN_H = 20;                      // полуразмер: стена на ±TOWN_H (м)
export const TOWN_STREET = 5;                  // ширина улиц (м)
export const TOWN_WALL_H = 2.2;
export const TOWN_AVOID = TOWN_H * 1.42 + 4;   // радиус (м), внутрь которого караван не заходит — отскакивает
export const townDir = (() => {
  const az = rand() * Math.PI * 2;
  const t = new THREE.Vector3(0, Math.cos(az), Math.sin(az));     // касательная в START_DIR
  return START_DIR.clone().multiplyScalar(Math.cos(0.6)).addScaledVector(t, Math.sin(0.6)).normalize();
})();
// локальные оси города в касательной плоскости; "верх" объектов — к центру (-townDir)
export const townEx = new THREE.Vector3(), townEz = new THREE.Vector3();
{
  const ref = Math.abs(townDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  townEx.crossVectors(ref, townDir).normalize();
  townEz.crossVectors(townDir, townEx).normalize();
}
// локальные координаты города (x, z в метрах по поверхности) <-> направление на сфере (экспоненциальное отображение)
const _tt2 = new THREE.Vector3();
export function townToDir(x, z, out) {     // out не должен совпадать с _tt2
  const r = Math.hypot(x, z);
  if (r < 1e-6) return out.copy(townDir);
  const a = r / P.R;
  _tt2.copy(townEx).multiplyScalar(x / r).addScaledVector(townEz, z / r);
  return out.copy(townDir).multiplyScalar(Math.cos(a)).addScaledVector(_tt2, Math.sin(a)).normalize();
}
export function dirToTown(dir, out) {
  const a = dir.angleTo(townDir);
  if (a < 1e-6) return out.set(0, 0);
  _tt2.copy(dir).addScaledVector(townDir, -Math.cos(a)).divideScalar(Math.sin(a));
  return out.set(a * P.R * _tt2.dot(townEx), a * P.R * _tt2.dot(townEz));
}

// ---------- биомы: трава, лес, песок, вода ----------
// Сфера делится "широтой" относительно оси bioAxis: шапка |lat| > BAND с одной стороны — лес, с другой — песок.
// Площадь шапки = (1 - sin BAND)/2, при sin BAND = 0.3 это ровно 35% на каждую; между ними полоса травы (30%)
// с озером. Ось выбрана так, что старт игрока и город лежат на "экваторе" — на траве; озеро тоже на этом
// большом круге, с противоположной от города стороны. Границы шапок и берег озера расшатаны fbm-шумом,
// вокруг города — круглая поляна (иначе ёлки лезли бы за стену).
export const BIOME = { GRASS: 0, FOREST: 1, SAND: 2, WATER: 3 };
export const BIOME_NAME = ['трава', 'лес', 'песок', 'вода'];
export const BAND = Math.asin(0.3);            // полуширина полосы травы (рад)
export const LAKE_R = 0.25;                    // угловой радиус озера (рад) ≈ 20 м при R=80
export const TOWN_CLEAR = TOWN_AVOID / DEFAULTS.R;   // поляна вокруг города (рад)
export const bioE1 = START_DIR.clone();
export const bioE2 = townDir.clone().addScaledVector(bioE1, -bioE1.dot(townDir)).normalize();
export const bioAxis = new THREE.Vector3().crossVectors(bioE1, bioE2).normalize();   // центр леса; -bioAxis — центр песков
export const lakeDir = bioE1.clone().multiplyScalar(Math.cos(-1.4)).addScaledVector(bioE2, Math.sin(-1.4)).normalize();

// value-noise на CPU (та же идея, что в шейдерах), чтобы карта биомов и логика считались одной функцией
function vhash(x, y, z) { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(vhash(ix, iy, iz), vhash(ix + 1, iy, iz), fx), l(vhash(ix, iy + 1, iz), vhash(ix + 1, iy + 1, iz), fx), fy),
           l(l(vhash(ix, iy, iz + 1), vhash(ix + 1, iy, iz + 1), fx), l(vhash(ix, iy + 1, iz + 1), vhash(ix + 1, iy + 1, iz + 1), fx), fy), fz);
}
export function fbm3(x, y, z) {
  return vnoise(x, y, z) * 0.55 + vnoise(x * 2.1 + 5.2, y * 2.1 + 1.3, z * 2.1 + 7.7) * 0.3 + vnoise(x * 4.3 + 9.1, y * 4.3 + 2.2, z * 4.3 + 3.9) * 0.15;
}
// биом по направлению (x, y, z — единичный вектор); вокруг озера узкая полоса пляжа (SAND)
export function biomeAtXYZ(x, y, z) {
  const dTown = x * townDir.x + y * townDir.y + z * townDir.z;
  if (dTown > Math.cos(TOWN_CLEAR)) return BIOME.GRASS;
  const lat = Math.asin(Math.max(-1, Math.min(1, x * bioAxis.x + y * bioAxis.y + z * bioAxis.z)));
  if (Math.abs(lat) > BAND + 0.14) return lat > 0 ? BIOME.FOREST : BIOME.SAND;   // далеко от границы — шум не нужен
  const w = (fbm3(x * 2.2, y * 2.2, z * 2.2) - 0.5) * 0.5;                         // расшатанная граница ±~0.12 рад
  if (lat + w > BAND) return BIOME.FOREST;
  if (lat - w < -BAND) return BIOME.SAND;
  const a = lakeAngle(x, y, z);
  if (a < LAKE_R) return BIOME.WATER;
  if (a < LAKE_R + 0.035) return BIOME.SAND;   // пляж
  return BIOME.GRASS;
}
export const biomeAt = d => biomeAtXYZ(d.x, d.y, d.z);
// угловое расстояние до центра озера с расшатанным берегом (Infinity — далеко); общее для биомов и рельефа
export function lakeAngle(x, y, z) {
  const d = x * lakeDir.x + y * lakeDir.y + z * lakeDir.z;
  if (d < Math.cos(LAKE_R + 0.3)) return Infinity;
  return Math.acos(Math.min(1, d)) + (fbm3(x * 6 + 13, y * 6, z * 6) - 0.5) * 0.12;
}
