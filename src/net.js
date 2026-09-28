// Сеть: PeerJS — транспорт, слоты, присутствие (аватары чужих игроков) и протокол-«шина».
// Комнат у PeerJS нет — id пиров детерминированные: inner-sphere-<room>-<slot>, slot 0..4. При входе занимаем
// первый свободный слот (ошибка unavailable-id -> следующий) и соединяемся со всеми занятыми: полный mesh.
// Инициирует соединение тот, у кого слот больше (иначе оба откроют по каналу); раз в 4 с добираем недостающих.
// Публичный сигналинг 0.peerjs.com, в нём же STUN/TURN. Один надёжный JSON-канал на пару.
//
// Сообщения (поле t):
//   hello  — имя, цвет + поля от других модулей (t0 — caravan.js, plaques — messages.js, room — roomsync.js)
//   pos    — позиция/взгляд/прыжок, ~12 Гц (обрабатывается здесь)
//   ball, plaque — messages.js;  params — roomsync.js
// Модули подписываются через onNet(type, fn) и добавляют свои поля в hello через addHelloFields(fn) —
// так net.js не зависит от игровой логики, а она — только от него.
import * as THREE from 'three';
import { ROOM, ME, PLAYER_COLOR, player } from './state.js';
import { scene } from './scene.js';
import { fogify } from './fow.js';
import { surfaceR } from './terrain.js';

export const NET_MAX = 5, POS_HZ = 12;
export const net = { peer: null, slot: -1, conns: new Map(), remotes: new Map(), pending: new Map(), status: '' };

// ---- шина ----
const handlers = new Map();          // тип сообщения -> [fn(msg, slot)]
export function onNet(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); }
const helloFields = [];              // [fn() -> объект], сливаются в hello
export function addHelloFields(fn) { helloFields.push(fn); }
const changeListeners = [];          // UI: перерисовать блок сети при любом изменении статуса/состава
export function onNetChange(fn) { changeListeners.push(fn); }

export function netBroadcast(msg) {
  for (const c of net.conns.values()) if (c.open) c.send(msg);
}
export function netStatus(s) {
  if (s !== undefined) net.status = s;
  for (const fn of changeListeners) fn();
}
const helloMsg = () => Object.assign({ t: 'hello', id: ME.id, name: ME.name, color: PLAYER_COLOR.getHex() }, ...helloFields.map(f => f()));
export function sendHello() { netBroadcast(helloMsg()); }

const slotId = s => `inner-sphere-${ROOM}-${s}`;
const slotOf = peerId => parseInt(peerId.split('-').pop(), 10);

// ---- слоты и соединения ----
export function netStart() {
  if (!ROOM || typeof Peer === 'undefined') { netStatus(); return; }
  netStatus('подключение…');
  claimSlot(0);
}
function claimSlot(s) {
  if (s >= NET_MAX) { netStatus('комната полна (5 человек)'); return; }
  const peer = new Peer(slotId(s), { debug: 1 });
  peer.on('open', () => {
    net.peer = peer; net.slot = s;
    netStatus('');
    dialOthers();
    setInterval(dialOthers, 4000);
  });
  peer.on('connection', attachConn);
  peer.on('disconnected', () => { netStatus('переподключение…'); setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 1000); });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { peer.destroy(); claimSlot(s + 1); return; }
    if (e.type === 'peer-unavailable') {                       // слот пуст — норма; снимаем «набираем»
      const m = String(e.message).match(/-(\d+)$/); if (m) net.pending.delete(parseInt(m[1], 10));
      return;
    }
    console.warn('peer error', e.type, e);
    netStatus('сеть: ' + e.type);
    if (!net.peer) setTimeout(() => claimSlot(0), 3000);        // не смогли даже занять слот — пробуем позже
  });
}
function dialOthers() {
  if (!net.peer || net.peer.disconnected) return;
  const now = Date.now();
  for (let s = 0; s < net.slot; s++) {                          // звоним только «вниз»
    if (net.conns.has(s)) continue;
    if (now - (net.pending.get(s) || 0) < 8000) continue;
    net.pending.set(s, now);
    attachConn(net.peer.connect(slotId(s), { reliable: true, serialization: 'json' }));
  }
}
function attachConn(conn) {
  const slot = slotOf(conn.peer);
  conn.on('open', () => {
    net.pending.delete(slot);
    const old = net.conns.get(slot);
    if (old && old !== conn) old.close();
    net.conns.set(slot, conn);
    conn.send(helloMsg());
    netStatus('');
  });
  conn.on('data', m => onNetData(slot, m));
  const gone = () => {
    net.pending.delete(slot);
    if (net.conns.get(slot) !== conn) return;
    net.conns.delete(slot);
    removeRemote(slot);
    netStatus('');
  };
  conn.on('close', gone);
  conn.on('error', gone);
}

