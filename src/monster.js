// Монстр — медведракон (полумедведь-полудракон), его выводок скорпионов и скелеты павших.
//
// Поведение: живёт в центре леса (bioAxis) и бродит вокруг, из леса не выходит (шаг за границу леса не делается —
// пробует свернуть). Караван в лесу — подходит и идёт рядом на ~8 м, не трогая. Игрок ближе AGGRO_R — рёв и погоня
// на 1 м/с быстрее игрока; потерял из виду (дальше LOSE_R дольше LOSE_T, в доме, погиб) или гонится дольше CHASE_MAX —
// уходит в центр леса. Убить можно только стрелами: MON_HP попаданий (в голову — вдвое). На половине HP рожает изо рта
// 10–15 скорпионов: быстрее игрока, набегают-кусают-отскакивают, умирают от 2–3 стрел, из леса выходят. HP = 0 —
// громкий предсмертный рёв, падает на бок, на месте остаётся большой скелет; через RESPAWN_MS в центре леса новый.
//
// Сеть: монстра и скорпионов считает один «хозяин» — игрок с наименьшим слотом (в одиночной игре — ты), и рассылает
// снимок 'mon' ~10 Гц; остальные плавно тянут свои копии к снимку. Только что вошедший «не синхронизирован»: он не
// считает монстра и не рассылает его, пока не примет чужой снимок (он есть в hello каждого синхронизированного) или
// не пробудет 6 с один в комнате — иначе новичок со слотом 0 сбросил бы идущий бой. Синхронизированные принимают
// снимки только от хозяина; ушёл хозяин — следующий по слоту продолжает с последнего принятого снимка.
// Попадание решает стрелок ('mhit' хозяину), укус — укушенный (своё HP считает сам, health.js).
import * as THREE from 'three';
import { ROOM, ME, player, clock } from './state.js';
import { P } from './params.js';
import { scene } from './scene.js';
import { fogify } from './fow.js';
import { surfaceR, radiusListeners } from './terrain.js';
import { BIOME, biomeAt, bioAxis } from './world.js';
import { caravan } from './caravan.js';
import { net, netBroadcast, onNet, addHelloFields } from './net.js';
import { onArrowHit } from './bow.js';
import { damagePlayer } from './health.js';
import { audio } from './audio.js';

export const MON_HP = 80;
const NAME = 'Медведракон';
const AGGRO_R = 20, LOSE_R = 38, LOSE_T = 2.5, CHASE_MAX = 30, CALM_T = 6;   // м, м, с, с, с
const HOME_R = 25;                                   // бродит в пределах HOME_R м от центра леса
const WANDER_V = 2, RETURN_V = 5, FOLLOW_V = 4;      // м/с
const CARAVAN_SEE = 60, CARAVAN_NEAR = 8;            // м
const STOP_CHASE = 4.0;                              // м от центра монстра до игрока: голова (~3,2 м впереди) — у лица
const BITE_R = 2.0, BITE_DMG = 20, BITE_CD = 1.3;    // от головы, HP, с
const SC_MIN = 10, SC_MAX = 15, SC_BONUS = 2, SC_HUNT_R = 80;
const SC_BITE_R = 1.3, SC_DMG = 2, SC_CD = 1.4;
const SC_PACK = 4, SC_RING = 5;                      // на одного игрока бросаются не больше SC_PACK, остальные кружат в SC_RING м
const DEATH_ANIM = 2.4;                              // с — падение, потом вместо тела скелет
const RESPAWN_MS = 10 * 60 * 1000;
const MAX_SKELETONS = 8;
const SNAP_HZ = 10;
const SCALE = 1.25, SC_SCALE = 1.2;

// ---------- материалы ----------
const std = o => fogify(new THREE.MeshStandardMaterial(Object.assign({ roughness: .9, flatShading: true }, o)));
const furMat = std({ color: 0x5a3a22, emissive: 0x000000 });
const furDark = std({ color: 0x3a2515 });
const scaleMat = std({ color: 0x2f4f3a, roughness: .55 });
const boneMat = std({ color: 0xd9ceb2, roughness: .7 });
const wingMat = std({ color: 0x5a1f1c, roughness: .8, side: THREE.DoubleSide });
const eyeMat = std({ color: 0xffb020, emissive: 0xff9000, emissiveIntensity: 2 });
const mouthMat = std({ color: 0x5a0f12, emissive: 0x2a0000 });
const holeMat = std({ color: 0x151010 });
const scMat = std({ color: 0x4a1a12, roughness: .45, metalness: .2, emissive: 0x000000 });
const scDark = std({ color: 0x2a0d08, roughness: .6 });
const stingMat = std({ color: 0xffa030, emissive: 0xff7000, emissiveIntensity: 1 });

const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };
const sphere = (r, mat, sx = 1, sy = 1, sz = 1, seg = 10) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg - 3)), mat); m.scale.set(sx, sy, sz); return m; };

