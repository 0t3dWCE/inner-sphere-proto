// Голос в комнате: PeerJS media-звонок на каждую пару игроков поверх того же mesh (звонит больший слот, как и в данных).
// Исходящий трек — тишина (MediaStreamDestination), пока игрок не включит микрофон (кнопка в блоке сети или M): тогда
// трек меняется на микрофон через RTCRtpSender.replaceTrack — без повторных переговоров; выключение — track.enabled.
// Так других слышно и без доступа к микрофону. Звонки начинаются, когда запущен звук (первый клик): до этого входящие
// ждут ответа, а слушать всё равно нечем.
// Входящий голос: MediaStreamSource → gain → PannerNode (equalpower) → voiceBus → destination, мимо общей громкости игры.
// Панорама стоит у рта аватара, слушатель — камера (THREE.AudioListener): собеседник справа — в правом канале.
// Громкость по расстоянию — линейно: до VOICE_NEAR м полная, к P.VOICE_R — ноль. Снаружи слышно тех, кто снаружи;
// в доме — только тех, кто в том же доме (их позиция в координатах дома приходит в pos полем hi).
import * as THREE from 'three';
import { ROOM, player } from './state.js';
import { P } from './params.js';
import { net, slotId, slotOf, addPosFields, onNetChange, netStatus } from './net.js';
import { audio, initAudio, onAudioReady } from './audio.js';
import { house } from './house.js';

const VOICE_NEAR = 7;       // м — ближе слышно в полную силу
const HEAD = 1.6;           // рот над ногами (и снаружи, и в доме)
const SPEAK_LVL = 0.015;    // RMS сигнала — «говорит»
const SPEAK_HOLD = 0.35;    // с — значок не мигает между словами
const ORPHAN_T = 10000;     // мс — входящий звонок без канала данных дольше этого считаем мёртвым

// peers: slot -> { call, conn, t0, nodes, el, level, speakT, icon }
export const voice = { mic: false, micTrack: null, error: '', level: 0, peers: new Map() };

let ready = false, silent = null, voiceBus = null, micAn = null, micBuf = null, hookedPeer = null;
const pendingIn = new Map();   // slot -> входящий звонок, пришедший до запуска звука

const outTrack = () => voice.micTrack || silent;

onAudioReady(a => {
  if (!ROOM) return;
  silent = a.ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
  voiceBus = a.ctx.createGain();
  voiceBus.gain.value = P.VOICE_VOL;
  voiceBus.connect(a.ctx.destination);
  ready = true;
  for (const c of pendingIn.values()) accept(c);
  pendingIn.clear();
  sync();
});

function onCall(c) {
  const s = slotOf(c.peer);
  if (!ready) { pendingIn.get(s)?.close(); pendingIn.set(s, c); return; }
  accept(c);
}
function accept(c) {
  const s = slotOf(c.peer);
  drop(s);
  c.answer(new MediaStream([outTrack()]));
  bind(s, c);
}
function dial(s) {
  const c = net.peer.call(slotId(s), new MediaStream([outTrack()]));
  if (c) bind(s, c);
}
function bind(s, c) {
  const v = { call: c, conn: net.conns.get(s) || null, t0: Date.now(), nodes: null, el: null, level: 0, speakT: 0, icon: null };
  voice.peers.set(s, v);
  c.on('stream', st => { if (voice.peers.get(s) === v && !v.nodes) attach(v, st); });   // бывает и дважды — по треку
  const end = () => { if (voice.peers.get(s) === v) drop(s); };
  c.on('close', end);
  c.on('error', end);
}
function attach(v, stream) {
  const { ctx } = audio;
  // Chrome не отдаёт удалённый WebRTC-поток в Web Audio, пока он не подключён к медиаэлементу — держим немой <audio>
  v.el = new Audio();
  v.el.muted = true;
  v.el.srcObject = stream;
  v.el.play().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser(); an.fftSize = 512;
  const gain = ctx.createGain(); gain.gain.value = 0;
  const pan = ctx.createPanner();
  pan.panningModel = 'equalpower';   // HRTF рассчитан на наушники и на колонках разводит лево/право всего на ~6 дБ
  pan.distanceModel = 'linear';
  pan.refDistance = VOICE_NEAR;
  pan.maxDistance = Math.max(VOICE_NEAR + 1, P.VOICE_R);
  pan.rolloffFactor = 1;
  // WebRTC отдаёт стерео, а стерео-вход equalpower сбоку удваивает (+6 дБ) — сводим в моно, громкость не зависит от поворота
  pan.channelCount = 1;
  pan.channelCountMode = 'explicit';
  src.connect(an);
  src.connect(gain).connect(pan).connect(voiceBus);
  v.nodes = { src, an, gain, pan, buf: new Float32Array(an.fftSize), placed: false };
}
function drop(s) {
  const v = voice.peers.get(s);
  if (!v) return;
  voice.peers.delete(s);
  try { v.call.close(); } catch { /* уже закрыт */ }
  if (v.nodes) { v.nodes.src.disconnect(); v.nodes.pan.disconnect(); if (v.nodes.probe) v.nodes.probe.split.disconnect(); }
  if (v.el) { v.el.pause(); v.el.srcObject = null; }
  if (v.icon) v.icon.removeFromParent();
}

