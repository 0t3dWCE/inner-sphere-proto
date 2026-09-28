// Звуки местности: лес (птицы, звери, листва) и город (восточная музыка, кухня).
// Громкость леса следует за биомом игрока; город слышен по расстоянию (PositionalAudio), синтезируем только рядом.
import { P } from './params.js';
import { player } from './state.js';
import { fowUniforms } from './fow.js';
import { townDir, TOWN_H, BIOME } from './world.js';
import { audio } from './audio.js';

// ---------- звуки леса ----------
// Птицы: три "вида" — синица (быстрые высокие трели), пеночка (ниспадающие свисты с вибрато),
// иволга (низкие мягкие флейтовые фразы). Каждая фраза — несколько чирков со своим стерео-положением.
function sfxBirdPhrase(bird) {
  const { ctx, forestBus } = audio, t0 = ctx.currentTime;
  const pan = ctx.createStereoPanner(); pan.pan.value = bird.pan;
  const g = ctx.createGain(); g.gain.value = 1;
  pan.connect(forestBus); g.connect(pan);
  const n = 2 + Math.floor(Math.random() * 5);
  let t = t0;
  for (let i = 0; i < n; i++) {
    const o = ctx.createOscillator(), e = ctx.createGain();
    o.type = 'sine';
    let f0, f1, f2, dur, vol;
    if (bird.kind === 0) { f0 = 3600 + Math.random() * 800; f1 = f0 * 1.25; f2 = f0 * 0.95; dur = 0.06 + Math.random() * 0.05; vol = 0.05; }
    else if (bird.kind === 1) { f0 = 2600 + Math.random() * 500; f1 = f0 * 0.8; f2 = f0 * 0.62; dur = 0.16 + Math.random() * 0.1; vol = 0.045; }
    else { f0 = 1100 + Math.random() * 250; f1 = f0 * 1.15; f2 = f0 * 1.05; dur = 0.22 + Math.random() * 0.12; vol = 0.05; }
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f1, t + dur * 0.4);
    o.frequency.linearRampToValueAtTime(f2, t + dur);
    if (bird.kind === 1) {   // вибрато
      const v = ctx.createOscillator(), vg = ctx.createGain();
      v.frequency.value = 28; vg.gain.value = 60; v.connect(vg).connect(o.frequency); v.start(t); v.stop(t + dur + 0.05);
    }
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(vol, t + 0.01);
    e.gain.setValueAtTime(vol, t + dur * 0.7);
    e.gain.exponentialRampToValueAtTime(0.0003, t + dur + 0.03);
    o.connect(e).connect(g);
    o.start(t); o.stop(t + dur + 0.05);
    t += dur + 0.05 + Math.random() * 0.12;
  }
}
// звери: кукушка, сова, дятел
function sfxAnimal() {
  const { ctx, forestBus } = audio, t = ctx.currentTime;
  const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8; pan.connect(forestBus);
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) {   // кукушка: две ноты, терция вниз, дважды
    for (let r = 0; r < 2; r++) {
      [[660, 0], [523, 0.32]].forEach(([f, dt]) => {
        const o = ctx.createOscillator(), e = ctx.createGain(), s = t + r * 0.95 + dt;
        o.type = 'sine'; o.frequency.value = f;
        e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(0.07, s + 0.03);
        e.gain.setValueAtTime(0.07, s + 0.18); e.gain.exponentialRampToValueAtTime(0.0003, s + 0.28);
        o.connect(e).connect(pan); o.start(s); o.stop(s + 0.3);
      });
    }
  } else if (kind === 1) {   // сова: "у-ху", низкий мягкий тон через lowpass
    [[0, 0.35], [0.5, 0.55]].forEach(([dt, dur]) => {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), e = ctx.createGain(), s = t + dt;
      o.type = 'triangle'; o.frequency.setValueAtTime(380, s); o.frequency.linearRampToValueAtTime(330, s + dur);
      f.type = 'lowpass'; f.frequency.value = 700;
      e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(0.09, s + 0.08);
      e.gain.setValueAtTime(0.09, s + dur * 0.6); e.gain.exponentialRampToValueAtTime(0.0003, s + dur);
      o.connect(f).connect(e).connect(pan); o.start(s); o.stop(s + dur + 0.02);
    });
  } else {   // дятел: серия быстрых сухих ударов
    const n = 7 + Math.floor(Math.random() * 6), gap = 0.055 + Math.random() * 0.02;
    for (let i = 0; i < n; i++) {
      const src = ctx.createBufferSource(); src.buffer = audio.noise;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 2.5;
      const e = ctx.createGain(), s = t + i * gap;
      e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(0.12, s + 0.002); e.gain.exponentialRampToValueAtTime(0.0003, s + 0.03);
      src.connect(f).connect(e).connect(pan); src.start(s); src.stop(s + 0.04);
    }
  }
}