// ---------- модель монстра: +Z — вперёд, +Y — вверх, земля — y = 0 ----------
function makeMonster() {
  const g = new THREE.Group(), body = new THREE.Group();
  g.add(body);
  const torso = sphere(1, furMat, 1.25, 1.05, 1.8, 12); torso.position.set(0, 1.75, 0);
  const hump = sphere(1, furMat, 1.05, .95, .95); hump.position.set(0, 2.25, .85);
  const belly = sphere(1, scaleMat, .95, .7, 1.5); belly.position.set(0, 1.35, .1);
  body.add(torso, hump, belly);
  // лапы: медвежьи, с когтями; поворот pivot.x — шаг
  const legs = [];
  for (const [x, z] of [[.8, 1.05], [-.8, 1.05], [.8, -1.05], [-.8, -1.05]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, 1.55, z);
    pivot.add(mesh(new THREE.CylinderGeometry(.36, .3, 1.5, 8).translate(0, -.75, 0), furMat));
    const paw = sphere(.38, furDark, 1, .5, 1.25, 8); paw.position.set(0, -1.42, .08);
    pivot.add(paw);
    for (const cx of [-.15, 0, .15]) pivot.add(mesh(new THREE.ConeGeometry(.06, .25, 5).rotateX(Math.PI / 2), boneMat, cx, -1.47, .5));
    body.add(pivot); legs.push(pivot);
  }
  // гребень драконьих шипов по спине
  const top = z => Math.max(1.75 + 1.05 * Math.sqrt(Math.max(0, 1 - (z / 1.8) ** 2)), 2.25 + .95 * Math.sqrt(Math.max(0, 1 - ((z - .85) / .95) ** 2)));
  for (let i = 0; i < 9; i++) {
    const z = 1.4 - i * .38, h = .55 - Math.abs(i - 3) * .04;
    const s = mesh(new THREE.ConeGeometry(.13, h, 5), scaleMat, 0, top(z) + h * .3, z);
    s.rotation.x = -.35;
    body.add(s);
  }
  // шея и голова: медвежий череп и уши, драконья морда, рога и зубы; челюсть открывается (jaw.rotation.x > 0)
  const neck = new THREE.Group(); neck.position.set(0, 2.2, 1.55); body.add(neck);
  const neckM = sphere(1, furMat, .7, .7, .9); neckM.position.set(0, .05, .35); neck.add(neckM);
  const head = new THREE.Group(); head.position.set(0, .2, 1.05); neck.add(head);
  head.add(sphere(.62, furMat, 1, .9, 1.05));
  for (const s of [1, -1]) {
    const ear = sphere(.2, furDark, 1, 1, .5, 8); ear.position.set(s * .42, .5, -.1); head.add(ear);
    const horn = mesh(new THREE.ConeGeometry(.12, .9, 6).translate(0, .45, 0), boneMat, s * .3, .45, -.2);
    horn.rotation.set(-1.1, 0, -s * .35); head.add(horn);
    head.add(mesh(new THREE.SphereGeometry(.09, 8, 6), eyeMat, s * .3, .2, .5));
    for (let k = 0; k < 6; k++) head.add(mesh(new THREE.ConeGeometry(.04, .15, 4).rotateX(Math.PI), boneMat, s * .25, -.22, .45 + k * .13));
  }
  head.add(mesh(new THREE.BoxGeometry(.62, .3, .95), scaleMat, 0, -.02, .75));
  head.add(mesh(new THREE.BoxGeometry(.5, .08, .8), mouthMat, 0, -.17, .72));
  const jaw = new THREE.Group(); jaw.position.set(0, -.22, .35); head.add(jaw);
  jaw.add(mesh(new THREE.BoxGeometry(.55, .16, .9), scaleMat, 0, -.05, .45));
  for (const s of [1, -1]) for (let k = 0; k < 5; k++) jaw.add(mesh(new THREE.ConeGeometry(.035, .12, 4), boneMat, s * .22, .06, .15 + k * .15));
  // крылья: перепонка (ShapeGeometry) с костями по переднему краю; взмах — rotation.z
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0); wingShape.lineTo(1.6, 1.0); wingShape.lineTo(2.7, .6); wingShape.lineTo(2.2, -.2);
  wingShape.lineTo(1.7, -.05); wingShape.lineTo(1.25, -.55); wingShape.lineTo(.6, -.35); wingShape.closePath();
  const wingGeo = new THREE.ShapeGeometry(wingShape).rotateX(Math.PI / 2);   // плоскость XZ, передний край — к +Z
  const wings = [];
  for (const s of [1, -1]) {
    const w = new THREE.Group(); w.position.set(s * .75, 2.75, .7); w.scale.set(s * 1.5, 1.5, 1.5);
    w.add(new THREE.Mesh(wingGeo, wingMat));
    const strut = mesh(new THREE.CylinderGeometry(.05, .04, 1.9, 5).rotateZ(-Math.PI / 2).translate(.95, 0, 0), boneMat);
    strut.rotation.y = -Math.atan2(1.0, 1.6); w.add(strut);
    w.userData.side = s;
    body.add(w); wings.push(w);
  }
  // хвост: цепочка сегментов, каждый — ребёнок предыдущего; на конце — драконья «лопата»
  const tail = [];
  let parent = new THREE.Group(); parent.position.set(0, 1.75, -1.7); body.add(parent);
  for (let k = 0; k < 7; k++) {
    const r0 = .45 - k * .05, r1 = r0 - .05;
    const seg = new THREE.Group();
    if (k) seg.position.z = -.52;
    seg.rotation.x = k === 0 ? -.45 : .09;
    seg.add(mesh(new THREE.CylinderGeometry(r1, r0, .56, 7).rotateX(Math.PI / 2).translate(0, 0, -.26), k % 2 ? furMat : scaleMat));
    seg.add(mesh(new THREE.ConeGeometry(.07, .28, 4), scaleMat, 0, r0 * .9, -.25));
    parent.add(seg); tail.push(seg); parent = seg;
  }
  const spade = mesh(new THREE.ConeGeometry(.32, .7, 4).rotateX(-Math.PI / 2), scaleMat, 0, 0, -.8);
  spade.scale.set(1, .3, 1); parent.add(spade);

  g.scale.setScalar(SCALE);
  g.userData = { body, legs, neck, head, jaw, wings, tail, torso };
  return g;
}

// ---------- скорпион: +Z — вперёд ----------
function makeScorpion() {
  const g = new THREE.Group();
  const body = sphere(.22, scMat, 1.1, .55, 1.6, 8); body.position.set(0, .28, 0); g.add(body);
  for (let k = 0; k < 3; k++) { const a = sphere(.16 - k * .03, scMat, 1.1, .6, 1, 7); a.position.set(0, .28, -.33 - k * .17); g.add(a); }
  const legs = [];
  for (const s of [1, -1]) for (let k = 0; k < 4; k++) {
    const p = new THREE.Group(); p.position.set(s * .18, .28, .15 - k * .1);
    p.add(mesh(new THREE.CylinderGeometry(.025, .018, .45, 4).translate(0, -.22, 0), scDark));
    p.rotation.set(0, 0, s * 1.0); p.userData.base = s * 1.0;
    g.add(p); legs.push(p);
  }
  for (const s of [1, -1]) {   // клешни
    const arm = new THREE.Group(); arm.position.set(s * .17, .3, .28); arm.rotation.y = s * .45;
    arm.add(mesh(new THREE.CylinderGeometry(.035, .03, .32, 5).rotateX(Math.PI / 2).translate(0, 0, .16), scDark));
    const c1 = mesh(new THREE.BoxGeometry(.1, .06, .22), scMat, .03, 0, .42), c2 = mesh(new THREE.BoxGeometry(.06, .05, .18), scDark, -.05, 0, .4);
    c1.rotation.y = -s * .15; c2.rotation.y = s * .3;
    arm.add(c1, c2); g.add(arm);
  }
  const tail = [];
  let parent = new THREE.Group(); parent.position.set(0, .3, -.72); g.add(parent);
  for (let k = 0; k < 5; k++) {
    const seg = new THREE.Group(); if (k) seg.position.z = -.14;
    seg.rotation.x = .55;
    seg.add(sphere(.085 - k * .007, scMat, 1, 1, 1.4, 7)); seg.children[0].position.z = -.07;
    parent.add(seg); tail.push(seg); parent = seg;
  }
  const sting = mesh(new THREE.ConeGeometry(.05, .18, 5).rotateX(-Math.PI / 2), stingMat, 0, 0, -.22); parent.add(sting);
  g.scale.setScalar(SC_SCALE);
  g.userData = { legs, tail };
  return g;
}

