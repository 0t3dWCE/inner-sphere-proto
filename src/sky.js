// Небо: внутренняя сфера-атмосфера.
// Концентрическая сфера радиусом R - SKY_H, смотрим на неё снаружи (FrontSide) — это зенит и облака.
// Сама по себе горизонт она не даёт: при R=80 и зазоре 30 м она видна лишь выше ~50° над горизонтом,
// а дальняя стенка остаётся видна ниже. Горизонт делает дымка (scene.fog цвета неба, дальность HAZE):
// стенка дальше HAZE растворяется в цвете неба, и небо-сфера тонет в той же дымке, чтобы её край не
// читался как круг. Облака — fbm-шум по направлению, медленно дрейфуют; солнечное пятно и засветка.
// Туман войны применяется и к небу (общие fowUniforms), иначе яркий шар висит над чёрной землёй.
import * as THREE from 'three';
import { P } from './params.js';
import { scene } from './scene.js';
import { fowUniforms, FOW_FRAG_PRELUDE, FOW_FRAG_MAIN } from './fow.js';

const skyUniforms = {
  uSky:       { value: new THREE.Color(0x9cb4cc) },
  uSkyLow:    { value: new THREE.Color(0xb2c2d0) },
  uCloud:     { value: new THREE.Color(0xf5f7f9) },
  uCloudDark: { value: new THREE.Color(0x9aa4ae) },
  uCoverage:  { value: 0.5 },
  uSunDir:    { value: new THREE.Vector3(0.35, 0.8, 0.49).normalize() },
};
// fog: true — небо тонет в той же дымке, что и стенка, поэтому его край не читается как круг
const skyMat = new THREE.ShaderMaterial({
  // merge() клонирует, а fowUniforms нужны общими — подмешиваем их после
  uniforms: Object.assign(THREE.UniformsUtils.merge([THREE.UniformsLib.fog, skyUniforms]), fowUniforms),
  fog: true,
  vertexShader: /* glsl */`
    #include <fog_pars_vertex>
    varying vec3 vDir; varying vec3 vFowWorldPos;
    void main() {
      vDir = position;
      vFowWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `,
  fragmentShader: /* glsl */`
    #include <fog_pars_fragment>
    ${FOW_FRAG_PRELUDE}
    uniform vec3 uSky, uSkyLow, uCloud, uCloudDark, uSunDir; uniform float uCoverage;
    varying vec3 vDir;
    float hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float noise(vec3 x) {
      vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec3(7.1, 3.3, 1.7); a *= 0.5; }
      return v;
    }
    void main() {
      vec3 d = normalize(vDir);
      float t = uTime * 0.012;
      // два слоя облаков на разных высотах/скоростях
      float n1 = fbm(d * 3.2 + vec3(t * 2.0, 0.0, t));
      float n2 = fbm(d * 7.0 - vec3(t * 3.5, t * 0.7, 0.0));
      // fbm даёт узкий разброс (~0.35..0.65) — растягиваем, иначе облака едва проступают
      float n = (n1 * 0.7 + n2 * 0.3 - 0.48) * 2.4 + 0.5;
      float th = mix(0.95, 0.30, uCoverage);
      float cov = smoothstep(th, th + 0.14, n);
      float thick = smoothstep(th + 0.12, th + 0.45, n);
      vec3 cloud = mix(uCloud, uCloudDark, thick * 0.65);
      // фон: лёгкая пятнистость, чтобы небо не было плоской заливкой
      vec3 sky = mix(uSkyLow, uSky, smoothstep(0.3, 0.7, n1));
      vec3 col = mix(sky, cloud, cov);
      // солнце: диск + ореол + общая засветка со стороны солнца
      float s = dot(d, uSunDir);
      col *= 0.95 + 0.1 * max(s, 0.0);
      col += vec3(1.0, 0.96, 0.85) * (smoothstep(0.9965, 0.9992, s) * 0.9 + pow(max(s, 0.0), 40.0) * 0.3) * (1.0 - cov * 0.8);
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
      #include <fog_fragment>
      ${FOW_FRAG_MAIN}
    }
  `,
  side: THREE.FrontSide,
});
const skyU = skyMat.uniforms;   // merge() клонирует униформы — обновлять надо эти
export const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), skyMat);
scene.add(sky);

// каждый кадр: радиус R - SKY_H (но не ближе 3 м к глазам), облачность; дрейф — через общий uTime тумана войны
export function updateSky() {
  const skyR = P.R - Math.min(P.SKY_H, P.R - P.EYE - 3);
  sky.visible = P.SKY_H > 0;
  sky.scale.setScalar(skyR);
  skyU.uCoverage.value = P.SKY_CLOUDS;   // uTime — общий с туманом войны (fowUniforms)
}
