// Сообщения-шарики и таблички.
// Enter -> печатаем -> Enter: текст превращается в шар "в руке" (справа внизу, ~15% экрана).
// Клик: шар летит туда, куда смотрит камера, притягивается к стенке и, коснувшись её, становится табличкой.
// Таблички — G-Set: записи { id, text, color, n, author, ts } только добавляются, слияние с сетью по id.
import * as THREE from 'three';
import { ROOM, ME, PLAYER_COLOR, onPlayerColor, newId, player } from './state.js';
import { P } from './params.js';
import { renderer, scene, camera } from './scene.js';
import { fogify } from './fow.js';
import { surfaceR } from './terrain.js';
import { addProp } from './props.js';
import { net, netBroadcast, onNet, addHelloFields } from './net.js';

const BALL_R = 0.35;
const PLAQUE_W = 4, PLAQUE_H = 2;
const msgInput = document.getElementById('msg');
const chatHint = document.getElementById('chatHint');
let heldText = null;
export const holding = () => heldText !== null;   // шар в руке — клик бросает его, а не стреляет (bow.js)
const balls = [];           // { mesh, vel, text, remote }
export const plaques = [];  // { mesh, n, rec } — поворачиваем к игроку каждый кадр; HUD показывает их число
const plaqueIds = new Set();   // реестр табличек по id — множество только растёт, слияние с сетью без конфликтов

const ballMats = new Map();    // цвет -> материал (свои и чужие шары)
function ballMaterialFor(color) {
  const key = color.getHex();
  if (!ballMats.has(key)) ballMats.set(key, fogify(new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: .2, roughness: .45,
  })));
  return ballMats.get(key);
}
// шар "в руке" — ребёнок камеры; при FOV 75 и дистанции 2 радиус 0.23 даёт ~15% высоты экрана
const heldBall = new THREE.Mesh(new THREE.SphereGeometry(0.23, 32, 16), ballMaterialFor(PLAYER_COLOR));
onPlayerColor(c => { heldBall.material = ballMaterialFor(c); });   // уже поставленные таблички остаются своего цвета
heldBall.position.set(1.05, -0.5, -2);
heldBall.visible = false;
camera.add(heldBall);
scene.add(camera);   // иначе дети камеры не рендерятся

document.getElementById('chat').addEventListener('submit', e => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (text) {
    heldText = text;
    heldBall.visible = true;
    chatHint.textContent = `В руке: «${text}» — клик, чтобы бросить`;
    msgInput.value = '';
  }
  msgInput.blur();
});

function spawnBall(position, vel, text, color, remote) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 12), ballMaterialFor(color));
  mesh.position.copy(position);
  scene.add(mesh);
  balls.push({ mesh, vel: vel.clone(), text, remote });
}
function throwBall() {
  if (!heldText || player.inside) return;   // внутри дома шар бросить некуда — мир снаружи
  const p = heldBall.getWorldPosition(new THREE.Vector3());
  const vel = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(P.THROW_SPEED);
  spawnBall(p, vel, heldText, PLAYER_COLOR, false);
  netBroadcast({ t: 'ball', text: heldText, color: PLAYER_COLOR.getHex(), p: p.toArray(), v: vel.toArray() });
  heldText = null;
  heldBall.visible = false;
  chatHint.textContent = 'Enter — «слепить» шар из сообщения · клик — бросить туда, куда смотришь';
}
// до канваса клик доходит только при захваченной мыши — иначе его перекрывает оверлей
renderer.domElement.addEventListener('mousedown', e => { if (e.button === 0) throwBall(); });

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
      else line = test;
    }
    lines.push(line);
  }
  return lines;
}

function makePlaque(text, color = PLAYER_COLOR) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const frame = '#' + color.getHexString();
  g.fillStyle = 'rgba(20,20,28,.88)';
  g.fillRect(0, 0, c.width, c.height);
  g.lineWidth = 14;
  g.strokeStyle = frame;
  g.strokeRect(7, 7, c.width - 14, c.height - 14);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 40, lines;
  do {                                      // подбираем кегль так, чтобы текст влез
    g.font = `600 ${size}px system-ui, sans-serif`;
    lines = wrapText(g, text, c.width - 60);
    size -= 4;
  } while (lines.length * size * 1.25 > c.height - 50 && size > 14);
  const lh = size * 1.25 + 4;
  const y0 = c.height / 2 - (lines.length - 1) * lh / 2;
  lines.forEach((l, i) => g.fillText(l, c.width / 2, y0 + i * lh));

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return new THREE.Mesh(
    new THREE.PlaneGeometry(PLAQUE_W, PLAQUE_H),
    fogify(new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }))
  );
}