// ---------- скелет: рёбра-арки над позвоночником, череп с рогами, кости лап, крыльев, хвост ----------
function makeSkeleton() {
  const g = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const z = 1.3 - i * .32, r = .75 + Math.sin((i + 1) / 10 * Math.PI) * .55;
    const rib = new THREE.Mesh(new THREE.TorusGeometry(r, .06, 5, 14, Math.PI), boneMat);
    rib.position.set(0, 0, z); rib.rotation.z = (i % 2 ? .12 : -.1) + i * .01;
    g.add(rib);
    g.add(mesh(new THREE.SphereGeometry(.15, 7, 5), boneMat, Math.sin(rib.rotation.z) * -r, Math.cos(rib.rotation.z) * r, z));
  }
  for (let k = 0; k < 12; k++) {   // хвост — позвонки дугой вбок
    const r = .14 - k * .007;
    g.add(mesh(new THREE.SphereGeometry(r, 6, 4), boneMat, Math.sin(k * .28) * k * .16, r, -1.6 - k * .34));
  }
  const spade = mesh(new THREE.ConeGeometry(.3, .6, 4).rotateX(-Math.PI / 2), boneMat, 2.0, .06, -5.6); spade.scale.set(1, .3, 1);
  spade.rotation.y = .6; g.add(spade);
  const skull = new THREE.Group(); skull.position.set(.2, .45, 2.5); skull.rotation.set(.1, -.25, .45); g.add(skull);
  skull.add(sphere(.6, boneMat, 1, .8, 1.1));
  skull.add(mesh(new THREE.BoxGeometry(.5, .25, .85), boneMat, 0, -.05, .8));
  const jaw = mesh(new THREE.BoxGeometry(.45, .12, .8), boneMat, 0, -.35, .75); jaw.rotation.x = .35; skull.add(jaw);
  for (const s of [1, -1]) {
    skull.add(mesh(new THREE.SphereGeometry(.14, 7, 5), holeMat, s * .28, .15, .42));
    const horn = mesh(new THREE.ConeGeometry(.12, .9, 6).translate(0, .45, 0), boneMat, s * .3, .35, -.2); horn.rotation.set(-1.1, 0, -s * .35); skull.add(horn);
    for (let k = 0; k < 5; k++) skull.add(mesh(new THREE.ConeGeometry(.035, .13, 4).rotateX(Math.PI), boneMat, s * .2, -.2, .5 + k * .14));
  }
  const bone = (len, x, z, yaw) => {   // кость лапы/крыла, лежит на земле; шишки на концах
    const b = new THREE.Group(); b.position.set(x, .1, z); b.rotation.y = yaw;
    b.add(mesh(new THREE.CylinderGeometry(.08, .08, len, 6).rotateZ(Math.PI / 2), boneMat));
    b.add(mesh(new THREE.SphereGeometry(.14, 6, 4), boneMat, len / 2, 0, 0), mesh(new THREE.SphereGeometry(.14, 6, 4), boneMat, -len / 2, 0, 0));
    g.add(b);
  };
  bone(1.4, 1.5, 1.0, .5); bone(1.3, -1.6, .9, -.3); bone(1.4, 1.4, -1.2, -.6); bone(1.35, -1.5, -1.1, .9);
  for (const s of [1, -1]) for (let k = 0; k < 3; k++) bone(2.2 - k * .3, s * (1.9 + k * .3), .4 - k * .5, s * (.25 + k * .35));
  g.scale.setScalar(SCALE * 1.5);   // крупнее живого — «большой скелет», видно издалека
  return g;
}

// ---------- состояние ----------
const initialFwd = () => new THREE.Vector3(1, 0, 0).addScaledVector(bioAxis, -bioAxis.x).normalize();
// снимок хозяина (у остальных — последний принятый); host-only поля — chaseT, lostT, calmUntil, wander, pauseT
export const monster = {
  gen: 1,
  dir: bioAxis.clone(), fwd: initialFwd(), hp: MON_HP, st: 'idle', tgt: null, spawned: false, respawnAt: 0,
  scorps: [],       // { id, dir, fwd, hp, mode: 'in'|'out', t }
  skeletons: [],    // { dir, fwd }
  chaseT: 0, lostT: 0, calmUntil: 0, wander: null, pauseT: 0,
};
const m = monster;
let synced = !ROOM, quiet = false;   // quiet — первый принятый снимок: переходы состояния в нём не события (без рёва)
const SYNC_ALONE_T = 6;
const lowestSlot = () => Math.min(net.slot < 0 ? Infinity : net.slot, ...net.remotes.keys());
export const isMonsterHost = () => !ROOM || (synced && (net.slot < 0 ? net.remotes.size === 0 : lowestSlot() === net.slot));