// ---------- звуки города ----------
// Музыка: лад хиджаз от D (D Eb F# G A Bb C), мелодия — случайное блуждание по ступеням с тяготением
// к тонике и форшлагами, "уд" — щипок (две пилы с расстройкой через lowpass с быстрым спадом).
// Ритм дарбуки — максум: D _ T _ _ D T _ на восьмых, ~100 bpm. Плюс кухня: шипение, звон посуды, нож.
const HIJAZ = [293.66, 311.13, 369.99, 392.0, 440.0, 466.16, 523.25, 587.33, 622.25, 739.99];
const MAQSUM = ['D', null, 'T', null, null, 'D', 'T', null];
const EIGHTH = 0.3;
function sfxOud(freq, t, vol = 0.11, dur = 0.7) {
  const { ctx, townBus } = audio;
  t = Math.max(t, ctx.currentTime);   // форшлаг может уйти в прошлое — AudioParam этого не прощает
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), e = ctx.createGain();
  o1.type = 'sawtooth'; o2.type = 'sawtooth';
  o1.frequency.value = freq; o2.frequency.value = freq * 1.004;
  f.type = 'lowpass'; f.Q.value = 1.2;
  f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(500, t + 0.25);
  e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(vol, t + 0.006);
  e.gain.exponentialRampToValueAtTime(0.0003, t + dur);
  o1.connect(f); o2.connect(f); f.connect(e).connect(townBus);
  o1.start(t); o2.start(t); o1.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
}
function sfxDarbuka(kind, t) {
  const { ctx, townBus, noise } = audio;
  t = Math.max(t, ctx.currentTime);
  if (kind === 'D') {   // "дум": низкий тон с быстрым падением высоты
    const o = ctx.createOscillator(), e = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(65, t + 0.16);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.22, t + 0.004); e.gain.exponentialRampToValueAtTime(0.0003, t + 0.2);
    o.connect(e).connect(townBus); o.start(t); o.stop(t + 0.22);
  } else {              // "тек": звонкий шлепок по краю — короткий шум + высокий щелчок
    const src = ctx.createBufferSource(); src.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2600;
    const e = ctx.createGain();
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.09, t + 0.002); e.gain.exponentialRampToValueAtTime(0.0003, t + 0.07);
    src.connect(f).connect(e).connect(townBus); src.start(t); src.stop(t + 0.08);
    const o = ctx.createOscillator(), e2 = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 950;
    e2.gain.setValueAtTime(0.06, t); e2.gain.exponentialRampToValueAtTime(0.0003, t + 0.05);
    o.connect(e2).connect(townBus); o.start(t); o.stop(t + 0.06);
  }
}
// планировщик с упреждением: раскладывает ноты/удары на ближайшие 0.25 с
function scheduleTownMusic() {
  const a = audio, ctx = a.ctx;
  if (a.nextBeat < ctx.currentTime - 1) a.nextBeat = ctx.currentTime + 0.05;   // долго не было слышно — не догоняем
  while (a.nextBeat < ctx.currentTime + 0.25) {
    const t = a.nextBeat, step = a.beat % 8;
    const hit = MAQSUM[step];
    if (hit) sfxDarbuka(hit, t);
    else if (Math.random() < 0.25) sfxDarbuka('T', t + EIGHTH / 2);   // синкопа
    // мелодия: шаг ±1..2 ступени, на сильных долях тянет к тонике/квинте, иногда пауза или форшлаг
    if (Math.random() < 0.8) {
      let d = a.melodyDeg + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.7 ? 1 : 2);
      if (step === 0 && Math.random() < 0.5) d = Math.random() < 0.6 ? 0 : 4;
      if (a.melodyDeg === 0 && Math.random() < 0.6) d = Math.abs(d);          // не уходим ниже тоники слишком часто
      d = Math.max(0, Math.min(HIJAZ.length - 1, d));
      a.melodyDeg = d;
      if (Math.random() < 0.3) sfxOud(HIJAZ[Math.max(0, d - 1)], t - 0.06, 0.06, 0.15);   // форшлаг
      sfxOud(HIJAZ[d], t, step % 2 === 0 ? 0.12 : 0.085, Math.random() < 0.2 ? 1.1 : 0.6);
      if (Math.random() < 0.15) sfxOud(HIJAZ[d], t + EIGHTH / 2, 0.07, 0.3);           // шестнадцатая
    }
    a.nextBeat += EIGHTH;
    a.beat++;
  }
}
function sfxKitchen() {
  const { ctx, townBus, noise } = audio, t = ctx.currentTime;
  const kind = Math.random();
  if (kind < 0.4) {   // шипение сковороды
    const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 4200 + Math.random() * 1500; f.Q.value = 0.9;
    const e = ctx.createGain(), dur = 0.5 + Math.random() * 1.2;
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.045, t + 0.08);
    for (let i = 1; i < 6; i++) e.gain.linearRampToValueAtTime(0.02 + Math.random() * 0.03, t + dur * i / 6);
    e.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(f).connect(e).connect(townBus); src.start(t); src.stop(t + dur + 0.02);
  } else if (kind < 0.75) {   // звон тарелок/стаканов: пара негармоничных партиалов
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const s = t + i * (0.08 + Math.random() * 0.12), base = 1800 + Math.random() * 2200;
      [1, 2.31, 3.72].forEach((m, k) => {
        const o = ctx.createOscillator(), e = ctx.createGain();
        o.type = 'sine'; o.frequency.value = base * m;
        const v = 0.05 / (k + 1);
        e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(v, s + 0.002); e.gain.exponentialRampToValueAtTime(0.0003, s + 0.25 + Math.random() * 0.2);
        o.connect(e).connect(townBus); o.start(s); o.stop(s + 0.5);
      });
    }
  } else {   // нож по доске: серия сухих ударов
    const n = 4 + Math.floor(Math.random() * 5), gap = 0.11 + Math.random() * 0.05;
    for (let i = 0; i < n; i++) {
      const src = ctx.createBufferSource(); src.buffer = noise;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
      const e = ctx.createGain(), s = t + i * gap * (1 + (Math.random() - 0.5) * 0.15);
      e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(0.14, s + 0.002); e.gain.exponentialRampToValueAtTime(0.0003, s + 0.04);
      src.connect(f).connect(e).connect(townBus); src.start(s); src.stop(s + 0.05);
    }
  }
}

