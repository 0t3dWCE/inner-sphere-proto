// Параметры мира: схема панели, значения по умолчанию, живой объект P (читается каждый кадр),
// сохранение в localStorage и LWW-регистр параметров комнаты (roomState).
import * as THREE from 'three';
import { ROOM } from './state.js';

// [ключ, подпись, min, max, step]
export const SCHEMA = [
  ['R',          'Радиус сферы',          10,     500,  5],
  ['EYE',        'Высота глаз',           0.5,    50,   0.1],
  ['SPEED',      'Скорость ходьбы',       1,      200,  1],
  ['JUMP_V',     'Скорость прыжка',       0,      50,   0.5],
  ['GRAVITY',    'Гравитация (к стенке)', 0.1,    100,  0.5],
  ['MOUSE_SENS', 'Чувствительность мыши', 0.0005, 0.01, 0.0005],
  ['THROW_SPEED', 'Скорость броска',      5,      300,  5],
  ['ARROW_SPEED', 'Скорость стрелы',      10,     300,  5],
  ['FOW',        'Туман войны (0/1)',     0,      1,    1],
  ['FOW_R',      'Радиус видимости (×R)', 0.1,    1.5,  0.05],
  ['FOW_MEMORY', 'Яркость разведанного',  0,      1,    0.05],
  ['CAMEL_SPEED', 'Скорость каравана',    0,      30,   0.5],
  ['TAME_T',     'Приручение верблюда (с)', 1,    300,  1],
  ['RIDE_BONUS', 'Верблюд: +скорость',    0,      100,  1],
  ['SOUND_R',    'Радиус звука каравана', 0,      200,  1],
  ['VOLUME',     'Громкость',             0,      1,    0.05],
  ['STEPS',      'Громкость шагов',       0,      1,    0.05],
  ['SKY_H',      'Высота неба (0 — нет)', 0,      200,  1],
  ['SKY_CLOUDS', 'Облачность',            0,      1,    0.05],
  ['HAZE',       'Дымка: дальность (м)',  20,     2000, 5],
  ['AMBIENCE',   'Звуки леса/города (0/1)', 0,    1,    1],
  ['TERRAIN_H',  'Рельеф: высота холмов (м)', 0,  20,   0.5],
];
export const DEFAULTS = {
  R: 80, EYE: 1.7, SPEED: 12, JUMP_V: 7, GRAVITY: 18, MOUSE_SENS: 0.0022, THROW_SPEED: 45, ARROW_SPEED: 60,
  FOW: 1, FOW_R: 0.4, FOW_MEMORY: 0.35, CAMEL_SPEED: 2.5, TAME_T: 45, RIDE_BONUS: 10, SOUND_R: 25, VOLUME: 0.6, STEPS: 0.5,
  SKY_H: 30, SKY_CLOUDS: 0.5, HAZE: 110, AMBIENCE: 1, TERRAIN_H: 5,
};
export const STORAGE_KEY = 'inner-sphere-params';

function loadParams() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const p = { ...DEFAULTS };
    for (const [k, , min, max] of SCHEMA)
      if (Number.isFinite(saved[k])) p[k] = THREE.MathUtils.clamp(saved[k], min, max);
    return p;
  } catch { return { ...DEFAULTS }; }
}
export const P = loadParams();   // живые параметры; читаются каждый кадр
export function saveParams() { localStorage.setItem(STORAGE_KEY, JSON.stringify(P)); }

// ---------- параметры в комнате ----------
export const NET_LOCKED = new Set(['R', 'CAMEL_SPEED']);           // в комнате мир общий — эти параметры фиксированы
if (ROOM) for (const k of NET_LOCKED) P[k] = DEFAULTS[k];
// Параметры мира в комнате задаёт её создатель (owner) — они рассылаются всем. Личные (мышь, громкость) — у каждого свои.
// Хранится как LWW-регистр { ver, owner, values }: больший ver выигрывает, лежит в localStorage комнаты.
export const NET_PERSONAL = new Set(['MOUSE_SENS', 'VOLUME', 'SOUND_R', 'STEPS']);
export const NET_SHARED = new Set(SCHEMA.map(s => s[0]).filter(k => !NET_PERSONAL.has(k) && !NET_LOCKED.has(k)));
export const ROOM_KEY = 'inner-sphere-room-' + ROOM;
export const roomState = { ver: 0, owner: null, values: {} };
export const sharedValues = () => Object.fromEntries([...NET_SHARED].map(k => [k, P[k]]));
export function applyRoomValues(values) {   // -> список изменившихся ключей
  const changed = [];
  for (const [k, , min, max] of SCHEMA) {
    if (!NET_SHARED.has(k) || !Number.isFinite(values[k])) continue;
    const v = THREE.MathUtils.clamp(values[k], min, max);
    if (v !== P[k]) { P[k] = v; changed.push(k); }
  }
  return changed;
}
export function saveRoomState() { try { localStorage.setItem(ROOM_KEY, JSON.stringify(roomState)); } catch { /* ок */ } }
if (ROOM) {
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_KEY) || 'null');
    if (saved && saved.ver > 0) { Object.assign(roomState, saved); applyRoomValues(roomState.values); }
  } catch { /* нет сохранённого состояния */ }
}