// ---------- шаг по сфере ----------
const _st = new THREE.Vector3(), _cand = new THREE.Vector3(), _hd = new THREE.Vector3(), _pd = new THREE.Vector3();
function tangent(v, dir) {
  v.addScaledVector(dir, -v.dot(dir));
  if (v.lengthSq() < 1e-10) v.set(dir.y, -dir.x, 0).addScaledVector(dir, 0);
  if (v.lengthSq() < 1e-10) v.set(0, dir.z, -dir.y);
  return v.normalize();
}
const arc = (a, b) => a.angleTo(b) * P.R;
// o { dir, fwd } поворачивает морду к goal (или от него при speed < 0) и шагает; forestOnly — не выходить из леса
function stepToward(o, goal, speed, stop, dt, turn, forestOnly) {
  let v = speed;
  if (goal) {
    _hd.copy(goal).addScaledVector(o.dir, -goal.dot(o.dir));
    if (_hd.lengthSq() > 1e-12) {
      _hd.normalize();
      if (v < 0) _hd.negate();
      o.fwd.lerp(_hd, Math.min(1, dt * turn));
    }
    if (v > 0 && arc(o.dir, goal) < stop) v = 0;
  }
  tangent(o.fwd, o.dir);
  v = Math.abs(v);
  if (v <= 0) return;
  const ang = v * dt / P.R;
  for (const off of forestOnly ? [0, .5, -.5, 1.1, -1.1] : [0]) {
    _st.copy(o.fwd); if (off) _st.applyAxisAngle(o.dir, off);
    _cand.copy(o.dir).multiplyScalar(Math.cos(ang)).addScaledVector(_st, Math.sin(ang)).normalize();
    if (forestOnly && biomeAt(_cand) !== BIOME.FOREST) continue;
    o.dir.copy(_cand);
    tangent(o.fwd, o.dir);
    return;
  }
}
// точка в dist м от dir в случайную сторону
function around(dir, dist, out = new THREE.Vector3()) {
  tangent(_st.set(Math.random() - .5, Math.random() - .5, Math.random() - .5), dir);
  return out.copy(dir).multiplyScalar(Math.cos(dist / P.R)).addScaledVector(_st, Math.sin(dist / P.R)).normalize();
}

// живые цели: мы и остальные (не в доме, не лежат)
function targets() {
  const list = [];
  if (!player.inside && !player.dead) list.push({ id: ME.id, dir: player.pos.clone().normalize() });
  for (const r of net.remotes.values())
    if (r.pos && r.group.visible && !(r.last && r.last.dd)) list.push({ id: r.id, dir: r.pos.clone().normalize() });
  return list;
}
function nearest(list, dir, maxD) {
  let best = null, bd = maxD;
  for (const p of list) { const d = arc(p.dir, dir); if (d < bd) { bd = d; best = p; } }
  return best;
}

// ---------- симуляция (только у хозяина) ----------
function simulate(dt) {
  const now = clock.elapsedTime;
  if (m.st === 'dead') { if (Date.now() >= m.respawnAt) respawnMonster(); return; }
  const list = targets();
  if (m.st === 'chase') {
    const t = list.find(p => p.id === m.tgt);
    m.chaseT += dt;
    if (!t || arc(t.dir, m.dir) > LOSE_R) m.lostT += dt; else m.lostT = 0;
    if (m.lostT > LOSE_T || m.chaseT > CHASE_MAX) { m.st = 'return'; m.tgt = null; m.calmUntil = now + CALM_T; }
    else if (t) stepToward(m, t.dir, P.SPEED + 1, STOP_CHASE, dt, 5, true);
  }
  if (m.st !== 'chase' && now > m.calmUntil) {
    const p = nearest(list, m.dir, AGGRO_R);
    if (p) { m.st = 'chase'; m.tgt = p.id; m.chaseT = 0; m.lostT = 0; }
  }
  if (m.st === 'return') {
    stepToward(m, bioAxis, RETURN_V, 1, dt, 3, true);
    if (arc(m.dir, bioAxis) < 10) { m.st = 'idle'; m.wander = null; }
  }
  if (m.st === 'idle' || m.st === 'caravan') {
    // ближайший верблюд, идущий по лесу
    let camel = null, cd = m.st === 'caravan' ? CARAVAN_SEE + 10 : CARAVAN_SEE;
    for (const c of caravan.camels) {
      _pd.copy(c.group.position).normalize();
      const d = arc(_pd, m.dir);
      if (d < cd && biomeAt(_pd) === BIOME.FOREST) { cd = d; camel = (camel || new THREE.Vector3()).copy(_pd); }
    }
    if (camel) {
      m.st = 'caravan';
      const v = cd > CARAVAN_NEAR + 2 ? FOLLOW_V : cd < CARAVAN_NEAR - 2 ? -1.5 : 0;
      stepToward(m, camel, v, 0, dt, 2, true);
    } else if (m.st === 'caravan') m.st = 'return';
    else {
      if (!m.wander || arc(m.dir, m.wander) < 2) {
        if (m.wander) { m.wander = null; m.pauseT = now + 3 + Math.random() * 4; }
        if (now > m.pauseT) m.wander = around(bioAxis, Math.random() * HOME_R);
      }
      if (m.wander) stepToward(m, m.wander, WANDER_V, 1.5, dt, 1.5, true);
    }
  }
  // скорпионы: к ближайшему игроку — укусить — отскочить; без целей кружат у матери
  const pack = new Map();   // id игрока -> сколько скорпионов сейчас на него бросаются
  for (const s of m.scorps) {
    const p = nearest(list, s.dir, SC_HUNT_R);
    s.t -= dt;
    const busy = p && s.mode === 'in' && (pack.get(p.id) || 0) >= SC_PACK;
    if (p && s.mode === 'in' && !busy) pack.set(p.id, (pack.get(p.id) || 0) + 1);
    if (busy) {                // ждут очереди: кружат вокруг игрока
      const a = s.id * 2.4 + now * .8;
      _st.set(Math.cos(a), Math.sin(a), Math.cos(a * .7)); tangent(_st, p.dir);
      _cand.copy(p.dir).multiplyScalar(Math.cos(SC_RING / P.R)).addScaledVector(_st, Math.sin(SC_RING / P.R)).normalize();
      stepToward(s, _cand, P.SPEED, .5, dt, 6, false);
      s.t = 6;                 // дождался — бросок с полным запасом времени
    } else if (p) {
      if (s.mode === 'in') {
        stepToward(s, p.dir, P.SPEED + SC_BONUS, .6, dt, 8, false);
        if (arc(s.dir, p.dir) < 1.1 && s.t > .9) s.t = .9;      // добежал — ещё мгновение и назад
        if (s.t <= 0) { s.mode = 'out'; s.t = .6 + Math.random() * .6; }
      } else {
        stepToward(s, p.dir, -8, 0, dt, 8, false);
        if (s.t <= 0) { s.mode = 'in'; s.t = 6; }                // бросок — пока не добежит (не дольше 6 с)
      }
    } else {
      const a = s.id * 2.4 + now * .5;
      _st.set(Math.cos(a), Math.sin(a), Math.cos(a * .7)); tangent(_st, m.dir);
      _cand.copy(m.dir).multiplyScalar(Math.cos(6 / P.R)).addScaledVector(_st, Math.sin(6 / P.R)).normalize();
      stepToward(s, _cand, 6, .5, dt, 4, false);
    }
    for (const o of m.scorps) {   // не слипаться
      if (o === s) continue;
      const d = arc(o.dir, s.dir);
      if (d < 1.1 && d > 1e-4) { _st.copy(s.dir).sub(o.dir); tangent(_st, s.dir); s.dir.addScaledVector(_st, (1.1 - d) * .5 / P.R).normalize(); }
    }
  }
}
function spawnScorps() {
  m.spawned = true;
  const n = SC_MIN + Math.floor(Math.random() * (SC_MAX - SC_MIN + 1));
  const mouth = _cand.copy(m.dir).multiplyScalar(Math.cos(3.2 / P.R)).addScaledVector(m.fwd, Math.sin(3.2 / P.R)).normalize().clone();
  for (let k = 0; k < n; k++) {
    const dir = around(mouth, Math.random() * 1.5);
    m.scorps.push({ id: k, dir, fwd: m.fwd.clone().applyAxisAngle(dir, (Math.random() - .5) * 2.5), hp: 2 + (Math.random() < .5 ? 1 : 0), mode: 'out', t: .3 + Math.random() * .7 });
  }
}
function die() {
  m.st = 'dead'; m.hp = 0; m.tgt = null; m.scorps = [];
  m.respawnAt = Date.now() + RESPAWN_MS;
  m.skeletons.push({ dir: m.dir.clone(), fwd: m.fwd.clone() });
  if (m.skeletons.length > MAX_SKELETONS) m.skeletons.shift();
}
function respawnMonster() {
  m.gen++;
  Object.assign(m, { hp: MON_HP, st: 'idle', tgt: null, spawned: false, scorps: [], wander: null, chaseT: 0, lostT: 0, calmUntil: 0 });
  m.dir.copy(bioAxis); m.fwd.copy(initialFwd());
}
// попадание (у хозяина): kind 'm' — монстр, 's' — скорпион id; by — кто стрелял (монстр идёт на него)
function applyHit(kind, id, n, by) {
  if (m.st === 'dead') return;
  if (kind === 'm') {
    m.hp = Math.max(0, m.hp - n);
    if (m.hp <= 0) { die(); return; }
    if (!m.spawned && m.hp <= MON_HP / 2) spawnScorps();
    if (m.st !== 'chase' && by) {
      const p = targets().find(q => q.id === by);
      if (p && arc(p.dir, m.dir) < LOSE_R * 1.5) { m.st = 'chase'; m.tgt = by; m.chaseT = 0; m.lostT = 0; }
    }
  } else {
    const s = m.scorps.find(q => q.id === id);
    if (!s) return;
    s.hp -= n;
    if (s.hp <= 0) m.scorps.splice(m.scorps.indexOf(s), 1);
  }
}
function reportHit(kind, id, n) {
  if (isMonsterHost()) applyHit(kind, id, n, ME.id);
  else netBroadcast({ t: 'mhit', k: kind, id, n, by: ME.id });
}

