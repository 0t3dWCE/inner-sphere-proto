// Разговор с тем, кто рядом. Кнопка и клавиша T пишут микрофон и шлют его
// локальному sidecar (ws://127.0.0.1:8770/talk). Ответ играет у рта актёра.
// M по-прежнему только голос между игроками.
import * as THREE from 'three';
import { player } from './state.js';
import { P, SCHEMA } from './params.js';
import { scene } from './scene.js';
import { audio, initAudio } from './audio.js';
import { net, netBroadcast, onNet } from './net.js';
import { talkSnapshot, npcMouth, npcOrder, npcAct } from './npc.js';
import { monster } from './monster.js';
import { setParam } from './ui.js';
import { plantAround } from './plant.js';

const URL = 'ws://127.0.0.1:8770/talk';
const btn = document.getElementById('talk');
const lineEl = document.getElementById('talkLine');

let ws = null;
let recording = false;
let chunks = [];
let mic = null;
let lastRoom = new Map();
let playQ = Promise.resolve();

function setLine(text) {
  lineEl.textContent = text || '';
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(URL);
  ws.onopen = () => {
    btn.disabled = false;
    btn.title = 'Удерживайте, чтобы говорить с тем, кто рядом. Клавиша T.';
    ws.send(JSON.stringify({ t: 'hello', slot: net.slot, capabilities: { follow: true } }));
  };
  ws.onclose = () => {
    btn.disabled = false;
    btn.title = 'Помощник не запущен. В терминале: ~/venvs/kokoro/bin/python sidecar.py';
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'heard') setLine('услышал: ' + m.text);
    if (m.t === 'line') {
      if (m.text) setLine(m.text);
      if (m.order && m.actor !== 'world') npcOrder(m.actor, m.order);
      if (m.act && m.actor !== 'world') npcAct(m.actor, m.act);
      if (Array.isArray(m.tunes)) for (const change of m.tunes) {
        if (change && change.key != null) setParam(change.key, change.value);
      }
      if (Array.isArray(m.plants)) for (const p of m.plants) {
        if (p && (p.what === 'tree' || p.what === 'palm')) plantAround(p.what, p.n);
      }
      if (m.wav) {
        const actor = m.actor === 'world'
          ? { id: 'world', kind: 'world', st: 'out' }
          : lastRoom.get(m.actor);
        enqueuePlay(m.wav, actor);
        netBroadcast({ t: 'say', id: m.actor, text: m.text, wav: m.wav });
      }
    }
    if (m.t === 'rejected') setLine(m.reason);
    if (m.t === 'await_player' || m.t === 'rejected') {
      btn.classList.remove('busy');
      btn.textContent = 'говорить';
    }
  };
}

function roomNow() {
  const room = talkSnapshot(P.VOICE_R);
  if (player.inside || monster.hp <= 0 || monster.st === 'dead') return room;
  const arcM = Math.round(player.pos.clone().normalize().angleTo(monster.dir) * P.R * 10) / 10;
  if (arcM <= P.VOICE_R) {
    room.push({
      id: 300, kind: 'monster', name: 'Медведракон', hp: monster.hp, st: monster.st,
      arcM, place: 'лес', monsterSt: monster.st,
    });
  }
  return room;
}

async function armMic() {
  if (mic) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  proc.onaudioprocess = e => {
    if (!recording) return;
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  mic = { rate: ctx.sampleRate };
}

async function startRec() {
  if (recording) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setLine('помощник не запущен');
    return;
  }
  initAudio();
  try { await armMic(); }
  catch {
    setLine('микрофон недоступен');
    return;
  }
  chunks = [];
  recording = true;
  btn.classList.add('on');
  btn.textContent = 'говорите…';
}

function stopRec() {
  if (!recording) return;
  recording = false;
  btn.classList.remove('on');
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  let peak = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  if (samples < (mic.rate / 5)) {
    chunks = [];
    setLine('слишком коротко, удерживайте кнопку');
    btn.classList.remove('busy');
    btn.textContent = 'говорить';
    return;
  }
  if (peak < 0.04) {
    chunks = [];
    setLine('микрофон молчит');
    btn.classList.remove('busy');
    btn.textContent = 'говорить';
    return;
  }
  const wav = encodeWav(chunks, mic.rate);
  chunks = [];
  const room = roomNow();
  lastRoom = new Map(room.map(a => [a.id, a]));
  const params = Object.fromEntries(SCHEMA.map(([k]) => [k, P[k]]));
  btn.classList.add('busy');
  btn.textContent = 'думает…';
  ws.send(JSON.stringify({ t: 'hear', wav: b64(wav), room, params }));
}

function enqueuePlay(b64wav, actor) {
  playQ = playQ.then(() => playOne(b64wav, actor)).catch(() => {});
}

function playOne(b64wav, actor) {
  if (!audio) initAudio();
  const bytes = Uint8Array.from(atob(b64wav), c => c.charCodeAt(0));
  const copy = bytes.buffer.slice(0);
  return audio.ctx.decodeAudioData(copy).then(buffer => new Promise(resolve => {
    const asWorld = actor && actor.kind === 'world';
    const indoor = asWorld || (player.inside && actor && actor.st === 'in');
    const sound = indoor ? new THREE.Audio(audio.listener) : new THREE.PositionalAudio(audio.listener);
    sound.setBuffer(buffer);
    let anchor = null;
    if (!indoor) {
      sound.setRefDistance(7);
      sound.setMaxDistance(Math.max(8, P.VOICE_R));
      sound.setDistanceModel('linear');
      anchor = new THREE.Object3D();
      if (!actor || actor.kind === 'monster' || !npcMouth(actor.id, anchor.position)) {
        if (actor && actor.kind === 'monster') anchor.position.copy(monster.dir).normalize().multiplyScalar(P.R - 4);
        else anchor.position.copy(player.pos);
      }
      scene.add(anchor);
      anchor.add(sound);
    }
    sound.onEnded = () => { if (anchor) scene.remove(anchor); resolve(); };
    sound.play();
  }));
}

function encodeWav(parts, rate) {
  let n = 0;
  for (const c of parts) n += c.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of parts) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const typing = e => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
addEventListener('keydown', e => {
  if (e.code !== 'KeyT' || e.repeat || typing(e)) return;
  startRec();
});
addEventListener('keyup', e => { if (e.code === 'KeyT') stopRec(); });

btn.addEventListener('pointerdown', e => {
  e.preventDefault();
  btn.setPointerCapture(e.pointerId);
  startRec();
});
btn.addEventListener('pointerup', stopRec);
btn.addEventListener('pointercancel', stopRec);

onNet('say', m => {
  if (!m || !m.wav) return;
  setLine(m.text || '');
  enqueuePlay(m.wav, m.id === 300 ? { id: 300, kind: 'monster', st: 'out' } : { id: m.id, st: 'out' });
});

connect();
