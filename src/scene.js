import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Scene element identifiers used elsewhere (refs, tooltips, debug overlays).
export const SCENE_IDS = Object.freeze({
  FLOOR: 'floor',
  SPHERE: 'metallicSphere',
  HIDDEN_CUBE: 'hiddenCube',
  PILLARS: 'pillars',
  GLASS: 'glassCube',
  LAMP: 'lampCube',
  TORUS: 'torusKnot',
  SIDE_MIRRORS: 'sideMirrors',
  DIR_LIGHT: 'sun',
});

// Camera defaults — chosen so:
//   1) the metallic sphere & accent objects are nicely framed,
//   2) the floor plane is seen at a moderately grazing angle so Fresnel
//      reflections are obvious from the very first frame,
//   3) the hidden red cube is OUT of frame, behind the camera in look space.
export const CAMERA_DEFAULTS = Object.freeze({
  position: new THREE.Vector3(5.0, 1.7, 6.5),
  target: new THREE.Vector3(0, 0.7, 0),
  fov: 48,
  near: 0.1,
  far: 100,
});

// Position the hidden cube comfortably behind the default camera.
export const HIDDEN_CUBE_POSITION = new THREE.Vector3(0, 0.8, 12);

// Camera placement used by the "Look at Hidden Cube" button — moves to the
// opposite side of the room so the hidden cube becomes visible.
export const HIDDEN_VIEW = Object.freeze({
  position: new THREE.Vector3(1.0, 1.5, -3.5),
  target: HIDDEN_CUBE_POSITION,
});

const PILLAR_POSITIONS = [
  [-3.6, -3.6],
  [3.6, -3.6],
  [-3.6, 3.6],
  [3.6, 3.6],
];
const SIDE_MIRROR_X = 6.4;
const SIDE_MIRROR_WIDTH = 9.2;
const SIDE_MIRROR_HEIGHT = 3.4;