// ---------- снимки ----------
const r4 = v => Math.round(v * 1e4) / 1e4;
const v3 = v => [r4(v.x), r4(v.y), r4(v.z)];
function snapshot() {
  return {
    g: m.gen, d: v3(m.dir), f: v3(m.fwd), hp: m.hp, st: m.st, tg: m.tgt, sp: m.spawned ? 1 : 0,
    rs: m.st === 'dead' ? Math.max(0, m.respawnAt - Date.now()) : 0,
    sc: m.scorps.map(s => [s.id, ...v3(s.dir), s.hp]),
    sk: m.skeletons.map(k => [...v3(k.dir), ...v3(k.fwd)]),
  };
}
function adopt(s, slot) {
  if (!s || !Array.isArray(s.d)) return;
  if (synced && (isMonsterHost() || slot !== lowestSlot())) return;   // синхронизированный слушает только хозяина
  if (!synced) { synced = true; quiet = true; }
  m.gen = s.g; m.hp = s.hp; m.st = s.st; m.tgt = s.tg ?? null; m.spawned = !!s.sp;
  m.dir.fromArray(s.d).normalize(); m.fwd.fromArray(s.f); tangent(m.fwd, m.dir);
  m.respawnAt = Date.now() + (s.rs || 0);
  const old = new Map(m.scorps.map(x => [x.id, x]));
  m.scorps = (s.sc || []).map(([id, x, y, z, hp]) => {
    const o = old.get(id) || { id, fwd: new THREE.Vector3(1, 0, 0), mode: 'in', t: 1 };
    o.dir = new THREE.Vector3(x, y, z).normalize(); o.hp = hp; tangent(o.fwd, o.dir);
    return o;
  });
  m.skeletons = (s.sk || []).map(a => ({ dir: new THREE.Vector3(a[0], a[1], a[2]).normalize(), fwd: new THREE.Vector3(a[3], a[4], a[5]) }));
  if (m.st === 'chase') m.calmUntil = 0;
}
onNet('mon', (s, slot) => adopt(s, slot));
onNet('hello', (h, slot) => adopt(h.mon, slot));
addHelloFields(() => synced ? { mon: snapshot() } : {});
onNet('mhit', h => { if (isMonsterHost()) applyHit(h.k, h.id, h.n | 0, h.by); });

// ---------- отображение (у всех) ----------
const monG = makeMonster();
scene.add(monG);
const U = monG.userData;
const view = { dir: m.dir.clone(), fwd: m.fwd.clone(), st: null, gen: m.gen, speed: 0, ph: 0, deathT: -1e9, flash: 0,
               bite: 0, roar: 0, lastBite: -1e9, spawned: false, hpSeen: m.hp, nextGrowl: 0 };
