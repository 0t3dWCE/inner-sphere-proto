// Поверхность: рельеф (terrainH/surfaceR), геометрия стенки и воды, плитка земли × карта биомов,
// и applyRadius() — единая точка пересборки всего, что зависит от радиуса и рельефа.
import * as THREE from 'three';
import { P, DEFAULTS } from './params.js';
import { renderer, scene, camera, sun } from './scene.js';
import { fogify } from './fow.js';
import { townDir, lakeDir, LAKE_R, BIOME, biomeAtXYZ, lakeAngle, fbm3 } from './world.js';

// ---------- рельеф ----------
// Высота над "нулевым" радиусом R, положительная — к центру (холм), в метрах. Поверхность лежит на радиусе
// R - h(dir): одна функция для геометрии стенки и для всего, что на ней стоит (surfaceR). Под городом и
// под оазисом ровно (иначе постройки торчат углами и пол палатки идёт волной), озеро — чаша ниже уровня
// воды с невысоким берегом, чтобы вода не выплёскивалась в соседние низины.
const LAKE_DEPTH = 3;
const TOWN_FLAT0 = 30 / DEFAULTS.R, TOWN_FLAT1 = 44 / DEFAULTS.R;   // поляна: ровно до 30 м, к 44 м — полный рельеф
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// дополнительные поляны в метрах (оазис). Угол от текущего R: лагерь сам по себе в метрах и не растёт со сферой.
const extraFlats = [];
export function addTerrainFlat(dir, innerM, outerM) { extraFlats.push({ dir, innerM, outerM }); }
export function terrainH(x, y, z) {
  const A = P.TERRAIN_H;
  if (A <= 0) return 0;
  let h = A * Math.max(-1, Math.min(1, (fbm3(x * 3 + 21.7, y * 3 + 8.1, z * 3 + 3.3) - 0.5) * 4));
  const aTown = Math.acos(Math.min(1, x * townDir.x + y * townDir.y + z * townDir.z));
  h *= sstep(TOWN_FLAT0, TOWN_FLAT1, aTown);
  for (let i = 0; i < extraFlats.length; i++) {
    const f = extraFlats[i];
    const a = Math.acos(Math.min(1, x * f.dir.x + y * f.dir.y + z * f.dir.z));
    h *= sstep(f.innerM / P.R, f.outerM / P.R, a);
  }
  const a = lakeAngle(x, y, z);
  if (a < LAKE_R + 0.2) {
    if (a < LAKE_R) return -0.15 - LAKE_DEPTH * Math.max(0, 1 - (a / LAKE_R) ** 2);   // чаша
    const shore = Math.max(h, 0.25);                                                 // берег не ниже уровня воды
    const s1 = sstep(LAKE_R, LAKE_R + 0.1, a), s2 = sstep(LAKE_R + 0.1, LAKE_R + 0.2, a);
    const near = -0.15 + (shore + 0.15) * s1;
    h = near + (h - near) * s2;
  }
  return h;
}
export const surfaceR = d => P.R - terrainH(d.x, d.y, d.z);