// ---------- кадр ----------
export function updateAmbience() {
  if (!audio) return;
  const a = audio, ctx = a.ctx, now = ctx.currentTime, on = P.AMBIENCE > 0.5 && P.VOLUME > 0;
  const inForest = on && player.biome === BIOME.FOREST;
  a.forestBus.gain.setTargetAtTime(inForest ? 1 : 0, now, 0.7);
  if (inForest) {
    for (const b of a.birds) {
      if (now > b.next) { b.pan = Math.random() * 1.8 - 0.9; sfxBirdPhrase(b); b.next = now + 2.5 + Math.random() * 7; }
    }
    if (a.nextAnimal === 0) a.nextAnimal = now + 4 + Math.random() * 8;
    if (now > a.nextAnimal) { sfxAnimal(); a.nextAnimal = now + 10 + Math.random() * 20; }
  } else a.nextAnimal = 0;
  const townDist = townDir.angleTo(fowUniforms.uPlayerDir.value) * P.R;
  a.townAnchor.position.copy(townDir).multiplyScalar(P.R - 1);   // следует за радиусом
  const nearTown = on && townDist < TOWN_H + 36;
  a.townBus.gain.setTargetAtTime(nearTown ? 1 : 0, now, 0.4);
  if (nearTown) {
    scheduleTownMusic();
    if (now > a.nextKitchen) { sfxKitchen(); a.nextKitchen = now + 0.8 + Math.random() * 3; }
  }
}
