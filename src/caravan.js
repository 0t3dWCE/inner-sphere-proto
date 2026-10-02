// Караван и погонщики.
// 4–7 верблюдов идут гуськом по внутренней поверхности. Вожак движется по большому кругу ("кольцу"),
// каждые пол-сферы (угол π) кольцо случайно поворачивается. Остальные идут по следу вожака с отставанием
// по дуге. Стартуют далеко от игрока — в тумане, пока их не разведаешь.
// Симуляция вожака идёт фиксированным шагом по «мировому времени» (Date.now() - worldT0) и берёт случайности
// из randCaravan — поэтому у всех участников комнаты с одним seed и одним worldT0 караван в одном месте.
// worldT0 — момент рождения мира; в комнате все сходятся к самому раннему.
// Если погибли все погонщики, npc.js ставит caravan.haltAt (то же мировое время): шаг дальше этой отметки
// не делается. Пока комната не узнала, жив ли караван, догонять время нельзя — опоздавший иначе проскочит
// остановку. В комнате updateCaravan поэтому стоит на месте, пока npc.js не вызовет releaseCaravan.
import * as THREE from 'three';
import { ROOM, rand, randCaravan, randomDir, START_DIR, player, clock } from './state.js';
import { P } from './params.js';
import { scene } from './scene.js';
import { fogify } from './fow.js';
import { townDir, TOWN_AVOID, lakeDir, LAKE_R } from './world.js';
import { oasisDir, OASIS_AVOID } from './oasis.js';
import { surfaceR } from './terrain.js';
import { palette } from './props.js';
import { audio, onAudioReady, sfxBell, sfxThud, sfxGrunt } from './audio.js';
import { onNet, addHelloFields } from './net.js';

const CAMEL_SPACING = 3.4;      // метров между верблюдами по дуге
const CAMEL_COLORS = [0xc9a26b, 0xb8925a, 0xd7b07c, 0xa9835a, 0xe0be8a];

function makeCamel(color, blanketColor) {
  const g = new THREE.Group();
  const hide = fogify(new THREE.MeshStandardMaterial({ color, roughness: .95, flatShading: true }));
  const dark = fogify(new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.72), roughness: .95, flatShading: true,
  }));
  // модель: +Z — вперёд, +Y — вверх, начало координат — на земле под центром тела
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 2.2), hide);
  body.position.set(0, 1.5, 0);
  const hump1 = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), hide);
  hump1.position.set(0, 2.12, 0.45); hump1.scale.set(1, 0.85, 1.05);
  const hump2 = hump1.clone(); hump2.position.z = -0.5;
  // шея с головой — отдельный узел с pivot у груди, чтобы покачивать
  const neck = new THREE.Group();
  neck.position.set(0, 1.75, 1.0);
  const neckMesh = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.15, 0.38), hide);
  neckMesh.position.set(0, 0.5, 0.2); neckMesh.rotation.x = 0.4;
  const head = new THREE.Group();
  head.position.set(0, 1.0, 0.5);
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.72), dark);
  skull.position.set(0, 0, 0.2);
  const earGeo = new THREE.BoxGeometry(0.08, 0.16, 0.08);
  const earL = new THREE.Mesh(earGeo, dark); earL.position.set(-0.13, 0.2, -0.05);
  const earR = earL.clone(); earR.position.x = 0.13;
  head.add(skull, earL, earR);
  neck.add(neckMesh, head);
  // хвост — pivot сверху
  const tailGeo = new THREE.BoxGeometry(0.1, 0.65, 0.1); tailGeo.translate(0, -0.32, 0);
  const tail = new THREE.Mesh(tailGeo, dark);
  tail.position.set(0, 1.85, -1.12);
  // ноги — pivot у бедра, геометрия сдвинута вниз
  const legGeo = new THREE.BoxGeometry(0.2, 1.12, 0.22); legGeo.translate(0, -0.56, 0);
  const legs = [];
  for (const [x, z] of [[-0.28, 0.8], [0.28, 0.8], [-0.28, -0.8], [0.28, -0.8]]) {
    const leg = new THREE.Mesh(legGeo, dark);
    leg.position.set(x, 1.1, z);
    legs.push(leg);
  }
  g.add(body, hump1, hump2, neck, tail, ...legs);
  if (blanketColor) {
    const blanket = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.14, 0.75),
      fogify(new THREE.MeshStandardMaterial({ color: blanketColor, roughness: .8 })));
    blanket.position.set(0, 1.97, -0.03);
    g.add(blanket);
  }
  return { group: g, body, legs, neck, head, tail };
}

