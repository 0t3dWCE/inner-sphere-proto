// Точка входа: порядок сборки мира и главный цикл. Кто за что отвечает — в ARCHITECTURE.md.
//
// Импорты — одновременно и порядок инициализации модулей (у некоторых есть побочные эффекты на верхнем уровне:
// рендерер, меши сферы/воды/неба, подписки на сеть). Всё, что тратит rand() мира, вынесено в явные шаги ниже —
// их порядок менять нельзя, иначе у комнаты с тем же seed получится другой мир.
import { clock, player } from './state.js';
import './params.js';
import { renderer, scene, camera } from './scene.js';
import { updateFow } from './fow.js';
import './world.js';                                       // townDir — первый rand()
import { paintBiomes, applyRadius } from './terrain.js';
import { updateSky } from './sky.js';
import { buildProps } from './props.js';
import { buildForest } from './forest.js';
import { buildTown } from './town.js';
import { updatePlayer } from './player.js';
import { houseScene, updateHouse } from './house.js';
import { loadPlaques, updateMessages } from './messages.js';
import { buildBow, updateBow } from './bow.js';
import { buildCaravan, updateCaravan } from './caravan.js';
import { updateAmbience } from './ambience.js';
import { updateSteps } from './steps.js';
import { netStart, updateNet } from './net.js';
import { updateRide } from './ride.js';
import { updateMonster } from './monster.js';
import { updateHealth } from './health.js';
import { updateVoice } from './voice.js';
import './roomsync.js';
import { updateHud } from './ui.js';
import { installDebug } from './debug.js';

// ---------- сборка мира (порядок = порядок rand()) ----------
paintBiomes();      // карта биомов (без rand)
buildForest();      // ёлки
buildProps();       // цветные коробки и маяки
buildTown();        // дома, стена, ворота
applyRadius();      // геометрия стенки/воды под текущие R и TERRAIN_H, расстановка всего на поверхности
buildCaravan();     // верблюды и погонщики
buildBow();         // лук в лесу (свой RNG, rand() мира не тратит; нужны ёлки — после buildForest)
loadPlaques();      // таблички комнаты из localStorage
netStart();         // PeerJS: занять слот, соединиться с остальными
installDebug();     // window.dbg при ?debug

// ---------- главный цикл ----------
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);

  updatePlayer(dt);       // ввод, ходьба, коллизии, биом под ногами, прыжок, рельеф, камера (внутри дома — контроллер house.js)
  updateHouse();          // подсказка «пробел — войти/выйти» у дверей и балконов
  updateMessages(dt);     // полёт шаров, приземление в таблички, поворот табличек к игроку
  updateBow(dt);          // лук в лесу (подобрать), полёт стрел по дуге, втыкание в землю
  updateCaravan();        // догнать мировое время, расставить верблюдов/погонщиков, анимация, звук
  updateAmbience();       // лес/город: громкость шин, планирование птиц, музыки, кухни
  updateSteps(dt);        // звук шагов по пройденному пути и покрытию под ногами (снаружи и в доме)
  updateNet(dt);          // своя позиция ~12 Гц, интерполяция чужих аватаров
  updateRide(dt);         // приручение, свой верблюд под ногами, чужие седоки, возвращение отпущенных (после каравана и сети)
  updateVoice(dt);        // голоса: панорама у рта собеседника (после сети — аватары на местах), значок «говорит»
  updateMonster(dt);      // медведракон и скорпионы: симуляция у хозяина + снимок в сеть, копии у всех, укусы, скелеты
  updateHealth(dt);       // HP игрока: лечение, смерть и возрождение, красная вспышка, полоска
  updateSky();            // радиус и облачность неба
  const fowOn = updateFow(clock.elapsedTime);   // дымка, униформы тумана войны, карта разведки
  updateHud(fowOn);

  renderer.render(player.inside ? houseScene : scene, camera);   // внутри дома — отдельная сцена интерьера
  requestAnimationFrame(tick);
}
tick();