// геометрия стенки с рельефом: плотная сфера, вершины сдвинуты по радиусу на -h
function buildTerrainGeometry(R) {
  const g = new THREE.SphereGeometry(R, 512, 256);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const r = R - terrainH(v.x, v.y, v.z);
    p.setXYZ(i, v.x * r, v.y * r, v.z * r);
  }
  g.computeVertexNormals();
  return g;
}
// водная гладь: сферический "диск" на радиусе R (уровень воды h = 0) вокруг центра озера
function buildWaterGeometry(R) {
  const RINGS = 10, SEG = 64, ang = LAKE_R + 0.08;
  const u = new THREE.Vector3(), w = new THREE.Vector3(), d = new THREE.Vector3();
  u.crossVectors(lakeDir, Math.abs(lakeDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  w.crossVectors(lakeDir, u).normalize();
  const posArr = [lakeDir.x * R, lakeDir.y * R, lakeDir.z * R], idx = [];
  for (let r = 1; r <= RINGS; r++) {
    const a = ang * r / RINGS;
    for (let s = 0; s < SEG; s++) {
      const phi = s / SEG * Math.PI * 2;
      d.copy(lakeDir).multiplyScalar(Math.cos(a)).addScaledVector(u, Math.sin(a) * Math.cos(phi)).addScaledVector(w, Math.sin(a) * Math.sin(phi));
      posArr.push(d.x * R, d.y * R, d.z * R);
    }
  }
  const ring = r => 1 + (r - 1) * SEG;
  for (let s = 0; s < SEG; s++) idx.push(0, ring(1) + s, ring(1) + (s + 1) % SEG);
  for (let r = 1; r < RINGS; r++) for (let s = 0; s < SEG; s++) {
    const a0 = ring(r) + s, a1 = ring(r) + (s + 1) % SEG, b0 = ring(r + 1) + s, b1 = ring(r + 1) + (s + 1) % SEG;
    idx.push(a0, b0, a1, a1, b0, b1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------- сфера (смотрим изнутри => BackSide) ----------
function makeGridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  // нейтральная плитка: цвет даёт карта биомов (умножается в шейдере), здесь — только шахматка и сетка
  g.fillStyle = '#d6d6d6';
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = '#c8c8c8';
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
    if ((x + y) % 2) g.fillRect(x * 128, y * 128, 128, 128);
  // сетка
  g.strokeStyle = 'rgba(255,255,255,.45)';
  g.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i * 128); g.lineTo(512, i * 128); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 12);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// карта биомов (equirect, заполняется в paintBiomes) — цвет земли = плитка × биом
const biomeUniforms = { uBiome: { value: null } };
function groundShader(shader) {
  Object.assign(shader.uniforms, biomeUniforms);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform sampler2D uBiome;')
    .replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec3 bd = normalize(vFowWorldPos);
        vec2 buv = vec2(atan(bd.z, bd.x) / 6.2831853 + 0.5, asin(clamp(bd.y, -1.0, 1.0)) / 3.1415927 + 0.5);
        diffuseColor.rgb *= texture2D(uBiome, buv).rgb;
      }`);
}
export const sphere = new THREE.Mesh(
  new THREE.SphereGeometry(1, 128, 64),
  fogify(new THREE.MeshStandardMaterial({ map: makeGridTexture(), side: THREE.BackSide, roughness: 1 }), groundShader)
);
scene.add(sphere);

export const water = new THREE.Mesh(
  new THREE.BufferGeometry(),
  fogify(new THREE.MeshStandardMaterial({ color: 0x3f86c9, transparent: true, opacity: 0.72, roughness: 0.2, metalness: 0.1, side: THREE.DoubleSide }))
);
scene.add(water);

// карта биомов -> equirect DataTexture (цвета земли); под водой — илистое дно, темнеющее к середине
// (сама вода — полупрозрачная гладь поверх чаши рельефа)
const BIOME_RGB = [[0x6e, 0xb6, 0x5c], [0x4c, 0x8a, 0x40], [0xe8, 0xd6, 0x8e], [0xb4, 0xa4, 0x74]];
const DEEP_RGB = [0x50, 0x4c, 0x3a];
const BM_W = 2048, BM_H = 1024;   // ~0.25 м/пиксель на экваторе при R=80; рисуется ~250 мс
export function paintBiomes() {
  const data = new Uint8Array(BM_W * BM_H * 4);
  for (let py = 0; py < BM_H; py++) {
    const lat = ((py + 0.5) / BM_H - 0.5) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let px = 0; px < BM_W; px++) {
      const lon = ((px + 0.5) / BM_W - 0.5) * 2 * Math.PI;
      const x = cl * Math.cos(lon), y = sl, z = cl * Math.sin(lon);
      const b = biomeAtXYZ(x, y, z);
      let c = BIOME_RGB[b];
      if (b === BIOME.WATER) {
        const depth = Math.min(1, (LAKE_R - lakeAngle(x, y, z)) / LAKE_R * 1.6);
        c = [0, 1, 2].map(k => c[k] + (DEEP_RGB[k] - c[k]) * depth);
      }
      const i = (py * BM_W + px) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, BM_W, BM_H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  biomeUniforms.uBiome.value = tex;
}

// ---------- смена радиуса / рельефа ----------
// Модули, у которых объекты стоят на стенке (props, town, forest), регистрируют здесь функцию «переставить всё».
// Так terrain.js не знает о них, а они знают о нём — граф без циклов.
export const radiusListeners = [];
// всё, что зависит от радиуса: геометрия сферы, вода, дальность камеры, свет, позиции объектов
export function applyRadius() {
  const R = P.R;
  sphere.geometry.dispose();
  sphere.geometry = buildTerrainGeometry(R);
  water.geometry.dispose();
  water.geometry = buildWaterGeometry(R);
  camera.far = R * 4;
  camera.updateProjectionMatrix();
  sun.intensity = 3 * R * R;
  for (const fn of radiusListeners) fn();
}
