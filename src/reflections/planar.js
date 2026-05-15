// Planar reflection mode (Phase 4).
//
// Architecture: in planar mode the Reflector mesh REPLACES the original floor
// (we hide the floor for the duration). The Reflector renders the scene from
// a mirrored virtual camera into its own render target every frame; we then
// run a separable Gaussian blur (radius bound to the roughness slider) into
// half-res ping-pong targets, and the Reflector's material — which we swap
// for a custom shader — samples the *blurred* target and Fresnel-blends it
// against a base floor color.
//
// Output is fully opaque (mix(base, reflection, F)), so we don't depend on
// alpha-blend ordering, depth-write semantics, or any subtlety of Three.js's
// transparent pass — the reflection is always present and always visible.
//
// The metallic sphere is intentionally untouched: planar reflections only
// work on flat surfaces, so the sphere keeps its cubemap-based reflections.
// That visible mismatch (perfect floor / static sphere) is the pedagogical
// point of this mode.

import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const FLOOR_SIZE = 28;
const SIDE_MIRROR_X = 6.4;
const SIDE_MIRROR_WIDTH = 9.2;
const SIDE_MIRROR_HEIGHT = 3.4;
const MAX_BLUR_RADIUS_PX = 18.0;

const BLUR_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Separable Gaussian. Sigma scales with radius so wider blurs stay smooth.
const BLUR_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tInput;
  uniform vec2 uTexelSize;
  uniform vec2 uDirection;
  uniform float uRadius;
  varying vec2 vUv;

  void main() {
    if (uRadius <= 0.001) {
      gl_FragColor = texture2D(tInput, vUv);
      return;
    }
    const int TAPS = 8;
    float sigma = max(uRadius * 0.5, 0.5);
    float twoSigSq = 2.0 * sigma * sigma;
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int i = -TAPS; i <= TAPS; i++) {
      float fi = float(i);
      float w = exp(-fi * fi / twoSigSq);
      vec2 offset = uDirection * uTexelSize * fi * (uRadius / float(TAPS));
      sum += texture2D(tInput, vUv + offset).rgb * w;
      total += w;
    }
    gl_FragColor = vec4(sum / total, 1.0);
  }
`;

const REFLECTOR_VERT = /* glsl */ `
  uniform mat4 textureMatrix;
  varying vec4 vReflUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vReflUv = textureMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