export async function buildScene(renderer) {
  const scene = new THREE.Scene();

  // ───────────────────── Floor ─────────────────────
  // Polished dark surface — low default roughness so the studio HDR shows up
  // clearly even without grazing-angle Fresnel boost.
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x171514,
    metalness: 0.0,
    roughness: 0.18,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(28, 28), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = SCENE_IDS.FLOOR;
  // Layer 1 = "SSR-reflective". SSR's normal pass renders only these meshes.
  floor.layers.enable(1);
  scene.add(floor);

  // ───────────────────── Pillars ─────────────────────
  // Four marble-look cylinders at the corners of the "studio" — give planar
  // and SSR reflections vertical structural elements to draw with.
  const pillarMaterial = new THREE.MeshStandardMaterial({
    color: 0xd6cdb6,
    metalness: 0.0,
    roughness: 0.55,
  });
  const pillars = new THREE.Group();
  pillars.name = SCENE_IDS.PILLARS;
  for (const [x, z] of PILLAR_POSITIONS) {
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.32, 3.0, 24),
      pillarMaterial,
    );
    pillar.position.set(x, 1.5, z);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    pillars.add(pillar);
  }
  scene.add(pillars);

  // ───────────────────── Centerpiece sphere ─────────────────────
  // Highly polished gold metal — the obvious curved reflector. Kept at low
  // roughness regardless of the UI slider so it stays a clear reference.
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.0, 64, 64),
    new THREE.MeshStandardMaterial({
      color: 0xffd1a0,
      metalness: 1.0,
      roughness: 0.08,
    }),
  );
  sphere.position.set(0, 1.0, 0);
  sphere.castShadow = true;
  sphere.name = SCENE_IDS.SPHERE;
  sphere.layers.enable(1);
  scene.add(sphere);

  // ───────────────────── Glass cube ─────────────────────
  // Transmission + IOR — refraction visible in the glass; planar/SSR will
  // also show its silhouette in the floor reflection.
  const glassCube = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 1.0, 1.0),
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0.0,
      roughness: 0.05,
      transmission: 1.0,
      thickness: 0.6,
      ior: 1.5,
      attenuationColor: 0xe8eef8,
      attenuationDistance: 2.0,
    }),
  );
  glassCube.position.set(-2.2, 0.5, 1.6);
  glassCube.name = SCENE_IDS.GLASS;
  scene.add(glassCube);

  // ───────────────────── Emissive "lamp" ─────────────────────
  // Bright orange glowing cube. Important pedagogically: this object is part
  // of the scene, not the environment map, so it WILL appear in planar/SSR
  // floor reflections but will NOT appear in cubemap reflections — driving
  // home the "no nearby objects" limitation of cubemap.
  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xff7a33,
      emissiveIntensity: 5.5,
    }),
  );
  lamp.position.set(1.7, 0.5, 1.9);
  lamp.name = SCENE_IDS.LAMP;
  scene.add(lamp);

  // Real point light at the lamp position so it actually illuminates the
  // scene with warm bounce — sells the lamp as an actual light source.
  const lampLight = new THREE.PointLight(0xff8a44, 35, 9, 1.7);
  lampLight.position.copy(lamp.position).y += 0.6;
  scene.add(lampLight);

  // ───────────────────── Copper torus knot ─────────────────────
  const torus = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.45, 0.15, 128, 24),
    new THREE.MeshStandardMaterial({
      color: 0xb87333,
      metalness: 1.0,
      roughness: 0.22,
    }),
  );
  torus.position.set(-1.9, 1.05, -2.1);
  torus.castShadow = true;
  torus.name = SCENE_IDS.TORUS;
  torus.layers.enable(1);
  scene.add(torus);

  // ───────────────────── Color cubes ─────────────────────
  const blueCube = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 1.0, 1.0),
    new THREE.MeshStandardMaterial({
      color: 0x2a4d8f,
      metalness: 0.0,
      roughness: 0.4,
    }),
  );
  blueCube.position.set(2.0, 0.5, -1.6);
  blueCube.castShadow = true;
  scene.add(blueCube);

  const tealCube = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshStandardMaterial({
      color: 0x2a8f8a,
      metalness: 0.5,
      roughness: 0.3,
    }),
  );
  tealCube.position.set(2.8, 0.35, 0.7);
  tealCube.castShadow = true;
  scene.add(tealCube);

  // ───────────────────── Hidden red cube ─────────────────────
  // The star of the SSR demonstration — sits behind the default camera so
  // it's literally not on screen. SSR can't reflect what's not on screen;
  // cubemap can't either (it's a scene object); planar can.
  const hiddenCube = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 1.2, 1.0),
    new THREE.MeshStandardMaterial({
      color: 0xff2530,
      metalness: 0.0,
      roughness: 0.45,
      emissive: 0x220000,
    }),
  );
  hiddenCube.position.copy(HIDDEN_CUBE_POSITION);
  hiddenCube.castShadow = true;
  hiddenCube.name = SCENE_IDS.HIDDEN_CUBE;
  scene.add(hiddenCube);

  // ───────────────────── Optional side mirrors ─────────────────────
  // These are the non-planar representation of the side mirror toggle. In
  // Cubemap/SSR modes they are normal reflective meshes, so each technique
  // handles them through its own reflection model. Planar mode hides this
  // group and swaps in true Reflector-backed side mirrors instead.
  const sideMirrorMaterial = new THREE.MeshStandardMaterial({
    color: 0x1d232b,
    metalness: 1.0,
    roughness: 0.12,
    envMapIntensity: 1.35,
  });
  const sideMirrorGeometry = new THREE.PlaneGeometry(SIDE_MIRROR_WIDTH, SIDE_MIRROR_HEIGHT);
  const sideMirrors = new THREE.Group();
  sideMirrors.name = SCENE_IDS.SIDE_MIRRORS;
  sideMirrors.visible = false;
  sideMirrors.layers.enable(1);

  const leftMirror = new THREE.Mesh(sideMirrorGeometry, sideMirrorMaterial);
  leftMirror.name = 'leftSideMirror';
  leftMirror.position.set(-SIDE_MIRROR_X, SIDE_MIRROR_HEIGHT * 0.5, 0);
  leftMirror.rotation.y = Math.PI / 2;
  leftMirror.receiveShadow = true;
  leftMirror.layers.enable(1);
  sideMirrors.add(leftMirror);

  const rightMirror = new THREE.Mesh(sideMirrorGeometry, sideMirrorMaterial);
  rightMirror.name = 'rightSideMirror';
  rightMirror.position.set(SIDE_MIRROR_X, SIDE_MIRROR_HEIGHT * 0.5, 0);
  rightMirror.rotation.y = -Math.PI / 2;
  rightMirror.receiveShadow = true;
  rightMirror.layers.enable(1);
  sideMirrors.add(rightMirror);
  scene.add(sideMirrors);

  // ───────────────────── Lights ─────────────────────
  // Sun: warm directional key light. Gives crisp shadows on top of IBL.
  const sun = new THREE.DirectionalLight(0xfff4dc, 2.2);
  sun.position.set(6, 9, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 30;
  sun.shadow.camera.left = -10;
  sun.shadow.camera.right = 10;
  sun.shadow.camera.top = 10;
  sun.shadow.camera.bottom = -10;
  sun.shadow.bias = -0.0005;
  sun.name = SCENE_IDS.DIR_LIGHT;
  scene.add(sun);

  // Cool fill light from the other side — gives shadows a colored tint.
  const coolFill = new THREE.PointLight(0x6090ff, 18, 14, 1.6);
  coolFill.position.set(-4.5, 3.0, -3.5);
  scene.add(coolFill);

  // ───────────────────── Environment / IBL ─────────────────────
  const environment = await loadEnvironment(renderer);
  scene.environment = environment.texture;
  scene.background = environment.background;
  scene.backgroundIntensity = 0.85; // tone the sky a touch so objects pop
  scene.backgroundBlurriness = 0.0;

  // ───────────────────── Animation hook ─────────────────────
  // Subtle motion per frame. The cubemap can't see scene objects, so it
  // doesn't reflect any of these. Planar/SSR will — that's the contrast.
  const lampBaseY = lamp.position.y;
  function animate(elapsed) {
    sphere.rotation.y = elapsed * 0.15;
    torus.rotation.y = elapsed * 0.45;
    torus.rotation.x = elapsed * 0.28;
    lamp.position.y = lampBaseY + Math.sin(elapsed * 1.3) * 0.18;
    lamp.rotation.y = elapsed * 0.6;
    lampLight.position.y = lamp.position.y + 0.6;
  }

  return {
    scene,
    refs: {
      floor,
      floorMaterial,
      sphere,
      hiddenCube,
      pillars,
      glassCube,
      lamp,
      torus,
      sideMirrors,
      sun,
    },
    environment,
    animate,
  };
}

