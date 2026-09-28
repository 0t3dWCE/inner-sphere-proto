// Туман войны и дымка.
// Видим только "пузырь" радиусом FOW_R·R (по дуге сферы) вокруг игрока. Всё, что дальше, тонет в тумане.
// Пройденные места запоминаются в карте разведки (equirect-текстура) и остаются видны приглушённо —
// туман рассеивается там, где ты ходил. Край пузыря шевелится шумом, чтобы не выглядел как циркуль.
import * as THREE from 'three';
import { P } from './params.js';
import { player } from './state.js';
import { scene } from './scene.js';

export const SKY_COLOR = new THREE.Color(0xa8bccd);   // ≈ средний тон неба-сферы, чтобы дымка сливалась с ним
export const FOW_COLOR = new THREE.Color(0x141923);
const EX_W = 512, EX_H = 256;
const exploredData = new Uint8Array(EX_W * EX_H);
const exploredTex = new THREE.DataTexture(exploredData, EX_W, EX_H, THREE.RedFormat, THREE.UnsignedByteType);
exploredTex.wrapS = THREE.RepeatWrapping;
exploredTex.minFilter = exploredTex.magFilter = THREE.LinearFilter;
exploredTex.needsUpdate = true;

// общие униформы всех материалов мира (и неба); uPlayerDir — направление на игрока, его читают и другие модули
export const fowUniforms = {
  uPlayerDir: { value: new THREE.Vector3(1, 0, 0) },
  uFowR:      { value: 1 },        // радиус видимости по дуге, в метрах
  uWorldR:    { value: 1 },
  uMemory:    { value: 0.35 },
  uFowOn:     { value: 1 },
  uTime:      { value: 0 },
  uFowColor:  { value: FOW_COLOR },
  uExplored:  { value: exploredTex },
};

export const FOW_FRAG_PRELUDE = /* glsl */`
  uniform vec3 uPlayerDir; uniform float uFowR; uniform float uWorldR; uniform float uMemory;
  uniform float uFowOn; uniform float uTime; uniform vec3 uFowColor; uniform sampler2D uExplored;
  varying vec3 vFowWorldPos;
  float fowHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float fowNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(fowHash(i), fowHash(i + vec3(1,0,0)), f.x), mix(fowHash(i + vec3(0,1,0)), fowHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(fowHash(i + vec3(0,0,1)), fowHash(i + vec3(1,0,1)), f.x), mix(fowHash(i + vec3(0,1,1)), fowHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
`;
export const FOW_FRAG_MAIN = /* glsl */`
  if (uFowOn > 0.5) {
    vec3 dir = normalize(vFowWorldPos);
    float arc = acos(clamp(dot(dir, uPlayerDir), -1.0, 1.0)) * uWorldR;
    // живой край: два слоя шума, медленно плывущих по времени
    float n = fowNoise(dir * 9.0 + vec3(0.0, uTime * 0.15, 0.0)) * 0.7
            + fowNoise(dir * 27.0 - vec3(uTime * 0.3, 0.0, 0.0)) * 0.3 - 0.5;
    float edge = uFowR * (1.0 + n * 0.3);
    float vis = 1.0 - smoothstep(edge * 0.65, edge, arc);
    vec2 euv = vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5, asin(clamp(dir.y, -1.0, 1.0)) / 3.1415927 + 0.5);
    float explored = texture2D(uExplored, euv).r;
    // разведанное — приглушённое и полуобесцвеченное, как воспоминание
    float luma = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
    vec3 remembered = mix(uFowColor, mix(gl_FragColor.rgb, vec3(luma), 0.6), uMemory * explored);
    gl_FragColor.rgb = mix(remembered, gl_FragColor.rgb, vis);
  }
`;
// подмешиваем туман войны в любой стандартный материал three.js
// extra(shader) — дополнительная правка шейдера (например, раскраска земли по биомам)
export function fogify(mat, extra) {
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, fowUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFowWorldPos;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 fowWP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          fowWP = instanceMatrix * fowWP;
        #endif
        vFowWorldPos = (modelMatrix * fowWP).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FOW_FRAG_PRELUDE)
      .replace('#include <fog_fragment>', '#include <fog_fragment>\n' + FOW_FRAG_MAIN);
    if (extra) extra(shader);
  };
  mat.customProgramCacheKey = () => 'fow' + (extra ? '+' + extra.name : '');
  return mat;
}