// звонки следуют за каналами данных: канал пропал или сменился (собеседник перезагрузился) — звонок в мусор;
// звонит тот, у кого слот больше, недостающим — раз в 3 с и при каждом изменении состава
function sync() {
  if (!ROOM || !net.peer) return;
  if (net.peer !== hookedPeer) { hookedPeer = net.peer; net.peer.on('call', onCall); }
  const now = Date.now();
  for (const [s, v] of voice.peers) {
    const conn = net.conns.get(s);
    if (!v.conn && conn) v.conn = conn;
    const st = v.call.peerConnection && v.call.peerConnection.connectionState;
    if ((v.conn && conn !== v.conn) || (!conn && now - v.t0 > ORPHAN_T) || st === 'failed' || st === 'closed') drop(s);
  }
  if (!ready || net.peer.disconnected) return;
  for (const s of net.conns.keys()) if (s < net.slot && !voice.peers.has(s)) dial(s);
}
onNetChange(sync);
if (ROOM) setInterval(sync, 3000);

function setOutTrack(track) {
  for (const v of voice.peers.values()) {
    const pc = v.call.peerConnection;
    if (!pc) continue;
    for (const snd of pc.getSenders()) if (!snd.track || snd.track.kind === 'audio') snd.replaceTrack(track).catch(() => {});
  }
}
function useMicTrack(track) {
  voice.micTrack = track;
  micAn = audio.ctx.createAnalyser(); micAn.fftSize = 512; micBuf = new Float32Array(micAn.fftSize);
  audio.ctx.createMediaStreamSource(new MediaStream([track])).connect(micAn);
  track.addEventListener('ended', () => {            // микрофон отключили в системе или отозвали разрешение
    if (voice.micTrack !== track) return;
    voice.micTrack = null; voice.mic = false; micAn = null;
    setOutTrack(silent);
    netStatus();
  });
  setOutTrack(track);
}

export async function toggleMic() {
  if (!ROOM) return;
  if (!audio) initAudio();                             // клик по кнопке — тоже жест пользователя
  if (!voice.micTrack) {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      useMicTrack(st.getAudioTracks()[0]);
      voice.error = '';
      voice.mic = true;
    } catch (e) {
      console.warn('mic', e);
      voice.error = 'микрофон недоступен';
    }
  } else {
    voice.mic = !voice.mic;
    voice.micTrack.enabled = voice.mic;
  }
  netStatus();                                          // перерисовать кнопку
}

const isTyping = e => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
addEventListener('keydown', e => {
  if (e.code !== 'KeyM' || e.repeat || isTyping(e) || !ROOM) return;
  toggleMic();
});

const r2 = x => Math.round(x * 100) / 100;
addPosFields(() => {
  const a = house.active;
  return player.inside && a ? { hi: [a.h.idx, r2(a.pos.x), r2(a.pos.y), r2(a.pos.z)] } : {};
});

// значок «говорит» над табличкой с именем
function makeSpeakIcon() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(14, 26); g.lineTo(22, 26); g.lineTo(32, 16); g.lineTo(32, 48); g.lineTo(22, 38); g.lineTo(14, 38); g.closePath(); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 3.5; g.lineCap = 'round';
  for (const r of [8, 15]) { g.beginPath(); g.arc(33, 32, r, -0.8, 0.8); g.stroke(); }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.scale.set(0.5, 0.5, 1); sp.position.y = 2.7;
  return sp;
}