const scViews = new Map();   // id -> { g, dir, fwd, ph, deadT, lastBite, nextChit }
const skViews = new Map();   // ключ -> { g, showAt }
const stuckInMonster = [];
const _u = new THREE.Vector3(), _r = new THREE.Vector3(), _mm = new THREE.Matrix4(), _prev = new THREE.Vector3();
function place(g, dir, fwd, lift = 0) {
  _u.copy(dir).negate();
  _r.crossVectors(_u, fwd);
  g.position.copy(dir).multiplyScalar(surfaceR(dir) - 0.03 - lift);
  g.quaternion.setFromRotationMatrix(_mm.makeBasis(_r, _u, fwd));
}
function resetMonsterView() {
  for (const a of stuckInMonster) monG.remove(a);
  stuckInMonster.length = 0;
  U.body.rotation.set(0, 0, 0); U.body.position.set(0, 0, 0);
  monG.visible = true;
  view.dir.copy(m.dir); view.fwd.copy(m.fwd);
  view.spawned = m.spawned; view.hpSeen = m.hp;
}

// голова и туловище в мире — для попаданий и укусов
const _head = new THREE.Vector3(), _torso = new THREE.Vector3();
function hitCenters() {
  monG.updateMatrixWorld();
  U.head.getWorldPosition(_head);
  U.torso.getWorldPosition(_torso);
}
const _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _hit = new THREE.Vector3(), _sc = new THREE.Vector3();
// отрезок from→to против шара (c, r): точка входа в _hit
function segSphere(from, to, c, r) {
  _ab.subVectors(to, from);
  _ac.subVectors(c, from);
  const len2 = _ab.lengthSq();
  const t = len2 > 0 ? THREE.MathUtils.clamp(_ac.dot(_ab) / len2, 0, 1) : 0;
  _hit.copy(from).addScaledVector(_ab, t);
  const d2 = _hit.distanceToSquared(c);
  if (d2 > r * r) return false;
  const back = len2 > 0 ? Math.sqrt(r * r - d2) / Math.sqrt(len2) : 0;
  _hit.copy(from).addScaledVector(_ab, Math.max(0, t - back));
  return true;
}
onArrowHit((from, to, a) => {
  if (monG.visible && m.st !== 'dead') {
    hitCenters();
    const head = segSphere(from, to, _head, 0.8 * SCALE);
    if (head || segSphere(from, to, _torso, 1.55 * SCALE)) {
      a.g.position.copy(_hit).addScaledVector(_ab.normalize(), 0.35);   // наконечник — в тело
      monG.attach(a.g);
      stuckInMonster.push(a.g);
      view.flash = 1;
      sfxHit();
      if (a.own) reportHit('m', 0, head ? 2 : 1);
      return true;
    }
  }
  for (const [id, sv] of scViews) {
    if (sv.deadT > 0) continue;
    _sc.copy(sv.g.position).addScaledVector(_u.copy(sv.g.position).normalize(), -0.3);   // центр тела — на 0,3 м над землёй
    if (!segSphere(from, to, _sc, 0.6)) continue;
    scene.remove(a.g);
    sv.flash = 1;
    sfxScHit(sv.dir);
    if (a.own) reportHit('s', id, 1);
    return true;
  }
  return false;
});