// отметить на карте разведки круг радиусом angR (радиан) вокруг направления dir
function stampExplored(dir, angR) {
  const lat0 = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  const lon0 = Math.atan2(dir.z, dir.x);
  const cosOuter = Math.cos(angR), cosInner = Math.cos(angR * 0.75);
  const yMin = Math.max(0, Math.floor(((lat0 - angR) / Math.PI + 0.5) * EX_H));
  const yMax = Math.min(EX_H - 1, Math.ceil(((lat0 + angR) / Math.PI + 0.5) * EX_H));
  for (let y = yMin; y <= yMax; y++) {
    const lat = ((y + 0.5) / EX_H - 0.5) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    const dlon = cl > 1e-3 ? Math.min(Math.PI, angR / cl * 1.1) : Math.PI;   // у полюсов — вся строка
    const xc = Math.round((lon0 / (2 * Math.PI) + 0.5) * EX_W);
    const dx = Math.ceil(dlon / (2 * Math.PI) * EX_W);
    for (let k = -dx; k <= dx; k++) {
      const x = ((xc + k) % EX_W + EX_W) % EX_W;
      const lon = ((x + 0.5) / EX_W - 0.5) * 2 * Math.PI;
      const d = cl * Math.cos(lon) * dir.x + sl * dir.y + cl * Math.sin(lon) * dir.z;
      if (d <= cosOuter) continue;
      const v = d >= cosInner ? 255 : Math.round(255 * (d - cosOuter) / (cosInner - cosOuter));
      const idx = y * EX_W + x;
      if (v > exploredData[idx]) exploredData[idx] = v;
    }
  }
  exploredTex.needsUpdate = true;
}
export function clearExplored() { exploredData.fill(0); exploredTex.needsUpdate = true; lastStampDir.set(0, 0, 0); exploredPct = 0; }
// доля разведанной поверхности (с весом cos(lat), т.к. equirect растягивает полюса)
function exploredPercent() {
  let sum = 0, total = 0;
  for (let y = 0; y < EX_H; y++) {
    const w = Math.cos(((y + 0.5) / EX_H - 0.5) * Math.PI);
    let row = 0;
    for (let x = 0; x < EX_W; x++) row += exploredData[y * EX_W + x];
    sum += row * w; total += 255 * EX_W * w;
  }
  return 100 * sum / total;
}
const lastStampDir = new THREE.Vector3();
export let exploredPct = 0;   // живой экспорт: читает HUD
let pctFrame = 0;

// каждый кадр: униформы, цвет дымки, отметка разведанного, когда отошли достаточно далеко от прошлой отметки
export function updateFow(elapsed) {
  // дымка: линейный туман цвета неба — прячет дальнюю сторону шара и рисует горизонт
  scene.fog.near = P.HAZE * 0.3;
  scene.fog.far = P.HAZE;

  const fowOn = P.FOW > 0.5;
  fowUniforms.uFowOn.value = fowOn ? 1 : 0;
  fowUniforms.uFowR.value = P.FOW_R * P.R;
  fowUniforms.uWorldR.value = P.R;
  fowUniforms.uMemory.value = P.FOW_MEMORY;
  fowUniforms.uTime.value = elapsed;
  fowUniforms.uPlayerDir.value.copy(player.pos).normalize();
  scene.fog.color.copy(fowOn ? FOW_COLOR : SKY_COLOR);
  if (fowOn) {
    // FOW_R — доля радиуса, т.е. угловой радиус пузыря в радианах; карта разведки от R не зависит
    const moved = lastStampDir.lengthSq() === 0 || lastStampDir.angleTo(fowUniforms.uPlayerDir.value) > P.FOW_R * 0.12;
    if (moved) { stampExplored(fowUniforms.uPlayerDir.value, P.FOW_R); lastStampDir.copy(fowUniforms.uPlayerDir.value); }
    if (++pctFrame % 60 === 0) exploredPct = exploredPercent();
  }
  return fowOn;
}
