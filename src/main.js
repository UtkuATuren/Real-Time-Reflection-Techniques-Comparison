import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { buildScene, CAMERA_DEFAULTS, HIDDEN_VIEW } from './scene.js';
import { bindUI, setPerf, setSSRTime, hideLoadingOverlay } from './ui.js';
import { PerfTracker } from './stats.js';
import { CubemapMode } from './reflections/cubemap.js';
import { PlanarMode } from './reflections/planar.js';
import { SSRMode } from './reflections/ssr/SSRPass.js';

const SSR_MODE_NAMES = new Set(['ssr', 'ssrFallback']);

// ---------- Renderer ----------
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ---------- Camera ----------
const camera = new THREE.PerspectiveCamera(
  CAMERA_DEFAULTS.fov,
  1,
  CAMERA_DEFAULTS.near,
  CAMERA_DEFAULTS.far,
);
camera.position.copy(CAMERA_DEFAULTS.position);
camera.lookAt(CAMERA_DEFAULTS.target);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(CAMERA_DEFAULTS.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2.0;
controls.maxDistance = 16.0;
controls.maxPolarAngle = Math.PI * 0.49;
controls.update();

// ---------- Sizing ----------
function resize() {
  const viewport = canvas.parentElement;
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  for (const mode of Object.values(modes ?? {})) {
    mode.resize?.(w, h);
  }
}
window.addEventListener('resize', resize);

// ---------- Scene + Modes ----------
let modes = null;
let currentMode = null;
let sceneRefs = null;
let animateScene = null;
let offscreenIndicatorEnabled = false;
let extraReflectorsEnabled = false;

(async function init() {
  const built = await buildScene(renderer);
  const scene = built.scene;
  sceneRefs = built.refs;
  animateScene = built.animate;

  modes = {
    cubemap: new CubemapMode({ renderer, scene, camera }),
    planar: new PlanarMode({ renderer, scene, camera, refs: sceneRefs }),
    ssr: new SSRMode({ renderer, scene, camera, environment: built.environment, refs: sceneRefs }),
    ssrFallback: new SSRMode({ renderer, scene, camera, environment: built.environment, refs: sceneRefs, withFallback: true }),
  };

  // Flush current UI state into modes (the slider fired before modes existed).
  const initialRoughness = parseFloat(document.getElementById('roughness').value);
  if (sceneRefs?.floorMaterial) sceneRefs.floorMaterial.roughness = initialRoughness;
  for (const mode of Object.values(modes)) mode.setRoughness?.(initialRoughness);

  switchMode('cubemap');
  applyExtraReflectors();
  resize();
  hideLoadingOverlay();
  startLoop();
})().catch((err) => {
  console.error('Failed to initialize scene:', err);
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.querySelector('.loading-overlay__text').textContent =
      'Failed to load scene. See console.';
  }
});

function switchMode(name) {
  if (!modes[name]) return;
  if (currentMode === modes[name]) return;
  currentMode?.dispose?.();
  currentMode = modes[name];
  currentMode.activate?.();
  applyExtraReflectors();
  // SSR timing only applies in SSR modes; reset readout otherwise.
  if (SSR_MODE_NAMES.has(name)) {
    setSSRTime(0);
  } else {
    setSSRTime(null);
  }
}

// ---------- Render loop ----------
const perf = new PerfTracker();
perf.onUpdate(setPerf);

const clock = new THREE.Clock();