// ─────────────────────────────────────────────────────────────────
// Environment loader — prefers a real HDR in assets/env/, falls back
// to a procedural RoomEnvironment if none is bundled.
// ─────────────────────────────────────────────────────────────────

async function loadEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const candidates = [
    './assets/env/studio.hdr',
    './assets/env/environment.hdr',
  ];

  for (const url of candidates) {
    try {
      const hdr = await loadHDR(url);
      const envMap = pmrem.fromEquirectangular(hdr).texture;
      pmrem.dispose();
      // Use the unfiltered HDR for the visible sky (sharper) and the PMREM
      // result for IBL (pre-filtered for split-sum specular).
      return { texture: envMap, background: hdr, source: url };
    } catch {
      // try next
    }
  }

  // Procedural fallback so the demo runs offline / out of the box.
  const roomEnv = new RoomEnvironment();
  const envMap = pmrem.fromScene(roomEnv, 0.04).texture;
  pmrem.dispose();
  const bg = makeGradientTexture();
  return { texture: envMap, background: bg, source: 'procedural' };
}

function loadHDR(url) {
  return new Promise((resolve, reject) => {
    new RGBELoader().load(
      url,
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        resolve(tex);
      },
      undefined,
      (err) => reject(err),
    );
  });
}

function makeGradientTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0.0, '#1a232e');
  grad.addColorStop(0.5, '#0e141b');
  grad.addColorStop(1.0, '#05080c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
