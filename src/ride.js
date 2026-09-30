// Верблюд под седлом.
// Подойти вплотную к верблюду каравана и идти рядом с ним P.TAME_T секунд — полоска на экране ползёт; отошёл —
// откатывается втрое быстрее. Когда дошла до конца — игрок «садится»: верблюд уходит из цепочки (его место
// пустует), идёт под игроком, глаза поднимаются на RIDE_H, к скорости ходьбы прибавляется P.RIDE_BONUS.
// E — слезть: верблюд бежит обратно на своё место в караване быстрее игрока (SPEED + RETURN_EXTRA) и снова
// идёт в цепочке. На верблюде в дом не пускают (house.js).
// Сеть: 'camel' {i, s:'ride'|'back', by|d} при посадке/спуске, поле c (номер верблюда) в pos, поле camel в hello —
// так все видят, чей верблюд где. Конфликт (двое сели одновременно) решается по id: уступает больший.
// Пропавший седок (вышел из комнаты) — через 6 с без pos верблюд сам бежит назад.
import * as THREE from 'three';
import { ROOM, ME, player, clock } from './state.js';
import { P } from './params.js';
import { surfaceR } from './terrain.js';
import { caravan, camelSlotDir } from './caravan.js';
import { net, onNet, addHelloFields, addPosFields, netBroadcast } from './net.js';

export const ride = { camel: -1, target: -1, progress: 0, hint: '' };   // camel — на котором сидим; target — которого приручаем
const NEAR = 2.8;          // м до центра верблюда — «вплотную»
const RIDE_H = 1.8;        // подъём глаз в седле: сидим между горбами (~2.5 м), глаза выше головы верблюда
const RETURN_EXTRA = 4;    // м/с сверх скорости игрока — возвращаясь, верблюд убегает

// состояние верблюда вне цепочки; у идущих в караване st.away === null
function stateOf(c) {
  if (!c.st) c.st = { rider: null, away: null, dir: new THREE.Vector3(), seen: 0, ph: 0, prev: null };
  return c.st;
}
export const camelRider = i => { const c = caravan.camels[i]; return c ? stateOf(c).rider : null; };

function mount(i) {
  const c = caravan.camels[i];
  if (!c || stateOf(c).away === 'dead') return;
  const st = stateOf(c);
  st.rider = ME.id; st.away = 'ride'; st.seen = clock.elapsedTime;
  ride.camel = i; ride.target = -1; ride.progress = 0;
  player.rideH = RIDE_H; player.speedBonus = P.RIDE_BONUS;
  if (ROOM) netBroadcast({ t: 'camel', i, s: 'ride', by: ME.id });
}
function dismount(broadcast = true) {
  const i = ride.camel;
  if (i < 0) return;
  const st = stateOf(caravan.camels[i]);
  st.rider = null; st.away = 'back'; st.dir.copy(player.pos).normalize();
  ride.camel = -1; player.rideH = 0; player.speedBonus = 0;
  if (broadcast && ROOM) netBroadcast({ t: 'camel', i, s: 'back', d: st.dir.toArray() });
}
// кто-то заявил, что сидит на верблюде i
function claimed(i, by) {
  const c = caravan.camels[i];
  if (!c || !by || stateOf(c).away === 'dead') return;
  const st = stateOf(c);
  if (ride.camel === i) {                       // сели одновременно — уступает тот, у кого id больше
    if (by < ME.id) dismount(false); else return;
  }
  st.rider = by; st.away = 'ride'; st.seen = clock.elapsedTime;
  if (ride.target === i) { ride.target = -1; ride.progress = 0; }
}

export const forceDismount = () => dismount();   // погиб верхом (health.js)
// верблюд убит: выпадает из цепочки и больше никого не возит. Седок оказывается на земле.
export function noteCamelDead(i) {
  const c = caravan.camels[i];
  if (!c) return;
  const st = stateOf(c);
  const wasOurs = ride.camel === i;
  const already = st.away === 'dead';
  st.rider = null;
  st.away = 'dead';
  if (ride.target === i) { ride.target = -1; ride.progress = 0; }
  if (!wasOurs) return;
  ride.camel = -1;
  player.rideH = 0;
  player.speedBonus = 0;
  if (!already && ROOM) netBroadcast({ t: 'camel', i, s: 'dead' });
}

const isTyping = e => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
addEventListener('keydown', e => {
  if (e.code !== 'KeyE' || e.repeat || isTyping(e)) return;
  if (ride.camel >= 0) dismount();
});

// ---------- сеть ----------
onNet('camel', m => {
  const c = caravan.camels[m.i];
  if (!c) return;
  if (m.s === 'dead' || stateOf(c).away === 'dead') { noteCamelDead(m.i); return; }
  if (m.s === 'ride') claimed(m.i, m.by);
  else if (m.s === 'back') {
    const st = stateOf(c);
    if (st.rider === ME.id) return;
    st.rider = null; st.away = 'back';
    if (Array.isArray(m.d)) st.dir.fromArray(m.d).normalize(); else st.dir.copy(c.group.position).normalize();
  }
});
onNet('hello', m => { if (Number.isInteger(m.camel)) claimed(m.camel, m.id); });
addHelloFields(() => ride.camel >= 0 ? { camel: ride.camel } : {});
addPosFields(() => ride.camel >= 0 ? { c: ride.camel } : {});

