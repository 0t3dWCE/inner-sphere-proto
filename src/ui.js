// Весь DOM: панель параметров (правый верхний угол), блок сети (слева), оверлей с захватом мыши, HUD.
import * as THREE from 'three';
import { ROOM, ME, PLAYER_COLOR, newId, player } from './state.js';
import { SCHEMA, DEFAULTS, P, STORAGE_KEY, NET_LOCKED, NET_SHARED, NET_PERSONAL, saveParams, sharedValues } from './params.js';
import { renderer } from './scene.js';
import { clearExplored, exploredPct, fowUniforms } from './fow.js';
import { applyRadius } from './terrain.js';
import { townDir, BIOME_NAME } from './world.js';
import { plaques } from './messages.js';
import { caravan } from './caravan.js';
import { initAudio } from './audio.js';
import { net, onNetChange, sendHello } from './net.js';
import { isOwner, ownerName, publishRoomParams, onRoomChange } from './roomsync.js';

// ---------- панель параметров ----------
const form = document.getElementById('params');
const inputs = {};
for (const [key, label, min, max, step] of SCHEMA) {
  const row = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  Object.assign(input, { type: 'number', name: key, min, max, step, value: P[key] });
  if (ROOM && NET_LOCKED.has(key)) { input.disabled = true; input.title = 'В комнате мир общий — параметр фиксирован'; }
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    setParam(key, THREE.MathUtils.clamp(v, min, max));
  });
  row.append(span, input);
  form.appendChild(row);
  inputs[key] = input;
}
form.addEventListener('submit', e => e.preventDefault());
// в комнате общие параметры крутит только владелец — у остальных они только для чтения
const lockHint = document.getElementById('lockHint');
function refreshPanelLock() {
  if (!ROOM) return;
  const owner = isOwner();
  for (const k of NET_SHARED) {
    inputs[k].disabled = !owner;
    inputs[k].title = owner ? 'Общий параметр комнаты — применится у всех' : 'Меняет владелец комнаты';
  }
  const who = ownerName();
  lockHint.style.display = owner ? 'none' : '';
  lockHint.textContent = `Параметры мира задаёт ${who || 'владелец комнаты'}; у вас — только мышь и звук.`;
}
refreshPanelLock();

export function setParam(key, value) {
  if (ROOM && NET_LOCKED.has(key)) return;
  if (ROOM && NET_SHARED.has(key) && !isOwner()) return;
  if (key === 'EYE') value = Math.min(value, P.R / 2);   // глаза не выше центра сферы
  P[key] = value;
  if (key === 'R') { P.EYE = Math.min(P.EYE, P.R / 2); inputs.EYE.value = P.EYE; applyRadius(); }
  if (key === 'TERRAIN_H') applyRadius();   // рельеф зашит в геометрию и позиции объектов
  saveParams();
  if (ROOM && NET_SHARED.has(key)) publishRoomParams();
}
function syncInputs() { for (const k in inputs) inputs[k].value = P[k]; }
onRoomChange(() => { syncInputs(); refreshPanelLock(); });

document.getElementById('clearFow').addEventListener('click', clearExplored);
document.getElementById('reset').addEventListener('click', () => {
  if (ROOM && !isOwner()) {   // не владелец сбрасывает только своё личное
    for (const k of NET_PERSONAL) P[k] = DEFAULTS[k];
    saveParams();
    syncInputs();
    return;
  }
  Object.assign(P, DEFAULTS);
  localStorage.removeItem(STORAGE_KEY);
  syncInputs();
  applyRadius();
  if (ROOM) publishRoomParams();
});

// ---------- блок сети ----------
const netEl = document.getElementById('net');
function renderNetPanel() {
  refreshPanelLock();
  netEl.replaceChildren();
  const add = (tag, props = {}, text) => { const el = Object.assign(document.createElement(tag), props); if (text != null) el.textContent = text; netEl.appendChild(el); return el; };
  if (!ROOM) {
    add('span', {}, 'Одиночный режим');
    add('button', {
      type: 'button', onclick: () => {
        const id = newId().slice(0, 6);
        // создатель — владелец: его текущие параметры мира становятся параметрами комнаты
        localStorage.setItem('inner-sphere-room-' + id, JSON.stringify({ ver: 1, owner: ME.id, values: sharedValues() }));
        location.hash = 'room=' + id;
        location.reload();
      },
    }, 'Создать комнату');
    return;
  }
  const me = add('span');
  me.append(Object.assign(document.createElement('span'), { className: 'dot', style: `background:#${PLAYER_COLOR.getHexString()}` }));
  const nameIn = Object.assign(document.createElement('input'), { value: ME.name, maxLength: 20, title: 'Ваше имя' });
  nameIn.addEventListener('change', () => {
    ME.name = nameIn.value.trim() || ME.name; nameIn.value = ME.name;
    localStorage.setItem('inner-sphere-me', JSON.stringify(ME));
    sendHello();
  });
  me.append(nameIn);
  add('span', {}, `комната ${ROOM} · игроков: ${1 + net.remotes.size}` + (isOwner() ? ' · вы владелец' : ''));
  for (const r of net.remotes.values()) {
    const s = add('span');
    s.append(Object.assign(document.createElement('span'), { className: 'dot', style: `background:#${r.color.getHexString()}` }), r.name);
  }
  add('button', {
    type: 'button', onclick: e => { navigator.clipboard?.writeText(location.href); e.target.textContent = 'Скопировано'; setTimeout(() => e.target.textContent = 'Ссылка', 1500); },
  }, 'Ссылка');
  if (net.status) add('span', { className: 'status' }, net.status);
}
onNetChange(renderNetPanel);

// ---------- оверлей: клик — старт звука и захват мыши ----------
const overlay = document.getElementById('overlay');
overlay.addEventListener('click', () => { initAudio(); renderer.domElement.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => {
  overlay.style.display = document.pointerLockElement ? 'none' : 'flex';
});

// ---------- HUD ----------
const hud = document.getElementById('hud');
export function updateHud(fowOn) {
  const { pos, jumpH, groundH, biome } = player;
  hud.textContent =
    `R=${P.R}  |  позиция: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` +
    `  |  высота над стенкой: ${jumpH.toFixed(2)}  |  табличек: ${plaques.length}` +
    (fowOn ? `  |  разведано: ${exploredPct.toFixed(1)}%` : '') +
    `  |  караван: ${(caravan.dir.angleTo(fowUniforms.uPlayerDir.value) * P.R).toFixed(0)} м` +
    `  |  город: ${(townDir.angleTo(fowUniforms.uPlayerDir.value) * P.R).toFixed(0)} м` +
    `  |  под ногами: ${BIOME_NAME[biome]} (${groundH >= 0 ? '+' : ''}${groundH.toFixed(1)} м)`;
}