function startLoop() {
  function tick() {
    perf.begin();
    const elapsed = clock.getElapsedTime();
    animateScene?.(elapsed);
    controls.update();
    currentMode?.render();
    if (currentMode && SSR_MODE_NAMES.has(currentMode.name)) {
      setSSRTime(currentMode.lastFrameMs ?? 0);
    }
    updateOffscreenIndicator();
    perf.end();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---------- UI bindings ----------
bindUI({
  onModeChange: (name) => switchMode(name),
  onRoughnessChange: (value) => {
    if (sceneRefs?.floorMaterial) sceneRefs.floorMaterial.roughness = value;
    // Modes (notably planar) can map roughness onto their own internal state
    // such as blur radius, cone-tracing mip bias, etc.
    for (const mode of Object.values(modes ?? {})) {
      mode.setRoughness?.(value);
    }
  },
  onExtraReflectorsChange: (enabled) => {
    extraReflectorsEnabled = enabled;
    applyExtraReflectors();
  },
  onCameraReset: () => {
    camera.position.copy(CAMERA_DEFAULTS.position);
    controls.target.copy(CAMERA_DEFAULTS.target);
    controls.update();
  },
  onLookAtHidden: () => {
    // Pivot the camera to the opposite side of the studio so the hidden red
    // cube enters the frame. In SSR mode this re-introduces the cube as
    // on-screen content, finally letting it appear in reflections.
    camera.position.copy(HIDDEN_VIEW.position);
    controls.target.copy(HIDDEN_VIEW.target);
    controls.update();
  },
  onDebugToggle: (kind, enabled) => {
    if (kind === 'offscreen') {
      offscreenIndicatorEnabled = enabled;
      updateOffscreenIndicator();
      return;
    }

    // SSR mode wires these to its G-buffer / ray-hit visualizers:
    //   depth → show depth buffer
    //   hits  → show SSR hit/miss mask
    for (const mode of Object.values(modes ?? {})) {
      mode.setDebug?.(kind, enabled);
    }
  },
});

function applyExtraReflectors() {
  for (const mode of Object.values(modes ?? {})) {
    mode.setExtraReflectors?.(extraReflectorsEnabled);
  }

  if (sceneRefs?.sideMirrors) {
    sceneRefs.sideMirrors.visible = extraReflectorsEnabled && currentMode?.name !== 'planar';
  }
}

function updateOffscreenIndicator() {
  const indicator = document.getElementById('offscreenIndicator');
  const hiddenCube = sceneRefs?.hiddenCube;
  if (!indicator || !hiddenCube || !offscreenIndicatorEnabled) {
    if (indicator) indicator.hidden = true;
    return;
  }

  const viewport = canvas.parentElement;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (width <= 0 || height <= 0) {
    indicator.hidden = true;
    return;
  }

  const worldPos = new THREE.Vector3();
  hiddenCube.getWorldPosition(worldPos);

  const viewPos = worldPos.clone().applyMatrix4(camera.matrixWorldInverse);
  const projected = worldPos.clone().project(camera);
  const inFront = viewPos.z < 0;
  const onscreen = inFront
    && projected.x >= -1
    && projected.x <= 1
    && projected.y >= -1
    && projected.y <= 1
    && projected.z >= -1
    && projected.z <= 1;

  if (onscreen) {
    indicator.hidden = true;
    return;
  }

  indicator.hidden = false;
  const halfWidth = Math.max(indicator.offsetWidth * 0.5, 40);
  const halfHeight = Math.max(indicator.offsetHeight * 0.5, 14);
  const marginX = halfWidth + 8;
  const marginY = halfHeight + 8;

  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const toTarget = worldPos.sub(camera.position).normalize();
  const dirX = toTarget.dot(right);
  const dirY = toTarget.dot(up);

  const centerX = width * 0.5;
  const centerY = height * 0.5;
  const length = Math.max(Math.abs(dirX), Math.abs(dirY), 0.0001);
  const edgeX = centerX + (dirX / length) * (centerX - marginX);
  const edgeY = centerY - (dirY / length) * (centerY - marginY);
  const x = Math.max(marginX, Math.min(width - marginX, edgeX));
  const y = Math.max(marginY, Math.min(height - marginY, edgeY));
  const angle = Math.atan2(dirY, dirX) * 180 / Math.PI + 90;

  indicator.style.left = `${x}px`;
  indicator.style.top = `${y}px`;
  indicator.style.setProperty('--indicator-angle', `${angle}deg`);
}
