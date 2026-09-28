// Общее состояние, которое читают/пишут несколько модулей. Сам никого не импортирует (кроме three) —
// это «дно» графа зависимостей: любой модуль может взять отсюда что угодно, не рискуя циклом.
import * as THREE from 'three';

// ---------- комната, личность, seed ----------
// Комната — в хеше URL (#room=abc123). Весь мир генерируется из seed'а комнаты (город, пропсы, лес, караван),
// поэтому у всех участников он одинаковый без передачи по сети; вне комнаты seed случайный.
export const ROOM = (location.hash.match(/room=([A-Za-z0-9_-]{1,32})/) || [])[1] || null;

export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(a) {
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export const WORLD_SEED = ROOM ? hash32('inner-sphere:' + ROOM) : (Math.random() * 4294967296) >>> 0;
export const rand = mulberry32(WORLD_SEED);                        // генерация мира
export const randCaravan = mulberry32(WORLD_SEED ^ 0x9e3779b9);    // повороты каравана (детерминированная симуляция)

// ВАЖНО: порядок вызовов rand() определяет мир. Он задаётся порядком шагов сборки в main.js
// (townDir → лес → пропсы → город → караван → погонщики) — не переставлять.

export const ME = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('inner-sphere-me') || 'null');
    if (saved && saved.id && saved.name) return saved;
  } catch { /* новый игрок */ }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');
  const me = { id, name: 'Игрок-' + id.slice(0, 4) };
  localStorage.setItem('inner-sphere-me', JSON.stringify(me));
  return me;
})();
export const colorOf = id => new THREE.Color().setHSL((hash32('c:' + id) % 360) / 360, 0.72, 0.55);
export const PLAYER_COLOR = colorOf(ME.id);   // цвет игрока — из его id, одинаков у всех участников
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');

// ---------- геометрические константы мира ----------
// Старт игрока — на "экваторе" в START_DIR (вдали от полюсов UV-сетки)
export const START_DIR = new THREE.Vector3(1, 0, 0);
// случайное единичное направление из seeded-RNG мира
export function randomDir() {
  const v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
  return v.lengthSq() < 1e-4 ? randomDir() : v.normalize();
}

// ---------- игрок ----------
// pos — позиция глаз. Гравитация направлена от центра к стенке, поэтому "верх" = -normalize(pos).
// Контейнер, а не отдельные let: его пишут player.js (движение), ui/debug (телепорт), читают net, fow, messages, caravan.
export const player = {
  pos: new THREE.Vector3(),                  // заполняется в player.js: START_DIR · (R − EYE)
  forward: new THREE.Vector3(0, 0, -1),      // касательное направление взгляда
  pitch: 0,                                  // наклон камеры вверх/вниз
  jumpH: 0, jumpV: 0,                        // высота над стенкой (прыжок) и скорость
  biome: 0,                                  // BIOME.GRASS; обновляется каждый кадр в updatePlayer
  groundH: 0,                                // высота рельефа под ногами (м), для HUD
  inside: null,                              // внутри дома: { house: idx, floor } — иначе null (house.js)
  rideH: 0,                                  // подъём глаз над землёй, когда сидим на верблюде (ride.js)
  speedBonus: 0,                             // прибавка к скорости ходьбы, м/с (ride.js)
};

// общие часы кадра: elapsedTime — анимации каравана и тумана войны, getDelta — в tick
export const clock = new THREE.Clock();