// ---------- погонщики ----------
// 3–4 человека идут рядом с караваном по обе стороны и "гуляют" вдоль него вперёд-назад:
// их продольное смещение колеблется по синусу, скорость складывается со скоростью каравана.
const HERDER_ROBES = [0x3b4a8c, 0xb7442c, 0xe8e2d0, 0x6b8e4e, 0x8c6239];
const HERDER_TURBANS = [0xf2e9d8, 0xd9a441, 0x2f2f2f, 0xc0392b, 0xffffff];

function makeHerder(robeColor, turbanColor) {
  const g = new THREE.Group();
  const robe = fogify(new THREE.MeshStandardMaterial({ color: robeColor, roughness: .95, flatShading: true }));
  const skin = fogify(new THREE.MeshStandardMaterial({ color: 0x8d5a3b, roughness: .9, flatShading: true }));
  const cloth = fogify(new THREE.MeshStandardMaterial({ color: turbanColor, roughness: .95, flatShading: true }));
  const wood = fogify(new THREE.MeshStandardMaterial({ color: 0x5a3d22, roughness: 1 }));
  // модель: +Z — вперёд, начало координат — на земле; рост ~1.75
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 1.05, 7), robe);
  body.position.y = 0.85;
  const head = new THREE.Group();
  head.position.y = 1.55;
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.15, 7, 6), skin);
  const turban = new THREE.Mesh(new THREE.SphereGeometry(0.19, 7, 5), cloth);
  turban.position.y = 0.08; turban.scale.set(1, 0.6, 1);
  head.add(face, turban);
  // ноги — pivot у бедра (виднеются из-под халата)
  const legGeo = new THREE.BoxGeometry(0.12, 0.6, 0.14); legGeo.translate(0, -0.3, 0);
  const legL = new THREE.Mesh(legGeo, skin); legL.position.set(-0.09, 0.6, 0);
  const legR = new THREE.Mesh(legGeo, skin); legR.position.set(0.09, 0.6, 0);
  // руки — pivot у плеча; в правой — посох
  const armGeo = new THREE.BoxGeometry(0.1, 0.62, 0.1); armGeo.translate(0, -0.31, 0);
  const armL = new THREE.Mesh(armGeo, robe); armL.position.set(-0.28, 1.35, 0);
  const armR = new THREE.Mesh(armGeo, robe); armR.position.set(0.28, 1.35, 0);
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.9, 5), wood);
  staff.position.set(0.05, -0.55 + 0.35, 0.05);   // хват примерно посередине посоха
  armR.add(staff);
  g.add(body, head, legL, legR, armL, armR);
  return { group: g, body, head, legL, legR, armL, armR };
}

// ---------- состояние каравана ----------
// { dir, tan, s, travelled, trail, camels, herders, simT, nextGrunt } — заполняется в buildCaravan()
export const caravan = { dir: null, tan: null, s: 0, travelled: 0, trail: [], camels: [], herders: [], simT: 0, nextGrunt: 0, haltAt: 0 };
// В комнате не догоняем мировое время, пока npc.js не узнает haltAt (из hello/снимка или «мы одни»).
let caravanHeld = !!ROOM;

