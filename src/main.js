// Точка входа: порядок сборки мира и главный цикл. Кто за что отвечает — в ARCHITECTURE.md.
//
// Импорты — одновременно и порядок инициализации модулей (у некоторых есть побочные эффекты на верхнем уровне:
// рендерер, меши сферы/воды/неба, подписки на сеть). Всё, что тратит rand() мира, вынесено в явные шаги ниже —
// их порядок менять нельзя, иначе у комнаты с тем же seed получится другой мир.
import { clock } from './state.js';
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
import { loadPlaques, updateMessages } from './messages.js';
import { buildCaravan, updateCaravan } from './caravan.js';
import { updateAmbience } from './ambience.js';
import { netStart, updateNet } from './net.js';
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
loadPlaques();      // таблички комнаты из localStorage
netStart();         // PeerJS: занять слот, соединиться с остальными
installDebug();     // window.dbg при ?debug

// ---------- главный цикл ----------
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);

  updatePlayer(dt);       // ввод, ходьба, коллизии, биом под ногами, прыжок, рельеф, камера
  updateMessages(dt);     // полёт шаров, приземление в таблички, поворот табличек к игроку
  updateCaravan();        // догнать мировое время, расставить верблюдов/погонщиков, анимация, звук
  updateAmbience();       // лес/город: громкость шин, планирование птиц, музыки, кухни
  updateNet(dt);          // своя позиция ~12 Гц, интерполяция чужих аватаров
  updateSky();            // радиус и облачность неба
  const fowOn = updateFow(clock.elapsedTime);   // дымка, униформы тумана войны, карта разведки
  updateHud(fowOn);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