// ---------- HUD босса ----------
const bossEl = document.getElementById('boss'), bossFill = document.getElementById('bossFill'), bossText = document.getElementById('bossText');
function updateBossBar(myDir) {
  const d = arc(view.dir, myDir);
  const alive = m.st !== 'dead';
  const show = !player.inside && (alive ? d < 70 || m.tgt === ME.id || m.scorps.length > 0 : d < 40);
  bossEl.style.display = show ? 'block' : 'none';   // в CSS display:none
  if (!show) return;
  if (alive) {
    bossFill.parentElement.style.display = 'block';
    bossFill.style.width = `${100 * m.hp / MON_HP}%`;
    bossText.textContent = `${NAME} — ${m.hp} / ${MON_HP}` + (m.scorps.length ? `  ·  скорпионов: ${m.scorps.length}` : '') +
      (m.st === 'chase' ? (m.tgt === ME.id ? '  ·  гонится за вами!' : '  ·  в ярости') : '');
  } else {
    bossFill.parentElement.style.display = 'none';
    const left = Math.max(0, m.respawnAt - Date.now()) / 1000;
    bossText.textContent = `${NAME} повержен · новый проснётся через ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  }
}

// ---------- кадр ----------
let snapAcc = 0;
export function updateMonster(dt) {
  if (dt <= 0) return;
  if (!synced && clock.elapsedTime > SYNC_ALONE_T && net.remotes.size === 0) synced = true;   // в комнате никого — бой наш
  const host = isMonsterHost();
  if (host) {
    simulate(dt);
    snapAcc += dt;
    if (ROOM && snapAcc >= 1 / SNAP_HZ && net.conns.size) { snapAcc = 0; netBroadcast(Object.assign({ t: 'mon' }, snapshot())); }
  }
  const t = clock.elapsedTime;
  const myDir = _pd.copy(player.pos).normalize().clone();

  // смена поколения / смерть / рёв — по переходам состояния
  if (view.gen !== m.gen) { view.gen = m.gen; view.st = null; resetMonsterView(); for (const sv of scViews.values()) scene.remove(sv.g); scViews.clear(); }
  if (view.st !== m.st) {
    const prev = quiet ? null : view.st;   // первый принятый снимок — не событие (не ревём и не падаем при входе)
    if (m.st === 'dead' && prev && prev !== 'dead') { view.deathT = t; sfxDeath(view.dir); }
    else if (m.st === 'dead' && !prev) monG.visible = false;            // пришли, а он уже мёртв
    if (prev === 'dead' && m.st !== 'dead') resetMonsterView();
    if (m.st === 'chase' && prev !== null) { view.roar = 1.3; sfxRoar(view.dir, 1.3, 90, .55); }
    view.st = m.st;
  }
  if (m.spawned && !view.spawned) { view.spawned = true; if (!quiet) { view.roar = 1.6; sfxBirth(view.dir); } }
  quiet = false;
  if (!m.spawned) view.spawned = false;
  if (m.hp < view.hpSeen && !host) view.flash = Math.max(view.flash, .6);
  view.hpSeen = m.hp;

  // монстр
  if (m.st !== 'dead' || t - view.deathT < DEATH_ANIM) {
    _prev.copy(view.dir);
    if (host || view.dir.angleTo(m.dir) * P.R > 20) { view.dir.copy(m.dir); view.fwd.copy(m.fwd); }
    else {
      const k = 1 - Math.exp(-dt * 10);
      view.dir.lerp(m.dir, k).normalize(); view.fwd.lerp(m.fwd, k);
    }
    tangent(view.fwd, view.dir);
    view.speed += (_prev.angleTo(view.dir) * P.R / dt - view.speed) * Math.min(1, dt * 6);
    place(monG, view.dir, view.fwd);
    animateMonster(dt, t);
    if (m.st === 'dead') {
      const a = Math.min(1, (t - view.deathT) / 1.4);
      const e = a * a * (3 - 2 * a);
      U.body.rotation.z = e * Math.PI / 2 * .92;           // валится на бок (вокруг оси «нос — хвост» у земли)
      U.body.position.set(0, e * 1.0, 0);                  // лёжа туловище толщиной ~1,25 м — приподнять над землёй
      U.jaw.rotation.x = .7;
    }
  } else if (monG.visible) monG.visible = false;

  // укусы монстра — решаем сами за себя
  if (m.st === 'chase' && !player.dead && !player.inside && monG.visible) {
    hitCenters();
    _cand.copy(_head).normalize();
    if (arc(_cand, myDir) < BITE_R && t - view.lastBite > BITE_CD) {
      view.lastBite = t; view.bite = .35;
      sfxBite(view.dir);
      damagePlayer(BITE_DMG, NAME);
    }
  }
  if (m.st !== 'dead' && t > view.nextGrowl) {           // ворчит, пока бродит
    view.nextGrowl = t + 8 + Math.random() * 10;
    if (m.st !== 'chase') sfxRoar(view.dir, .9, 55, .28, 45);
  }

  updateScorpions(dt, t, host, myDir);
  updateSkeletons(t);
  updateBossBar(myDir);
  furMat.emissive.setRGB(view.flash * .6, 0, 0);
  scMat.emissive.setRGB(0, 0, 0);
  view.flash = Math.max(0, view.flash - dt * 4);
}

function animateMonster(dt, t) {
  const moving = view.speed > .3, chase = m.st === 'chase';
  view.ph += dt * (moving ? 1.6 + Math.min(view.speed, 20) * .45 : .5);
  const amp = moving ? Math.min(.55, .2 + view.speed * .03) : .03;
  U.legs.forEach((leg, k) => { leg.rotation.x = Math.sin(view.ph + (k === 0 || k === 3 ? 0 : Math.PI)) * amp; });
  U.body.position.y = Math.abs(Math.sin(view.ph)) * (moving ? .08 : .01);
  U.tail.forEach((s, k) => { s.rotation.y = Math.sin(t * (chase ? 3 : 1.4) + k * .55) * (chase ? .16 : .09); });
  const flap = chase ? .2 + Math.sin(t * 6) * .4 : .3 + Math.sin(t * 1.2) * .06;   // полураскрыты; в погоне — машет
  U.wings.forEach(w => { w.rotation.set(0, w.userData.side * .55, w.userData.side * flap); });
  view.roar = Math.max(0, view.roar - dt);
  view.bite = Math.max(0, view.bite - dt);
  const open = Math.max(view.roar > 0 ? .55 : 0, view.bite > 0 ? Math.sin(view.bite / .35 * Math.PI) * .7 : 0);
  U.jaw.rotation.x += ((m.st === 'dead' ? .7 : open) - U.jaw.rotation.x) * Math.min(1, dt * 14);
  U.neck.rotation.x = view.roar > 0 ? -.25 : Math.sin(view.ph * .5) * .06;
  U.head.rotation.y = Math.sin(t * .4) * (moving ? .08 : .3);
}

function updateScorpions(dt, t, host, myDir) {
  const alive = new Set();
  for (const s of m.scorps) {
    alive.add(s.id);
    let sv = scViews.get(s.id);
    if (!sv) {
      sv = { g: makeScorpion(), dir: s.dir.clone(), fwd: s.fwd.clone(), ph: Math.random() * 6, deadT: -1, lastBite: -1e9, nextChit: t + Math.random() * 3, flash: 0 };
      scene.add(sv.g); scViews.set(s.id, sv);
    }
    _prev.copy(sv.dir);
    if (host) sv.dir.copy(s.dir); else sv.dir.lerp(s.dir, 1 - Math.exp(-dt * 12)).normalize();
    _st.copy(sv.dir).sub(_prev);
    const moved = _st.length() * P.R;
    if (moved > 1e-4) { tangent(_st, sv.dir); sv.fwd.lerp(_st, Math.min(1, dt * 10)); }
    tangent(sv.fwd, sv.dir);
    place(sv.g, sv.dir, sv.fwd);
    sv.ph += dt * (moved / dt > .5 ? 24 : 3);
    sv.g.userData.legs.forEach((p, k) => { p.rotation.y = Math.sin(sv.ph + k * 1.3) * .35; p.rotation.z = p.userData.base + Math.sin(sv.ph + k) * .1; });
    sv.g.userData.tail.forEach((seg, k) => { seg.rotation.x = .55 + Math.sin(t * 5 + k * .6 + s.id) * .08; });
    sv.g.scale.setScalar(SC_SCALE * (1 + sv.flash * .25));
    sv.flash = Math.max(0, sv.flash - dt * 5);
    // укус и стрёкот
    const d = arc(sv.dir, myDir);
    if (!player.dead && !player.inside && d < SC_BITE_R && t - sv.lastBite > SC_CD) {
      sv.lastBite = t;
      sfxScBite(sv.dir);
      damagePlayer(SC_DMG, 'Скорпион');
    }
    if (t > sv.nextChit) { sv.nextChit = t + 1.5 + Math.random() * 3; sfxChitter(sv.dir, 3 + Math.floor(Math.random() * 4)); }
  }
  // убитые: переворачиваются брюхом вверх и через 3 с исчезают
  for (const [id, sv] of scViews) {
    if (alive.has(id)) continue;
    if (sv.deadT < 0) { sv.deadT = t; sfxScDie(sv.dir); }
    const a = Math.min(1, (t - sv.deadT) / .4);
    place(sv.g, sv.dir, sv.fwd, .4 * a);                 // брюхом вверх тело оказалось бы под землёй — приподнять
    sv.g.rotateZ(Math.PI * a);
    if (t - sv.deadT > 3) { scene.remove(sv.g); scViews.delete(id); }
  }
}

radiusListeners.push(() => { for (const sk of skViews.values()) place(sk.g, sk.dir, sk.fwd); });   // сменили R/рельеф
function updateSkeletons(t) {
  const keys = new Set();
  for (const k of m.skeletons) {
    const key = v3(k.dir).join(',');
    keys.add(key);
    if (skViews.has(key)) continue;
    const g = makeSkeleton();
    const dir = k.dir.clone(), fwd = tangent(k.fwd.clone(), k.dir);
    place(g, dir, fwd);
    const showAt = t - view.deathT < DEATH_ANIM ? view.deathT + DEATH_ANIM : 0;   // видели смерть — после падения
    g.visible = showAt === 0;
    scene.add(g);
    skViews.set(key, { g, showAt, dir, fwd });
  }
  for (const [key, sk] of skViews) {
    if (!keys.has(key)) { scene.remove(sk.g); skViews.delete(key); continue; }
    if (!sk.g.visible && t >= sk.showAt) sk.g.visible = true;
  }
}

// ---------- звуки: всё в selfBus с затуханием по расстоянию до игрока ----------
function out(dir, maxD, gain) {
  if (!audio) return null;
  const k = 1 - arc(dir, _hd.copy(player.pos).normalize()) / maxD;
  if (k <= 0) return null;
  const g = audio.ctx.createGain();
  g.gain.value = gain * k * k;
  g.connect(audio.selfBus);
  return g;
}
function noiseSrc(ctx, t, dur) {
  const s = ctx.createBufferSource(); s.buffer = audio.noise; s.loop = true;
  s.start(t, Math.random() * .2); s.stop(t + dur + .05);
  return s;
}
// рёв: три пилы (основной тон, квинта, октава вниз) с вибрато через lowpass, плюс хрип — шум в полосе ~500 Гц
function roar(o, dur, f0, f1, t = audio.ctx.currentTime) {
  const ctx = audio.ctx;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + .15);
  env.gain.setValueAtTime(1, t + dur * .6); env.gain.exponentialRampToValueAtTime(.0005, t + dur);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
  lp.frequency.setValueAtTime(300, t); lp.frequency.linearRampToValueAtTime(1100, t + dur * .3); lp.frequency.linearRampToValueAtTime(250, t + dur);
  lp.connect(env).connect(o);
  for (const det of [1, 1.5, .5]) {
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0 * det, t);
    osc.frequency.linearRampToValueAtTime(f0 * det * 1.15, t + dur * .3);
    osc.frequency.exponentialRampToValueAtTime(f1 * det, t + dur);
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 6 + Math.random() * 4; lg.gain.value = f0 * det * .06;
    lfo.connect(lg).connect(osc.frequency);
    const og = ctx.createGain(); og.gain.value = det === 1 ? .35 : .18;
    osc.connect(og).connect(lp);
    osc.start(t); lfo.start(t); osc.stop(t + dur + .05); lfo.stop(t + dur + .05);
  }
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = .9;
  const ng = ctx.createGain(); ng.gain.value = .5;
  noiseSrc(ctx, t, dur).connect(bp).connect(ng).connect(lp);
}
function thump(o, f0, f1, gain, dur, t = audio.ctx.currentTime) {
  const ctx = audio.ctx, osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f0, t); osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(.0004, t + dur);
  osc.connect(g).connect(o); osc.start(t); osc.stop(t + dur + .02);
}
function burst(o, type, freq, q, gain, dur, t = audio.ctx.currentTime) {
  const ctx = audio.ctx, f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + .005); g.gain.exponentialRampToValueAtTime(.0004, t + dur);
  noiseSrc(ctx, t, dur).connect(f).connect(g).connect(o);
  return f;
}
function sfxRoar(dir, dur, f0, gain, f1 = 60) { const o = out(dir, 90, gain); if (o) roar(o, dur, f0, f1); }
function sfxDeath(dir) {   // громко и далеко: долгий рёв, срывающийся вниз, и удар падающего тела
  const o = out(dir, 260, 1.0);
  if (!o) return;
  const t = audio.ctx.currentTime;
  roar(o, 3.6, 125, 36, t);
  roar(o, 2.4, 190, 70, t + .25);
  thump(o, 70, 28, 1.2, .9, t + 1.35);
  burst(o, 'lowpass', 180, .7, .8, .7, t + 1.35);
}
function sfxBite(dir) { const o = out(dir, 40, .7); if (!o) return; burst(o, 'highpass', 1800, .7, .8, .05); thump(o, 210, 90, .6, .09); }
function sfxHit() { const o = out(view.dir, 90, .6); if (!o) return; thump(o, 170, 70, .8, .12); roar(o, .4, 140, 95); }
function sfxBirth(dir) {
  const o = out(dir, 90, .7);
  if (!o) return;
  roar(o, 1.5, 70, 50);
  const f = burst(o, 'lowpass', 300, 3, .7, .6); f.frequency.exponentialRampToValueAtTime(90, audio.ctx.currentTime + .5);
  chitter(o, 30, 1.4);
}
function chitter(o, n, span) {
  const t0 = audio.ctx.currentTime;
  for (let i = 0; i < n; i++) burst(o, 'bandpass', 3200 + Math.random() * 1500, 6, .5, .015, t0 + Math.random() * span);
}
function sfxChitter(dir, n) { const o = out(dir, 25, .35); if (o) chitter(o, n, n * .05); }
function sfxScBite(dir) { const o = out(dir, 25, .5); if (o) { burst(o, 'bandpass', 2600, 4, .7, .03); burst(o, 'bandpass', 2000, 4, .6, .03, audio.ctx.currentTime + .06); } }
function sfxScHit(dir) { const o = out(dir, 60, .5); if (o) { burst(o, 'bandpass', 1500, 2, .7, .05); chitter(o, 4, .15); } }
function sfxScDie(dir) { const o = out(dir, 60, .5); if (!o) return; const f = burst(o, 'lowpass', 900, 2, .8, .25); f.frequency.exponentialRampToValueAtTime(150, audio.ctx.currentTime + .25); }

// ---------- отладка ----------
export function debugMonsterHit(n = 1, kind = 'm', id = 0) { reportHit(kind, id, n); }
export const monsterView = view;