// Solid-output Fresnel-blended floor. We deliberately do NOT include the
// `_pars_` versions of the tonemapping/colorspace chunks — Three.js
// auto-prepends those for ShaderMaterial, and including them here would
// cause duplicate function definitions and a silent shader compile error
// (which manifests as the mesh becoming invisible). Matches the stock
// three/examples/jsm/objects/Reflector.js pattern exactly.
const REFLECTOR_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec3 uBaseColor;
  uniform float uF0;
  uniform float uMinReflectance;
  uniform vec3 uCameraPos;
  varying vec4 vReflUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vec3 reflColor = texture2DProj(tDiffuse, vReflUv).rgb;
    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    float cosTheta = clamp(dot(viewDir, normalize(vWorldNormal)), 0.0, 1.0);
    // Schlick approximation. F0 ≈ 0.04 for a dielectric like polished
    // concrete; we floor it slightly so the reflection stays visible at
    // shallow camera angles too — pedagogical clarity over physical purity.
    float F = uF0 + (1.0 - uF0) * pow(1.0 - cosTheta, 5.0);
    F = max(F, uMinReflectance);
    vec3 finalColor = mix(uBaseColor, reflColor, F);
    gl_FragColor = vec4(finalColor, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class PlanarMode {
  constructor({ renderer, scene, camera, refs }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.refs = refs;
    this.name = 'planar';
    this.roughness = 0.2;
    this.active = false;
    this.extraReflectorsEnabled = false;
    this._build();
  }

  _build() {
    this.surfaces = [];
    this.floorSurface = this._createReflectorSurface({
      name: 'planarReflectorFloor',
      planeWidth: FLOOR_SIZE,
      planeHeight: FLOOR_SIZE,
      baseColor: 0x141210,
      f0: 0.06,
      minReflectance: 0.18,
      configure: (reflector) => {
        reflector.rotateX(-Math.PI / 2);
        reflector.position.y = 0;
      },
    });

    this.sideSurfaces = [
      this._createReflectorSurface({
        name: 'planarReflectorLeft',
        planeWidth: SIDE_MIRROR_WIDTH,
        planeHeight: SIDE_MIRROR_HEIGHT,
        baseColor: 0x161b22,
        f0: 0.08,
        minReflectance: 0.22,
        configure: (reflector) => {
          reflector.position.set(-SIDE_MIRROR_X, SIDE_MIRROR_HEIGHT * 0.5, 0);
          reflector.rotation.y = Math.PI / 2;
        },
      }),
      this._createReflectorSurface({
        name: 'planarReflectorRight',
        planeWidth: SIDE_MIRROR_WIDTH,
        planeHeight: SIDE_MIRROR_HEIGHT,
        baseColor: 0x161b22,
        f0: 0.08,
        minReflectance: 0.22,
        configure: (reflector) => {
          reflector.position.set(SIDE_MIRROR_X, SIDE_MIRROR_HEIGHT * 0.5, 0);
          reflector.rotation.y = -Math.PI / 2;
        },
      }),
    ];

    this.surfaces = [this.floorSurface, ...this.sideSurfaces];
    // Compatibility with the earlier single-reflector implementation.
    this.reflector = this.floorSurface.reflector;
    this.reflectorMaterial = this.floorSurface.material;
  }

  _createReflectorSurface({
    name,
    planeWidth,
    planeHeight,
    baseColor,
    f0,
    minReflectance,
    configure,
  }) {
    const { width, height } = this._getViewportSize();

    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    const reflector = new Reflector(geometry, {
      clipBias: 0.003,
      textureWidth: width,
      textureHeight: height,
      color: 0xffffff,
    });
    configure(reflector);
    reflector.name = name;

    const blurW = Math.max(2, Math.floor(width / 2));
    const blurH = Math.max(2, Math.floor(height / 2));
    const targetOpts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    const blurTargetA = new THREE.WebGLRenderTarget(blurW, blurH, targetOpts);
    const blurTargetB = new THREE.WebGLRenderTarget(blurW, blurH, targetOpts);
    // Match the source target's color space so the blurred output reads back
    // the same way the Reflector's render target would.
    blurTargetA.texture.colorSpace = this.renderer.outputColorSpace;
    blurTargetB.texture.colorSpace = this.renderer.outputColorSpace;

    const blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / blurW, 1 / blurH) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uRadius: { value: 0 },
      },
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const fsQuad = new FullScreenQuad(blurMaterial);

    // Replace Reflector's auto-generated material with our Fresnel shader.
    // Share the textureMatrix uniform reference so the closure inside the
    // Reflector's onBeforeRender keeps mutating the same Matrix4 we read.
    const originalMaterial = reflector.material;
    const reflectorMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: blurTargetB.texture },
        textureMatrix: originalMaterial.uniforms.textureMatrix,
        uBaseColor: { value: new THREE.Color(baseColor) },
        uF0: { value: f0 },
        uMinReflectance: { value: minReflectance },
        uCameraPos: { value: new THREE.Vector3() },
      },
      vertexShader: REFLECTOR_VERT,
      fragmentShader: REFLECTOR_FRAG,
    });
    reflector.material = reflectorMaterial;

    // Wrap onBeforeRender so the blur runs immediately after Reflector fills
    // its target.
    const baseTarget = reflector.getRenderTarget();
    const originalOnBeforeRender = reflector.onBeforeRender;
    const self = this;
    const surface = {
      reflector,
      blurTargetA,
      blurTargetB,
      blurMaterial,
      fsQuad,
      material: reflectorMaterial,
    };

    reflector.onBeforeRender = function (renderer, scene, camera) {
      const hiddenSiblings = [];
      for (const other of self.surfaces) {
        if (other !== surface && other.reflector.visible) {
          other.reflector.visible = false;
          hiddenSiblings.push(other.reflector);
        }
      }

      originalOnBeforeRender.call(this, renderer, scene, camera);

      for (const hidden of hiddenSiblings) hidden.visible = true;

      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;

      const radius = self.roughness * MAX_BLUR_RADIUS_PX;
      blurMaterial.uniforms.uRadius.value = radius;

      // Horizontal pass: baseTarget → blurTargetA
      blurMaterial.uniforms.tInput.value = baseTarget.texture;
      blurMaterial.uniforms.uDirection.value.set(1, 0);
      renderer.setRenderTarget(blurTargetA);
      fsQuad.render(renderer);

      // Vertical pass: blurTargetA → blurTargetB
      blurMaterial.uniforms.tInput.value = blurTargetA.texture;
      blurMaterial.uniforms.uDirection.value.set(0, 1);
      renderer.setRenderTarget(blurTargetB);
      fsQuad.render(renderer);

      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    };

    return surface;
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
    const blurW = Math.max(2, Math.floor(width / 2));
    const blurH = Math.max(2, Math.floor(height / 2));
    for (const surface of this.surfaces) {
      surface.reflector.getRenderTarget().setSize(width, height);
      surface.blurTargetA.setSize(blurW, blurH);
      surface.blurTargetB.setSize(blurW, blurH);
      surface.blurMaterial.uniforms.uTexelSize.value.set(1 / blurW, 1 / blurH);
    }
  }

  setRoughness(value) {
    this.roughness = value;
  }

  setExtraReflectors(enabled) {
    this.extraReflectorsEnabled = enabled;
    this._syncExtraReflectors();
  }

  activate() {
    this.active = true;
    if (!this.floorSurface.reflector.parent) this.scene.add(this.floorSurface.reflector);
    // Hide the original floor — the Reflector takes its place in this mode.
    this.refs.floor.visible = false;
    if (this.refs.sideMirrors) this.refs.sideMirrors.visible = false;
    this._syncExtraReflectors();
    this.resize();
  }

  dispose() {
    this.active = false;
    for (const surface of this.surfaces) {
      if (surface.reflector.parent) this.scene.remove(surface.reflector);
    }
    this.refs.floor.visible = true;
  }

  render() {
    for (const surface of this._activeSurfaces()) {
      surface.material.uniforms.uCameraPos.value.copy(this.camera.position);
    }
    this.renderer.render(this.scene, this.camera);
  }

  _activeSurfaces() {
    return this.extraReflectorsEnabled
      ? this.surfaces
      : [this.floorSurface];
  }

  _syncExtraReflectors() {
    if (!this.active) return;
    for (const surface of this.sideSurfaces) {
      if (this.extraReflectorsEnabled) {
        if (!surface.reflector.parent) this.scene.add(surface.reflector);
      } else if (surface.reflector.parent) {
        this.scene.remove(surface.reflector);
      }
    }
    if (this.refs.sideMirrors) this.refs.sideMirrors.visible = false;
  }
}
