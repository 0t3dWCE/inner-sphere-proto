// Мастер сажает ёлки или пальмы кольцом вокруг игрока. Дома, оазис и караван не двигает.
import * as THREE from 'three';
import { P } from './params.js';
import { player } from './state.js';
import { houses, houseLocalToTown } from './town.js';
import { townToDir } from './world.js';
import { plantTree } from './forest.js';
import { plantPalm } from './oasis.js';

const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _town = new THREE.Vector2();
const _ref = new THREE.Vector3();

function centerDir(out) {
  if (player.inside) {
    const h = houses[player.inside.house];
    houseLocalToTown(h, 0, 0, _town);
    return townToDir(_town.x, _town.y, out);
  }
  return out.copy(player.pos).normalize();
}

export function plantAround(what, n) {
  const count = Math.max(1, Math.min(6, n | 0 || 1));
  const place = what === 'palm' ? plantPalm : plantTree;
  const meters = what === 'palm' ? 6 : 5;
  centerDir(_c);
  _ref.set(Math.abs(_c.y) < 0.9 ? 0 : 1, Math.abs(_c.y) < 0.9 ? 1 : 0, 0);
  _e1.crossVectors(_ref, _c).normalize();
  _e2.crossVectors(_c, _e1).normalize();
  const ang = meters / P.R;
  let planted = 0;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.4;
    const dir = _c.clone().multiplyScalar(Math.cos(ang))
      .addScaledVector(_e1, Math.sin(ang) * Math.cos(a))
      .addScaledVector(_e2, Math.sin(ang) * Math.sin(a))
      .normalize();
    if (place(dir)) planted++;
  }
  return planted;
}