// шаг сборки мира (после города — порядок rand() важен)
export function buildCaravan() {
  const playerDir = START_DIR.clone();            // игрок стартует в START_DIR
  let dir;                                        // направление на вожака
  do dir = randomDir(); while (dir.angleTo(playerDir) < 1.2);   // стартуем далеко, в тумане
  const tan = randomDir();
  tan.addScaledVector(dir, -tan.dot(dir)).normalize();   // случайная касательная: проекция на касательную плоскость

  const count = 5 + Math.floor(rand() * 3);   // 5..7 — не меньше, чем игроков в комнате: каждому по верблюду (ride.js)
  const camels = [];
  for (let i = 0; i < count; i++) {
    const c = makeCamel(
      CAMEL_COLORS[Math.floor(rand() * CAMEL_COLORS.length)],
      rand() < 0.6 ? palette[Math.floor(rand() * palette.length)] : null
    );
    c.phase = rand() * Math.PI * 2;
    // фазы ног: примерно диагональная походка, но с разбросом — идут не в такт
    c.legPhase = [0, Math.PI, Math.PI * 0.55, Math.PI * 1.55].map(p => p + (rand() - 0.5) * 0.7);
    c.gait = 0.85 + rand() * 0.3;              // индивидуальный темп
    c.bellFreq = [1760, 1980, 2350, 2640, 2960][i % 5] * (0.97 + rand() * 0.06);  // свой колокольчик
    c.lastCycle = -1;
    c.lastStep = [-1, -1, -1, -1];
    c.group.scale.setScalar(0.9 + rand() * 0.25);
    if (caravanHeld) c.group.visible = false;
    scene.add(c.group);
    camels.push(c);
  }
  // след вожака: [{dir, s}], s — накопленный угол пути; заполняем назад по геодезической,
  // чтобы верблюды с самого начала стояли гуськом
  const trail = [];
  const backAngle = (count + 1) * CAMEL_SPACING / P.R;
  for (let s = -backAngle; s < 0; s += 0.004)
    trail.push({ dir: dir.clone().multiplyScalar(Math.cos(s)).addScaledVector(tan, Math.sin(s)).normalize(), s });
  trail.push({ dir: dir.clone(), s: 0 });
  Object.assign(caravan, { dir, tan, s: 0, travelled: 0, trail, camels });

  // погонщики
  const n = 3 + Math.floor(rand() * 2);      // 3..4
  const camelLen = (camels.length - 1) * CAMEL_SPACING;   // длина цепочки, м
  for (let i = 0; i < n; i++) {
    const h = makeHerder(
      HERDER_ROBES[Math.floor(rand() * HERDER_ROBES.length)],
      HERDER_TURBANS[Math.floor(rand() * HERDER_TURBANS.length)]
    );
    h.side = i % 2 === 0 ? 1 : -1;                    // чередуем стороны
    h.lateral = 2.2 + rand() * 0.8;            // метров от оси каравана
    h.phase = rand() * Math.PI * 2;
    h.wanderAmp = Math.max(1.5, camelLen / 2 + 1.5);  // размах прогулки вдоль каравана, м
    h.wanderW = (1.6 / h.wanderAmp) * (0.8 + rand() * 0.4);   // ~пик 1.6 м/с относительно каравана
    h.gaitPhase = rand() * Math.PI * 2;
    h.group.scale.setScalar(0.95 + rand() * 0.12);
    if (caravanHeld) h.group.visible = false;
    scene.add(h.group);
    caravan.herders.push(h);
  }
}
// звук каравана — PositionalAudio на среднем верблюде; первое ворчание через 4–12 с
onAudioReady(a => {
  caravan.camels[Math.floor(caravan.camels.length / 2)].group.add(a.positional);
  caravan.nextGrunt = clock.elapsedTime + 4 + Math.random() * 8;
});

// ---------- мировое время ----------
export const CARAVAN_DT = 0.05;
export let worldT0 = Date.now();   // живой экспорт (читает debug)
if (ROOM) {
  const saved = parseInt(localStorage.getItem('inner-sphere-t0-' + ROOM) || '', 10);
  if (Number.isFinite(saved) && saved < worldT0) worldT0 = saved;
  localStorage.setItem('inner-sphere-t0-' + ROOM, String(worldT0));
}
export function worldTime() { return (Date.now() - worldT0) / 1000; }
// haltAt — мировое время остановки (0 = идёт). Более ранняя отметка побеждает, назад симуляцию не отматываем.
export function haltCaravan(at) {
  if (!(at > 0)) return;
  if (!(caravan.haltAt > 0) || at < caravan.haltAt) caravan.haltAt = at;
}
export function releaseCaravan(haltAt = 0) {
  caravanHeld = false;
  if (haltAt > 0) haltCaravan(haltAt);
}
addHelloFields(() => ({ t0: worldT0 }));
onNet('hello', m => {
  if (Number.isFinite(m.t0) && m.t0 < worldT0) {          // чужой мир старше — переходим на его часы (караван догонит)
    worldT0 = m.t0;
    localStorage.setItem('inner-sphere-t0-' + ROOM, String(worldT0));
  }
});

// ---------- след и симуляция ----------
// положение на следе по накопленному углу s (slerp между соседними отметками)
function trailDir(s, out) {
  const t = caravan.trail;
  if (s <= t[0].s) return out.copy(t[0].dir);
  for (let j = t.length - 1; j > 0; j--) {
    if (t[j - 1].s <= s) {
      const a = t[j - 1], b = t[j];
      const k = b.s === a.s ? 0 : (s - a.s) / (b.s - a.s);
      return out.copy(a.dir).lerp(b.dir, k).normalize();
    }
  }
  return out.copy(t[t.length - 1].dir);
}
// направление на место i-го верблюда в цепочке (для возвращения отпущенного верблюда — ride.js)
export function camelSlotDir(i, out) { return trailDir(caravan.s - i * CAMEL_SPACING / P.R, out); }
// базис в точке следа s: _cd — направление на точку, _cu — "верх" (к центру), _cf — вперёд по следу, _cr — вправо
const _cd = new THREE.Vector3(), _cf = new THREE.Vector3(), _cu = new THREE.Vector3(), _cr = new THREE.Vector3(), _hd = new THREE.Vector3(), _m = new THREE.Matrix4();
function trailFrame(s) {
  trailDir(s, _cd);
  trailDir(s + 0.01, _cf);
  _cu.copy(_cd).negate();
  _cf.sub(_cd).addScaledVector(_cu, -_cf.dot(_cu));
  if (_cf.lengthSq() < 1e-10) _cf.copy(caravan.tan);
  _cf.normalize();
  _cr.crossVectors(_cu, _cf);
}