const rms = (an, buf) => { an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };
const _p = new THREE.Vector3();

// где сейчас рот собеседника в моей системе координат; null — не слышно (один в доме, другой снаружи или в другом доме)
function mouthOf(r) {
  if (!r || !r.pos) return null;
  const hi = r.last && r.last.hi;
  const mine = player.inside ? player.inside.house : -1;
  if (mine < 0 && !hi) { r.group.updateMatrixWorld(); return r.group.localToWorld(_p.set(0, HEAD, 0)); }
  if (mine >= 0 && hi && hi[0] === mine) return _p.set(hi[1], hi[2] + HEAD, hi[3]);
  return null;
}

export function updateVoice(dt) {
  if (!ROOM || !ready) return;
  const t = audio.ctx.currentTime;
  voiceBus.gain.setTargetAtTime(P.VOICE_VOL, t, 0.05);
  for (const [s, v] of voice.peers) {
    const n = v.nodes;
    if (!n) continue;
    const r = net.remotes.get(s);
    const m = mouthOf(r);
    if (m) {
      if (!n.placed) { n.pan.positionX.value = m.x; n.pan.positionY.value = m.y; n.pan.positionZ.value = m.z; n.placed = true; }
      else { n.pan.positionX.setTargetAtTime(m.x, t, 0.03); n.pan.positionY.setTargetAtTime(m.y, t, 0.03); n.pan.positionZ.setTargetAtTime(m.z, t, 0.03); }
    }
    n.pan.maxDistance = Math.max(VOICE_NEAR + 1, P.VOICE_R);
    n.gain.gain.setTargetAtTime(m ? 1 : 0, t, 0.08);
    v.level = rms(n.an, n.buf);
    v.speakT = v.level > SPEAK_LVL ? SPEAK_HOLD : v.speakT - dt;
    if (r) {
      if (!v.icon) v.icon = makeSpeakIcon();
      if (v.icon.parent !== r.group) r.group.add(v.icon);   // аватар пересобирается при смене имени/цвета
      v.icon.visible = v.speakT > 0;
    }
    const tag = document.querySelector(`#net [data-voice="${s}"]`);
    if (tag) tag.classList.toggle('talk', v.speakT > 0);
  }
  voice.level = voice.mic && micAn ? rms(micAn, micBuf) : 0;
  const btn = document.getElementById('mic');
  if (btn) btn.style.setProperty('--lvl', `${Math.min(100, voice.level * 900).toFixed(0)}%`);
}

// ---------- отладка ----------
// вместо микрофона — тон freq Гц (проверить звонок без разрешения на микрофон)
export function debugVoiceTone(freq = 440) {
  if (!ROOM) return;
  if (!audio) initAudio();
  const { ctx } = audio;
  const o = ctx.createOscillator(), g = ctx.createGain(), d = ctx.createMediaStreamDestination();
  o.frequency.value = freq; g.gain.value = 0.3;
  o.connect(g).connect(d); o.start();
  useMicTrack(d.stream.getAudioTracks()[0]);
  voice.mic = true;
  netStatus();
}
// что слышно от каждого: расстояние, гейт, уровни левого и правого канала после панорамы
export function debugVoiceLevels() {
  const out = [];
  const cam = new THREE.Vector3();
  for (const [s, v] of voice.peers) {
    const n = v.nodes;
    if (!n) { out.push({ slot: s, stream: false, state: v.call.peerConnection?.connectionState }); continue; }
    if (!n.probe) {
      const split = audio.ctx.createChannelSplitter(2), L = audio.ctx.createAnalyser(), R = audio.ctx.createAnalyser();
      L.fftSize = R.fftSize = 2048;
      n.pan.connect(split); split.connect(L, 0); split.connect(R, 1);
      n.probe = { split, L, R, buf: new Float32Array(2048) };
    }
    const m = mouthOf(net.remotes.get(s));
    audio.listener.getWorldPosition(cam);
    out.push({
      slot: s, stream: true, state: v.call.peerConnection?.connectionState, audible: !!m,
      dist: m ? +cam.distanceTo(m).toFixed(1) : null,
      src: +v.level.toFixed(4), L: +rms(n.probe.L, n.probe.buf).toFixed(4), R: +rms(n.probe.R, n.probe.buf).toFixed(4),
    });
  }
  return out;
}
