// Объекты на внутренней поверхности: реестр props (переставляются при смене радиуса), цветные коробки,
// маяки и общая палитра.
import * as THREE from 'three';
import { rand, randomDir } from './state.js';
import { P } from './params.js';
import { scene } from './scene.js';
import { fogify } from './fow.js';
import { surfaceR, radiusListeners } from './terrain.js';
import { townDir, TOWN_H, BIOME, biomeAt } from './world.js';

// объект стоит "ногами" на стенке в точке с нормалью n (n — направление из центра к стенке)
export const props = [];   // { mesh, n, h } — чтобы переставлять при смене радиуса
export function placeOnWall(mesh, n, h) {
  mesh.position.copy(n).multiplyScalar(surfaceR(n) - h / 2);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n.clone().negate()); // "верх" — к центру
}
export function addProp(mesh, n, h) {
  placeOnWall(mesh, n, h);
  props.push({ mesh, n, h });
  scene.add(mesh);
}
radiusListeners.push(() => { for (const p of props) placeOnWall(p.mesh, p.n, p.h); });

export const palette = [0xe4572e, 0x17bebb, 0xffc914, 0x2e282a, 0x76b041, 0x9b5de5, 0xf15bb5];

// шаг сборки мира (после леса, до города — порядок rand() важен)
export function buildProps() {
  // цветные пропсы — только на траве и песке (в лесу ёлки, в воде — нечего)
  for (let i = 0; i < 90; i++) {
    const h = 2 + rand() * 6;
    const w = 1 + rand() * 3;
    const mesh = new THREE.Mesh(
      rand() < 0.5 ? new THREE.BoxGeometry(w, h, w) : new THREE.CylinderGeometry(w / 2, w / 2, h, 12),
      fogify(new THREE.MeshStandardMaterial({ color: palette[i % palette.length], roughness: .8 }))
    );
    let n, b;
    do { n = randomDir(); b = biomeAt(n); }
    while (n.angleTo(townDir) * P.R < TOWN_H * 1.7 || b === BIOME.FOREST || b === BIOME.WATER);
    addProp(mesh, n, h);
  }
  // несколько высоких "маяков" — ориентиры, хорошо видны на уходящем вверх горизонте
  for (let i = 0; i < 6; i++) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.6, 18, 10),
      fogify(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff4040, emissiveIntensity: .6 }))
    );
    let n;
    do n = randomDir(); while (biomeAt(n) === BIOME.WATER);
    addProp(pole, n, 18);
  }
}