// ---- удалённые игроки: цилиндр цвета игрока, голова с «носом» по взгляду, имя над головой ----
function makeAvatar(color, name) {
  const g = new THREE.Group();
  const mat = fogify(new THREE.MeshStandardMaterial({ color, roughness: .7 }));
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 1.35, 14), mat); body.position.y = 0.675;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), fogify(new THREE.MeshStandardMaterial({ color: 0xf1d3b3, roughness: .8 }))); head.position.y = 1.62;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 8), mat); nose.rotation.x = -Math.PI / 2; nose.position.set(0, 1.62, -0.3);
  g.add(body, head, nose, makeNameSprite(name, color));
  return g;
}
function makeNameSprite(name, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#' + color.getHexString(); g.fillRect(0, 0, 10, 64);
  g.fillStyle = '#fff'; g.font = '600 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(name.slice(0, 16), 133, 34);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.scale.set(1.8, 0.45, 1); sp.position.y = 2.15;
  sp.name = 'label';
  return sp;
}
function upsertRemote(slot, msg) {
  let r = net.remotes.get(slot);
  const color = new THREE.Color(msg.color);
  if (r && (r.name !== msg.name || r.color.getHex() !== color.getHex())) { scene.remove(r.group); r = null; }
  if (!r) {
    r = { id: msg.id, name: msg.name, color, group: makeAvatar(color, msg.name),
          pos: null, target: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, -1), tfwd: new THREE.Vector3(0, 0, -1), jump: 0 };
    r.group.visible = false;
    scene.add(r.group);
    net.remotes.set(slot, r);
  }
  r.id = msg.id;
  return r;
}
function removeRemote(slot) {
  const r = net.remotes.get(slot);
  if (!r) return;
  scene.remove(r.group);
  net.remotes.delete(slot);
}
function onNetData(slot, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') upsertRemote(slot, m);           // сначала присутствие — подписчикам нужен remote
  if (m.t === 'pos') {
    const r = net.remotes.get(slot);
    if (!r) return;
    r.target.fromArray(m.p);
    r.tfwd.fromArray(m.f);
    r.jump = m.j || 0;
    if (!r.pos) { r.pos = r.target.clone(); r.fwd.copy(r.tfwd); r.group.visible = true; }
    return;
  }
  for (const fn of handlers.get(m.t) || []) fn(m, slot);
  if (m.t === 'hello') netStatus('');
}

// каждый кадр: своя позиция ~12 Гц, чужие — интерполяция к последней известной
let netAcc = 0;
const _ru = new THREE.Vector3(), _rr = new THREE.Vector3(), _rm = new THREE.Matrix4();
export function updateNet(dt) {
  if (!ROOM) return;
  netAcc += dt;
  if (netAcc >= 1 / POS_HZ && net.conns.size) {
    netAcc = 0;
    netBroadcast({ t: 'pos', p: player.pos.toArray(), f: player.forward.toArray(), j: player.jumpH });
  }
  const k = 1 - Math.exp(-dt * 12);
  for (const r of net.remotes.values()) {
    if (!r.pos) continue;
    r.pos.lerp(r.target, k);
    r.fwd.lerp(r.tfwd, k);
    _ru.copy(r.pos).normalize();                                  // направление на игрока
    r.fwd.addScaledVector(_ru, -r.fwd.dot(_ru)).normalize();      // взгляд — в касательной плоскости
    _rr.crossVectors(r.fwd, _ru.clone().negate()).normalize();    // right = forward × up
    r.group.position.copy(_ru).multiplyScalar(surfaceR(_ru) - r.jump);   // ноги на земле
    _rm.makeBasis(_rr, _ru.clone().negate(), r.fwd.clone().negate());
    r.group.quaternion.setFromRotationMatrix(_rm);
  }
}
addEventListener('pagehide', () => { if (net.peer) net.peer.destroy(); });   // освобождаем слот сразу