// табличка из записи { id, text, color, n:[x,y,z], author, ts }; повторы по id игнорируются
function addPlaque(rec) {
  if (plaqueIds.has(rec.id)) return false;
  plaqueIds.add(rec.id);
  const n = new THREE.Vector3().fromArray(rec.n).normalize();
  const plaque = makePlaque(rec.text, new THREE.Color(rec.color));
  addProp(plaque, n, PLAQUE_H);                    // стоит на стенке, переезжает при смене радиуса
  plaques.push({ mesh: plaque, n, rec });
  return true;
}
const plaqueList = () => plaques.map(p => p.rec);
function landBall(b) {
  scene.remove(b.mesh);
  b.mesh.geometry.dispose();
  if (b.remote) return;   // чужой шар: табличку пришлёт автор — точка приземления его, чтобы не разъехалось
  const rec = {
    id: newId(), text: b.text, color: PLAYER_COLOR.getHex(),
    n: b.mesh.position.clone().normalize().toArray(), author: ME.name, ts: Date.now(),
  };
  addPlaque(rec);
  savePlaques();
  netBroadcast({ t: 'plaque', rec });
}

// ---- хранение и сеть ----
// Набор табличек комнаты лежит в localStorage: после F5 они на месте ещё до соединения.
const PLAQUES_KEY = 'inner-sphere-plaques-' + ROOM;
function savePlaques() {
  if (!ROOM) return;
  try { localStorage.setItem(PLAQUES_KEY, JSON.stringify(plaqueList().slice(-300))); } catch { /* переполнено — не страшно */ }
}
export function loadPlaques() {
  if (!ROOM) return;
  try { for (const rec of JSON.parse(localStorage.getItem(PLAQUES_KEY) || '[]')) addPlaque(rec); } catch { /* битый кэш */ }
}
addHelloFields(() => ({ plaques: plaqueList() }));
onNet('hello', m => {
  let added = 0;
  for (const rec of m.plaques || []) if (rec && rec.id && addPlaque(rec)) added++;
  if (added) savePlaques();
});
onNet('ball', (m, slot) => {
  const r = net.remotes.get(slot);
  spawnBall(new THREE.Vector3().fromArray(m.p), new THREE.Vector3().fromArray(m.v), m.text,
            new THREE.Color(m.color ?? (r ? r.color.getHex() : 0xffffff)), true);
});
onNet('plaque', m => { if (m.rec && m.rec.id && addPlaque(m.rec)) savePlaques(); });

// ---- кадр ----
const _g = new THREE.Vector3(), _pu = new THREE.Vector3(), _pz = new THREE.Vector3(), _px = new THREE.Vector3(), _m = new THREE.Matrix4();
export function updateMessages(dt) {
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    // притяжение к стенке: ускорение направлено от центра
    _g.copy(b.mesh.position).normalize().multiplyScalar(P.GRAVITY);
    b.vel.addScaledVector(_g, dt);
    b.mesh.position.addScaledVector(b.vel, dt);
    _pu.copy(b.mesh.position).normalize();
    if (b.mesh.position.length() >= surfaceR(_pu) - BALL_R) { landBall(b); balls.splice(i, 1); }
  }
  // таблички: стоят на стенке (Y = к центру), лицевой стороной (+Z) к игроку
  for (const p of plaques) {
    _pu.copy(p.n).negate();
    _pz.copy(player.pos).sub(p.mesh.position);
    _pz.addScaledVector(_pu, -_pz.dot(_pu));
    if (_pz.lengthSq() < 1e-6) continue;
    _pz.normalize();
    _px.crossVectors(_pu, _pz);
    p.mesh.quaternion.setFromRotationMatrix(_m.makeBasis(_px, _pu, _pz));
  }
}
