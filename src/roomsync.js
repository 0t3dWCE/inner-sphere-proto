// Параметры комнаты: владелец (создатель) крутит общие параметры мира — они применяются у всех.
// roomState (params.js) — LWW-регистр { ver, owner, values }: ходит в hello и сообщением params,
// побеждает большая версия; лежит в localStorage комнаты, поэтому новичок получает параметры от любого участника.
import { ROOM, ME } from './state.js';
import { P, roomState, sharedValues, applyRoomValues, saveRoomState } from './params.js';
import { applyRadius } from './terrain.js';
import { net, netBroadcast, netStatus, onNet, addHelloFields } from './net.js';

// владелец комнаты — её создатель; у старых комнат без владельца параметры крутит младший занятый слот
export function isOwner() {
  if (!ROOM) return true;
  if (roomState.owner) return roomState.owner === ME.id;
  return net.slot >= 0 && net.slot === Math.min(net.slot, ...net.conns.keys());
}
export function ownerName() {
  if (!roomState.owner) return null;
  if (roomState.owner === ME.id) return ME.name;
  for (const r of net.remotes.values()) if (r.id === roomState.owner) return r.name;
  return 'создатель комнаты (не в сети)';
}

// UI подписывается: после смены параметров/владельца надо обновить поля панели и блокировку
const changeListeners = [];
export function onRoomChange(fn) { changeListeners.push(fn); }
const notify = () => { for (const fn of changeListeners) fn(); };

// владелец поменял параметр: новая версия — всем
export function publishRoomParams() {
  roomState.ver++;
  roomState.values = sharedValues();
  if (!roomState.owner) roomState.owner = ME.id;   // старая комната: первый, кто крутит, становится владельцем
  saveRoomState();
  netBroadcast({ t: 'params', room: roomState });
  notify();
}
// пришло состояние комнаты: применяем, если новее нашего
function receiveRoomState(rs) {
  if (!rs || !(rs.ver > roomState.ver)) return;
  Object.assign(roomState, { ver: rs.ver, owner: rs.owner || roomState.owner, values: rs.values || {} });
  const changed = applyRoomValues(roomState.values);
  if (changed.includes('TERRAIN_H') || changed.includes('EYE')) { P.EYE = Math.min(P.EYE, P.R / 2); applyRadius(); }
  saveRoomState();
  notify();
}
addHelloFields(() => ({ room: roomState }));
onNet('hello', m => receiveRoomState(m.room));
onNet('params', m => { receiveRoomState(m.room); netStatus(''); });
