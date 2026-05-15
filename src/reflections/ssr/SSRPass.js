// SSR mode (Phase 5) — McGuire & Mara 2014 in screen space.
//
// Per frame:
//   1. Render the scene normally to colorTarget (with attached depth texture
//      and mipmap generation enabled for cone tracing). This beauty pass keeps
//      the regular PBR/cubemap base, just like Three.js's reference SSRPass.
//      The SSR pass is an additional screen-space contribution, not a
//      replacement for all reflective lighting.
//   2. Render the scene again with scene.overrideMaterial = normalMaterial
//      AND camera.layers restricted to layer 1, producing a normal-buffer
//      where ONLY the SSR-reflective meshes are written. Pixels not covered
//      remain at the cleared alpha=0 — the composite uses that as a "skip
//      SSR for this pixel" mask. (The earlier per-mesh roughness scheme
//      via onBeforeRender hooks didn't propagate uniforms reliably; layers
//      are simpler and bullet-proof.)
//   3. Restore camera layers.
//   4. Run the SSR composite shader as a fullscreen pass, ray-marching the
//      depth buffer for each reflective pixel and adding the result on top
//      of the colorTarget read.
//
// Two flavours of this mode exist:
//   - SSR (`withFallback = false`): reflections come exclusively from the
//     screen-space pass. Off-screen content is missing; that's the demo.
//   - SSR + Cubemap fallback (`withFallback = true`): when a ray misses or
//     fades out near the screen edge, the equirectangular HDR sky fills in.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { NORMAL_VERT, NORMAL_FRAG, SSR_VERT, SSR_FRAG } from './shaders.js';

const MAX_RAY_DISTANCE = 16.0;
const RAY_THICKNESS = 1.5;
const MAX_STEPS = 96;

// Reusable scratch color so saving the renderer's clear color in render()
// doesn't allocate per frame.
const _tmpColor = new THREE.Color();

export class SSRMode {
  constructor({ renderer, scene, camera, environment, refs, withFallback = false }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.environment = environment;
    this.refs = refs;
    this.withFallback = withFallback;
    this.name = withFallback ? 'ssrFallback' : 'ssr';
    this.roughness = 0.18;
    this.lastFrameMs = 0;

    this._build();
  }

  _build() {
    const { width, height } = this._getViewportSize();

    // ── G-buffer: color target with attached depth texture, mipmapped ──
    this.depthTexture = new THREE.DepthTexture(width, height);
    this.depthTexture.format = THREE.DepthFormat;
    this.depthTexture.type = THREE.UnsignedIntType;

    this.colorTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthTexture: this.depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.colorTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;

    // ── G-buffer: normal + roughness target ──
    this.normalRoughTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });

    // ── Override material for the normal pass ──
    this.normalMaterial = new THREE.ShaderMaterial({
      vertexShader: NORMAL_VERT,
      fragmentShader: NORMAL_FRAG,
    });

    // ── Composite shader (fullscreen, GLSL3) ──
    this.compositeMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tColor: { value: this.colorTarget.texture },
        tDepth: { value: this.depthTexture },
        tNormalRough: { value: this.normalRoughTarget.texture },
        tEnvBackground: { value: this.environment.background },
        uProjMatrix: { value: new THREE.Matrix4() },
        uInvProjMatrix: { value: new THREE.Matrix4() },
        uInvViewMatrix: { value: new THREE.Matrix4() },
        uResolution: { value: new THREE.Vector2(width, height) },
        uMaxDistance: { value: MAX_RAY_DISTANCE },
        uThickness: { value: RAY_THICKNESS },
        uMaxSteps: { value: MAX_STEPS },
        uUseFallback: { value: this.withFallback ? 1 : 0 },
        uIntensity: { value: 1.0 },
        uEnvExposure: { value: 1.0 },
        uRoughness: { value: 0.18 },
        uDebugMode: { value: 0 },
      },
      vertexShader: SSR_VERT,
      fragmentShader: SSR_FRAG,
    });
    this.fsQuad = new FullScreenQuad(this.compositeMaterial);
  }

  _getViewportSize() {
    const dpr = this.renderer.getPixelRatio();
    const canvas = this.renderer.domElement;
    return {
      width: Math.max(2, Math.floor(canvas.clientWidth * dpr)),
      height: Math.max(2, Math.floor(canvas.clientHeight * dpr)),
    };
  }

  resize() {
    const { width, height } = this._getViewportSize();
    this.colorTarget.setSize(width, height);
    this.normalRoughTarget.setSize(width, height);
    this.depthTexture.image = { width, height };
    this.depthTexture.needsUpdate = true;
    this.compositeMaterial.uniforms.uResolution.value.set(width, height);
  }

  setRoughness(value) {
    this.roughness = value;
    this.compositeMaterial.uniforms.uRoughness.value = value;
  }

  // Debug visualizations. Only one shader debug mode is active at a time.
  setDebug(kind, enabled) {
    if (kind === 'depth') {
      this.compositeMaterial.uniforms.uDebugMode.value = enabled ? 3 : 0;
    } else if (kind === 'hits') {
      this.compositeMaterial.uniforms.uDebugMode.value = enabled ? 2 : 0;
    }
  }

  activate() {
    this.compositeMaterial.uniforms.uRoughness.value = this.roughness;
    this.resize();
  }

  dispose() {
    // Resources are retained because the mode instances are reused after
    // switching; there is no per-activation teardown.
  }

  // ──────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────
  render() {
    const renderer = this.renderer;
    const startedAt = performance.now();

    // Pass 1: scene → colorTarget. Keep the normal PBR/cubemap base intact;
    // SSR is composited on top and SSR+fallback can strengthen misses.
    renderer.setRenderTarget(this.colorTarget);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    // Pass 2: scene with override material → normalRoughTarget. Restrict
    // the camera to layer 1 so ONLY SSR-reflective meshes render. Clear
    // the target with alpha=0 first so non-rendered pixels are masked off
    // for the composite shader.
    const previousOverride = this.scene.overrideMaterial;
    const previousLayerMask = this.camera.layers.mask;
    const previousClearColor = renderer.getClearColor(_tmpColor);
    const previousClearAlpha = renderer.getClearAlpha();

    this.scene.overrideMaterial = this.normalMaterial;
    this.camera.layers.set(1);
    renderer.setRenderTarget(this.normalRoughTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    this.camera.layers.mask = previousLayerMask;
    this.scene.overrideMaterial = previousOverride;
    renderer.setClearColor(previousClearColor, previousClearAlpha);

    // Pass 3: SSR composite to canvas.
    const u = this.compositeMaterial.uniforms;
    u.uProjMatrix.value.copy(this.camera.projectionMatrix);
    u.uInvProjMatrix.value.copy(this.camera.projectionMatrixInverse);
    u.uInvViewMatrix.value.copy(this.camera.matrixWorld);
    // The env background may have been swapped by the scene loader for a
    // gradient fallback — rebind in case.
    u.tEnvBackground.value = this.environment.background;

    renderer.setRenderTarget(null);
    renderer.clear();
    this.fsQuad.render(renderer);
    this.lastFrameMs = performance.now() - startedAt;
  }
}