function stepCaravan(dt) {
  const cv = caravan, R = P.R;
  // вожак: шаг по большому кругу в плоскости (dir, tan)
  const ang = P.CAMEL_SPEED * dt / R;
  if (ang > 0) {
    _cd.copy(cv.dir);
    cv.dir.multiplyScalar(Math.cos(ang)).addScaledVector(cv.tan, Math.sin(ang)).normalize();
    cv.tan.multiplyScalar(Math.cos(ang)).addScaledVector(_cd, -Math.sin(ang));
    cv.tan.addScaledVector(cv.dir, -cv.tan.dot(cv.dir)).normalize();
    // город и озеро — запретные зоны: у границы отражаем направление движения (отскок)
    const bounce = (center, radiusM) => {
      if (cv.dir.angleTo(center) * R >= radiusM) return;
      _hd.copy(center).addScaledVector(cv.dir, -cv.dir.dot(center)).normalize();   // к центру зоны, в касательной плоскости
      const toward = cv.tan.dot(_hd);
      if (toward > 0) {
        cv.tan.addScaledVector(_hd, -2 * toward);
        cv.tan.applyAxisAngle(cv.dir, (randCaravan() - 0.5) * 0.4).normalize();  // чуть сбить угол, чтобы не зациклиться
      }
    };
    bounce(townDir, TOWN_AVOID);
    bounce(lakeDir, (LAKE_R + 0.06) * R);
    bounce(oasisDir, OASIS_AVOID);
    cv.s += ang;
    cv.travelled += ang;
    const last = cv.trail[cv.trail.length - 1];
    if (cv.s - last.s > 0.002) cv.trail.push({ dir: cv.dir.clone(), s: cv.s });
    // пол-сферы пройдено — поворачиваем кольцо на случайный угол 35..110° в любую сторону
    if (cv.travelled >= Math.PI) {
      cv.travelled = 0;
      const turn = (randCaravan() < 0.5 ? -1 : 1) * THREE.MathUtils.degToRad(35 + randCaravan() * 75);
      cv.tan.applyAxisAngle(cv.dir, turn).normalize();
    }
    // подрезаем хвост следа
    const minS = cv.s - (cv.camels.length + 1) * CAMEL_SPACING / R - 0.05;
    while (cv.trail.length > 2 && cv.trail[1].s < minS) cv.trail.shift();
  }
}