// ---------- кадр (после updateCaravan и updateNet: переставляем верблюдов, которые не в цепочке) ----------
const _d = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(),
  _slot = new THREE.Vector3(), _ax = new THREE.Vector3(), _m = new THREE.Matrix4(), _prev = new THREE.Vector3();
let havePrev = false;

// поставить верблюда на землю в направлении dir лицом по fwd; ноги — по фактической скорости
function placeCamel(c, dir, fwd, speed, dt) {
  _u.copy(dir).negate();
  _f.copy(fwd).addScaledVector(_u, -fwd.dot(_u));
  if (_f.lengthSq() < 1e-8) _f.set(1, 0, 0).addScaledVector(_u, -_u.x);
  _f.normalize();
  _r.crossVectors(_u, _f);
  c.group.position.copy(dir).multiplyScalar(surfaceR(dir) - 0.03);
  c.group.quaternion.setFromRotationMatrix(_m.makeBasis(_r, _u, _f));
  const st = stateOf(c), moving = speed > 0.3;
  st.ph += dt * (moving ? (2.0 + Math.min(speed, 30) * 0.9) * c.gait : 0.6);
  const amp = moving ? 0.42 : 0.03;
  c.legs.forEach((leg, k) => { leg.rotation.x = Math.sin(st.ph + c.legPhase[k]) * amp; });
  c.neck.rotation.x = Math.sin(st.ph * 0.5) * 0.1 - 0.05;
  c.head.rotation.x = Math.sin(st.ph * 0.5 + 1.3) * 0.18;
  c.body.position.y = 1.5 + Math.abs(Math.sin(st.ph)) * 0.04;
}

export function updateRide(dt) {
  const camels = caravan.camels;
  if (!camels.length || dt <= 0) return;
  const now = clock.elapsedTime;
  _d.copy(player.pos).normalize();
  ride.hint = '';

  // приручение: ближайший свободный верблюд цепочки в радиусе NEAR
  if (ride.camel < 0 && !player.inside) {
    const distTo = c => _slot.copy(c.group.position).normalize().angleTo(_d) * P.R;
    let best = -1, bestD = NEAR;
    // уже приручаемый верблюд держится, пока он в радиусе — иначе в плотной цепочке цель прыгала бы к соседу
    const cur = ride.target >= 0 ? camels[ride.target] : null;
    if (cur && !stateOf(cur).away && distTo(cur) < NEAR) best = ride.target;
    else camels.forEach((c, i) => {
      if (stateOf(c).away) return;
      const dist = distTo(c);
      if (dist < bestD) { bestD = dist; best = i; }
    });
    if (best >= 0) {
      if (ride.target !== best) { ride.target = best; ride.progress = 0; }
      ride.progress += dt;
      if (ride.progress >= P.TAME_T) mount(best);
      else ride.hint = `Верблюд №${best + 1} привыкает к вам… идите рядом`;
    } else if (ride.target >= 0) {
      ride.progress -= dt * 3;
      if (ride.progress <= 0) { ride.progress = 0; ride.target = -1; }
    }
  }

  // свой верблюд — под ногами, смотрит куда мы. Убитый — седок на земле, труп остаётся где был.
  if (ride.camel >= 0) {
    if (stateOf(camels[ride.camel]).away === 'dead') noteCamelDead(ride.camel);
    else {
      const speed = havePrev ? Math.min(_prev.distanceTo(player.pos) / dt, 60) : 0;
      placeCamel(camels[ride.camel], _d, player.forward, speed, dt);
      ride.hint = `На верблюде №${ride.camel + 1}  ·  E — слезть`;
    }
  }
  _prev.copy(player.pos); havePrev = true;

  // чужие седоки: верблюд под их аватаром
  for (const r of net.remotes.values()) {
    const ci = r.last && r.last.c;
    if (!Number.isInteger(ci) || !r.pos || !camels[ci]) continue;
    const c = camels[ci], st = stateOf(c);
    if (st.away === 'dead') continue;
    if (st.rider !== r.id) claimed(ci, r.id);
    if (st.rider !== r.id) continue;                    // конфликт решился в нашу пользу
    st.seen = now;
    _slot.copy(r.pos).normalize();
    const speed = st.prev ? Math.min(st.prev.distanceTo(r.pos) / dt, 60) : 0;
    (st.prev || (st.prev = new THREE.Vector3())).copy(r.pos);
    placeCamel(c, _slot, r.fwd, speed, dt);
  }

  camels.forEach((c, i) => {
    const st = stateOf(c);
    // седок пропал (вышел из комнаты) — верблюд идёт домой
    if (st.away === 'ride' && st.rider !== ME.id && now - st.seen > 6) {
      st.rider = null; st.away = 'back'; st.dir.copy(c.group.position).normalize(); st.prev = null;
    }
    if (st.away !== 'back') return;
    // возвращение: по дуге большого круга к своему месту в цепочке
    camelSlotDir(i, _slot);
    const ang = st.dir.angleTo(_slot), step = (P.SPEED + RETURN_EXTRA) * dt / P.R;
    if (ang <= step + 1e-6) { st.away = null; st.prev = null; return; }   // дошёл — дальше его ведёт updateCaravan
    _ax.crossVectors(st.dir, _slot).normalize();
    st.dir.applyAxisAngle(_ax, step).normalize();
    _f.copy(_slot).addScaledVector(st.dir, -st.dir.dot(_slot));
    placeCamel(c, st.dir, _f, P.SPEED + RETURN_EXTRA, dt);
  });
}
