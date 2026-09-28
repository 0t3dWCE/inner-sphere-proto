// Звук: ядро Web Audio (всё синтезируется, файлов нет) и звуки каравана.
// Контекст стартует по первому клику (политика браузеров) — initAudio() вызывает оверлей.
// Три шины: bus — караван (PositionalAudio на среднем верблюде, линейное затухание до SOUND_R),
// forestBus — лес (без позиции, мы внутри него), townBus — город (PositionalAudio в его центре).
import * as THREE from 'three';
import { P } from './params.js';
import { scene, camera } from './scene.js';
import { townDir, TOWN_H } from './world.js';

export let audio = null;   // живой экспорт: { ctx, listener, bus, positional, noise, forestBus, townBus, town, townAnchor, ... }
const readyListeners = [];
// модули, которым нужно что-то повесить на созданный звук (караван цепляет positional к верблюду)
export function onAudioReady(fn) { readyListeners.push(fn); }

export function initAudio() {
  if (audio) return;
  const listener = new THREE.AudioListener();
  camera.add(listener);
  const ctx = listener.context;
  if (ctx.state === 'suspended') ctx.resume();
  const bus = ctx.createGain();
  const positional = new THREE.PositionalAudio(listener);
  positional.setNodeSource(bus);
  positional.setDistanceModel('linear');
  positional.setRefDistance(2);
  positional.setRolloffFactor(1);
  positional.setMaxDistance(Math.max(1, P.SOUND_R));
  // буфер шума для шагов
  const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  // --- лес: без позиции (мы внутри него), громкость плавно следует за биомом игрока ---
  const forestBus = ctx.createGain();
  forestBus.gain.value = 0;
  forestBus.connect(listener.getInput());
  // шум листвы: зацикленный шум через полосовой фильтр, дыхание громкости медленным LFO
  const leafBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const ld = leafBuf.getChannelData(0);
  for (let i = 0; i < ld.length; i++) ld[i] = Math.random() * 2 - 1;
  const leaves = ctx.createBufferSource();
  leaves.buffer = leafBuf; leaves.loop = true;
  const leafF = ctx.createBiquadFilter();
  leafF.type = 'bandpass'; leafF.frequency.value = 1900; leafF.Q.value = 0.6;
  const leafG = ctx.createGain(); leafG.gain.value = 0.05;
  const leafLfo = ctx.createOscillator(), leafLfoG = ctx.createGain();
  leafLfo.frequency.value = 0.17; leafLfoG.gain.value = 0.03;
  leafLfo.connect(leafLfoG).connect(leafG.gain);
  leaves.connect(leafF).connect(leafG).connect(forestBus);
  leaves.start(); leafLfo.start();

  // --- город: PositionalAudio в центре города, линейное затухание к TOWN_H + 30 ---
  const townBus = ctx.createGain();
  const town = new THREE.PositionalAudio(listener);
  town.setNodeSource(townBus);
  town.setDistanceModel('linear');
  town.setRefDistance(TOWN_H * 0.7);
  town.setRolloffFactor(1);
  town.setMaxDistance(TOWN_H + 30);
  const townAnchor = new THREE.Object3D();
  townAnchor.position.copy(townDir).multiplyScalar(P.R - 1);
  townAnchor.add(town);
  scene.add(townAnchor);
  // бурдон — тихая низкая "струна", тянется всё время, пока слышен город
  const drone = ctx.createOscillator(), droneF = ctx.createBiquadFilter(), droneG = ctx.createGain();
  drone.type = 'sawtooth'; drone.frequency.value = 146.83;   // D3
  droneF.type = 'lowpass'; droneF.frequency.value = 420;
  droneG.gain.value = 0.035;
  drone.connect(droneF).connect(droneG).connect(townBus);
  drone.start();

  audio = {
    ctx, listener, bus, positional, noise, forestBus, townBus, town, townAnchor,
    birds: [0, 1, 2, 3].map(i => ({ kind: i % 3, next: 0, pan: 0 })),
    nextAnimal: 0, nextBeat: -Infinity, beat: 0, melodyDeg: 0, nextKitchen: 0,
  };
  for (const fn of readyListeners) fn(audio);
}

// ---------- звуки каравана ----------
// Колокольчики — по звону на шаг каждого верблюда, глухие шаги, редкое ворчание. Всё в bus.
export function sfxBell(freq, gain) {
  const { ctx, bus } = audio, t = ctx.currentTime;
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
  o1.type = o2.type = 'sine';
  o1.frequency.value = freq;
  o2.frequency.value = freq * 2.76;                 // негармонический обертон — металл
  const g = ctx.createGain(), g2 = ctx.createGain();
  g2.gain.value = 0.3;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0004, t + 0.45 + Math.random() * 0.2);
  o1.connect(g); o2.connect(g2).connect(g); g.connect(bus);
  o1.start(t); o2.start(t); o1.stop(t + 0.7); o2.stop(t + 0.7);
}
export function sfxThud(gain) {
  const { ctx, bus, noise } = audio, t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 160 + Math.random() * 60; f.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0004, t + 0.13);
  src.connect(f).connect(g).connect(bus);
  src.start(t); src.stop(t + 0.16);
}
export function sfxGrunt() {
  const { ctx, bus } = audio, t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  const f0 = 85 + Math.random() * 30;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.linearRampToValueAtTime(f0 * 1.5, t + 0.25);
  o.frequency.exponentialRampToValueAtTime(f0 * 0.8, t + 0.8);
  const lfo = ctx.createOscillator(), lfoG = ctx.createGain();   // дрожание голоса
  lfo.frequency.value = 8 + Math.random() * 4; lfoG.gain.value = 10;
  lfo.connect(lfoG).connect(o.frequency);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.setValueAtTime(500, t); f.frequency.linearRampToValueAtTime(900, t + 0.3);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.22, t + 0.06);
  g.gain.setValueAtTime(0.22, t + 0.45);
  g.gain.exponentialRampToValueAtTime(0.0004, t + 0.85);
  o.connect(f).connect(g).connect(bus);
  o.start(t); lfo.start(t); o.stop(t + 0.9); lfo.stop(t + 0.9);
}