// ---------- кадр ----------
export function updateCaravan() {
  const cv = caravan, R = P.R;
  // Комната: стоим, пока не известна судьба погонщиков. Предохранитель на 12 с — чтобы сбой снимка не прятал караван навсегда.
  if (caravanHeld) {
    if (clock.elapsedTime > 12) caravanHeld = false;
    else return;
  }
  // догоняем мировое время фиксированными шагами, но не дальше остановки (haltAt)
  const now = worldTime();
  const target = cv.haltAt > 0 ? Math.min(now, cv.haltAt) : now;
  for (let n = 0; cv.simT + CARAVAN_DT <= target && n < 60000; n++) { stepCaravan(CARAVAN_DT); cv.simT += CARAVAN_DT; }
  const halted = cv.haltAt > 0 && cv.simT + CARAVAN_DT > cv.haltAt;
  const spd = halted ? 0 : P.CAMEL_SPEED;

  const t = clock.elapsedTime;
  const spacing = CAMEL_SPACING / R;
  // звук: громкость/радиус из панели; синтезировать что-то имеет смысл только рядом с игроком
  let hear = false;
  if (audio) {
    audio.listener.setMasterVolume(P.VOLUME);
    audio.positional.setMaxDistance(Math.max(1, P.SOUND_R));
    hear = P.SOUND_R > 0 && P.VOLUME > 0 &&
      audio.positional.getWorldPosition(_hd).distanceTo(player.pos) < P.SOUND_R + 6;
    if (hear && t > cv.nextGrunt) { sfxGrunt(); cv.nextGrunt = t + 6 + Math.random() * 14; }
  }
  cv.camels.forEach((c, i) => {
    if (c.st?.away === 'dead') return;   // труп ставит npc.js
    if (!c.st?.away) c.group.visible = true;
    trailFrame(cv.s - i * spacing);
    c.group.position.copy(_cd).multiplyScalar(surfaceR(_cd) - 0.03);
    c.group.quaternion.setFromRotationMatrix(_m.makeBasis(_cr, _cu, _cf));

    // анимация: ноги асинхронно, шея и голова покачиваются, хвост машет, тело чуть подпрыгивает
    const w = spd > 0 ? (2.0 + spd * 0.9) * c.gait : 0.6;
    const ph = t * w + c.phase;
    const amp = spd > 0 ? 0.42 : 0.03;
    c.legs.forEach((leg, k) => { leg.rotation.x = Math.sin(ph + c.legPhase[k]) * amp; });
    // колокольчик — раз за цикл шага, шаги — когда нога проходит нижнюю точку (фаза кратна π)
    if (hear && spd > 0) {
      const cycle = Math.floor((ph + c.legPhase[0]) / (2 * Math.PI));
      if (cycle !== c.lastCycle) { c.lastCycle = cycle; sfxBell(c.bellFreq, 0.12); }
      c.legs.forEach((_, k) => {
        const step = Math.floor((ph + c.legPhase[k]) / Math.PI);
        if (step !== c.lastStep[k]) { c.lastStep[k] = step; sfxThud(0.05); }
      });
    }
    c.neck.rotation.x = Math.sin(ph * 0.5) * 0.1 - 0.05;
    c.head.rotation.x = Math.sin(ph * 0.5 + 1.3) * 0.18;
    c.head.rotation.y = Math.sin(ph * 0.23 + c.phase) * 0.25;
    c.tail.rotation.x = Math.sin(ph * 0.7 + 2) * 0.25;
    c.body.position.y = 1.5 + Math.abs(Math.sin(ph)) * 0.04;
  });

  // погонщики: точка на следе = середина цепочки + прогулка по синусу; сдвиг вбок по _cr
  const camelLen = (cv.camels.length - 1) * CAMEL_SPACING;
  for (const h of cv.herders) {
    // 'out' и 'dead' ставит npc.js; здесь только те, кто ещё при караване
    if (h.st && h.st !== 'in') continue;
    if (h.acting) continue;
    h.group.visible = true;
    const wander = Math.sin(t * h.wanderW + h.phase) * h.wanderAmp;            // м, вдоль каравана
    const wanderV = Math.cos(t * h.wanderW + h.phase) * h.wanderAmp * h.wanderW; // м/с относительно каравана
    trailFrame(cv.s + (-camelLen / 2 + wander) / R);
    const a = h.side * h.lateral / R;                                            // боковой сдвиг как угол
    _hd.copy(_cd).multiplyScalar(Math.cos(a)).addScaledVector(_cr, Math.sin(a)).normalize();
    _cu.copy(_hd).negate();
    _cf.addScaledVector(_cu, -_cf.dot(_cu)).normalize();
    // идёт вперёд, но корпус чуть доворачивает в сторону, куда сейчас смещается вдоль каравана
    const speed = spd + wanderV;
    const yaw = THREE.MathUtils.clamp(-h.side * wanderV * 0.18, -0.35, 0.35);
    if (speed < 0) _cf.negate();                                                  // если караван стоит — разворачивается
    _cf.applyAxisAngle(_cu, yaw).normalize();
    _cr.crossVectors(_cu, _cf);
    h.group.position.copy(_hd).multiplyScalar(surfaceR(_hd) - 0.02);
    h.group.quaternion.setFromRotationMatrix(_m.makeBasis(_cr, _cu, _cf));

    // походка: ноги в противофазе, руки — противоположно ногам, темп от фактической скорости
    const sp = Math.abs(speed);
    const w = 3.2 + sp * 1.6;
    const ph = t * w + h.gaitPhase;
    const amp = Math.min(0.55, 0.12 + sp * 0.16);
    h.legL.rotation.x = Math.sin(ph) * amp;
    h.legR.rotation.x = -Math.sin(ph) * amp;
    h.armL.rotation.x = -Math.sin(ph) * amp * 0.7;
    h.armR.rotation.x = Math.sin(ph) * amp * 0.35;         // рука с посохом машет меньше
    h.head.rotation.y = Math.sin(t * 0.7 + h.phase) * 0.4 - h.side * 0.25;   // поглядывает на верблюдов
    h.head.rotation.x = Math.sin(ph * 2) * 0.03;
    h.body.position.y = 0.85 + Math.abs(Math.sin(ph)) * 0.03;
  }
}
