// Рендерер, сцена, камера, свет. Всё, что нужно любому модулю, который что-то добавляет в мир.
import * as THREE from 'three';

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9c7e0);
// лёгкий туман: далёкая стенка (потолок) мягко тает, но горизонт, уходящий вверх, остаётся видимым
scene.fog = new THREE.Fog(0xa9c7e0, 1, 2);

export const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 100);

// ---------- свет ----------
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
export const sun = new THREE.PointLight(0xfff2d8, 1, 0, 2); // "солнце" в центре сферы
scene.add(sun);
export const sunBall = new THREE.Mesh(
  new THREE.SphereGeometry(2.5, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0xfff1b0, fog: false })
);
scene.add(sunBall);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
