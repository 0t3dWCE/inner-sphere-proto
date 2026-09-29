// Отладка: ?debug в URL открывает состояние в консоли (window.dbg), напр. dbg.goToCaravan()
import * as THREE from 'three';
import { ROOM, ME, WORLD_SEED, player } from './state.js';
import { P, roomState } from './params.js';
import { camera } from './scene.js';
import { townDir, townToDir, dirToTown, biomeAt, BIOME, bioAxis, bioE1, bioE2, lakeDir, BAND, LAKE_R, TOWN_H } from './world.js';
import { terrainH, surfaceR } from './terrain.js';
import { townObstacles, houses, townPlatforms, houseLocalToTown } from './town.js';
import { trees } from './forest.js';
import { setPitch, keys } from './player.js';
import { house, debugEnter, debugExit } from './house.js';
import { audio, initAudio } from './audio.js';
import { caravan, worldT0, camelSlotDir } from './caravan.js';
import { ride } from './ride.js';
import { bow, arrows } from './bow.js';
import { monster, monsterView, isMonsterHost, debugMonsterHit } from './monster.js';
import { health, damagePlayer } from './health.js';
import { net } from './net.js';
import { isOwner } from './roomsync.js';
import { setParam } from './ui.js';

const _tmp = new THREE.Vector3();
export function installDebug() {
  if (!location.search.includes('debug')) return;
  const { pos, forward } = player;
  window.dbg = {
    P, pos, forward, caravan, camera, initAudio, townDir, townObstacles, townToDir, dirToTown,
    biomeAt, BIOME, bioAxis, lakeDir, trees, terrainH, surfaceR, net, ME, ROOM, WORLD_SEED, roomState, isOwner, setParam,
    player, houses, townPlatforms, house, keys, debugEnter, debugExit, ride, bow, arrows,
    monster, monsterView, isMonsterHost, monsterHit: debugMonsterHit, health, damagePlayer,
    get worldT0() { return worldT0; },
    get audio() { return audio; },
    get playerBiome() { return player.biome; },
    setPitch,
    // встать в направлении d (единичный вектор) лицом к точке target
    goTo(d, target) {
      pos.copy(d).multiplyScalar(P.R - P.EYE);
      forward.copy(target).sub(d);
    },
    // на опушку леса: в 12 м от границы на стороне травы, лицом к центру леса
    goToForest() {
      const d = bioE1.clone().multiplyScalar(Math.cos(BAND - 12 / P.R)).addScaledVector(bioAxis, Math.sin(BAND - 12 / P.R)).normalize();
      this.goTo(d, bioAxis);
    },
    // на берег озера, лицом к его центру
    goToLake(dist = LAKE_R * P.R + 6) {
      const toStart = bioE1.clone().multiplyScalar(Math.cos(-1.4 + Math.PI / 2)).addScaledVector(bioE2, Math.sin(-1.4 + Math.PI / 2));
      const d = lakeDir.clone().multiplyScalar(Math.cos(dist / P.R)).addScaledVector(toStart, Math.sin(dist / P.R)).normalize();
      this.goTo(d, lakeDir);
    },
    // встать у южных ворот города лицом к нему
    goToTown(dist = TOWN_H + 8) {
      const d = townToDir(0, -dist, new THREE.Vector3());
      pos.copy(d).multiplyScalar(P.R - P.EYE);
      forward.copy(townDir).sub(d);
    },
    // встать перед дверью дома idx (в 1.2 м от фасада), лицом к двери
    goToDoor(idx = 0) {
      const h = houses[idx];
      const tp = houseLocalToTown(h, h.doorX, h.d / 2 + 1.2, new THREE.Vector2());
      const d = townToDir(tp.x, tp.y, new THREE.Vector3());
      pos.copy(d).multiplyScalar(P.R - P.EYE);
      const tc = houseLocalToTown(h, h.doorX, 0, new THREE.Vector2());
      forward.copy(townToDir(tc.x, tc.y, new THREE.Vector3())).sub(d);
      player.jumpH = 0; player.jumpV = 0;
    },
    // встать в 12 м позади каравана лицом к нему
    goToCaravan() {
      const back = caravan.trail[0].dir;
      pos.copy(back).multiplyScalar(P.R - P.EYE);
      forward.copy(caravan.dir).sub(back);
    },
    // встать в dist м от лука в лесу, лицом к нему
    goToBow(dist = 6) {
      const d = bow.dir;
      _tmp.set(0, 1, 0); if (Math.abs(_tmp.dot(d)) > 0.9) _tmp.set(1, 0, 0);
      const p = d.clone().addScaledVector(_tmp.addScaledVector(d, -_tmp.dot(d)).normalize(), dist / P.R).normalize();
      pos.copy(p).multiplyScalar(P.R - P.EYE);
      forward.copy(d).sub(p);
      player.jumpH = 0; player.jumpV = 0;
    },
    // встать в dist м перед мордой медведракона, лицом к нему
    goToMonster(dist = 25) {
      const d = monsterView.dir, f = monsterView.fwd;
      const p = d.clone().multiplyScalar(Math.cos(dist / P.R)).addScaledVector(f, Math.sin(dist / P.R)).normalize();
      pos.copy(p).multiplyScalar(P.R - P.EYE);
      forward.copy(d).sub(p);
      player.jumpH = 0; player.jumpV = 0;
    },
    // встать в 1.5 м сбоку от верблюда i (в его текущем слоте), лицом к нему
    goToCamel(i = 0) {
      const d = camelSlotDir(i, new THREE.Vector3());
      const c = caravan.camels[i].group;
      const right = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0).normalize();
      const p = d.clone().addScaledVector(right, 1.5 / P.R).normalize();
      pos.copy(p).multiplyScalar(P.R - P.EYE);
      forward.copy(d).sub(p);
      player.jumpH = 0; player.jumpV = 0;
    },
  };
}
