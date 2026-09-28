// Лес: ёлки.
// Ствол + три яруса-конуса, всё инстансами (две InstancedMesh на весь лес). Высоты 4..12 м, у каждой ёлки
// свой оттенок. Расставляются rejection sampling'ом по случайным направлениям, пока не попадут в лес.
import * as THREE from 'three';
import { rand, randomDir } from './state.js';
import { scene } from './scene.js';
import { fogify } from './fow.js';
import { surfaceR, radiusListeners } from './terrain.js';
import { BIOME, biomeAt } from './world.js';

const TREE_N = 750;
export const trees = [];   // { dir, h, yaw } — читает player.js (коллизии со стволами)
let trunkIM, tierIM;
const TIERS = [[0.18, 0.42, 0.27], [0.40, 0.38, 0.21], [0.62, 0.38, 0.15]];   // [низ, высота, радиус] в долях h

// шаг сборки мира (первый после townDir — порядок rand() важен)
export function buildForest() {
  for (let tries = 0; trees.length < TREE_N && tries < 40000; tries++) {
    const d = randomDir();
    if (biomeAt(d) !== BIOME.FOREST) continue;
    const u = rand();
    trees.push({ dir: d, h: 4 + u * u * 8, yaw: rand() * Math.PI * 2 });
  }
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 6).translate(0, 0.5, 0);   // основание в y=0, высота 1
  const tierGeo = new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0);
  const trunkMat = fogify(new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1, flatShading: true }));
  const tierMat = fogify(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .9, flatShading: true }));
  trunkIM = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  tierIM = new THREE.InstancedMesh(tierGeo, tierMat, trees.length * 3);
  trunkIM.frustumCulled = tierIM.frustumCulled = false;
  scene.add(trunkIM, tierIM);
  const c = new THREE.Color();
  trees.forEach((t, i) => {
    c.setHSL(0.33 + (rand() - 0.5) * 0.06, 0.45 + rand() * 0.2, 0.22 + rand() * 0.12);
    for (let k = 0; k < 3; k++) tierIM.setColorAt(i * 3 + k, c);
  });
  tierIM.instanceColor.needsUpdate = true;
}

const _tq = new THREE.Quaternion(), _tq2 = new THREE.Quaternion(), _tp = new THREE.Vector3(), _ts = new THREE.Vector3(),
      _ty = new THREE.Vector3(0, 1, 0), _tm = new THREE.Matrix4();
export function placeTrees() {
  if (!trunkIM) return;
  trees.forEach((t, i) => {
    const sr = surfaceR(t.dir);
    _tq.setFromUnitVectors(_ty, _tp.copy(t.dir).negate());
    _tq.multiply(_tq2.setFromAxisAngle(_ty, t.yaw));
    _ts.set(t.h / 8, t.h * 0.24, t.h / 8);
    trunkIM.setMatrixAt(i, _tm.compose(_tp.copy(t.dir).multiplyScalar(sr - 0.05), _tq, _ts));
    TIERS.forEach(([y0, hh, rr], k) => {
      _ts.set(rr * t.h, hh * t.h, rr * t.h);
      tierIM.setMatrixAt(i * 3 + k, _tm.compose(_tp.copy(t.dir).multiplyScalar(sr - 0.05 - y0 * t.h), _tq, _ts));
    });
  });
  trunkIM.instanceMatrix.needsUpdate = true;
  tierIM.instanceMatrix.needsUpdate = true;
}
radiusListeners.push(placeTrees);
