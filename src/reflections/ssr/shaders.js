// GLSL strings for the SSR pipeline.
//
// Two materials:
//   1. NormalMaterial — used as scene.overrideMaterial during the G-buffer
//      pass. Outputs view-space normal in RGB and a per-mesh "roughness" in
//      alpha (1.0 = treat as non-reflective, the SSR shader will skip it).
//   2. CompositeMaterial — full-screen pass that reads the G-buffer + the
//      depth texture and ray-marches each pixel's reflection.
//
// The composite shader is written in GLSL ES 3.0 (declared via
// `glslVersion: THREE.GLSL3` on the material) so we can use `textureLod`
// natively for cone tracing.

// ────────────────────────────────────────────────────────────────────
// G-buffer normal pass (default Three.js GLSL ES 1.0)
// ────────────────────────────────────────────────────────────────────

export const NORMAL_VERT = /* glsl */ `
  varying vec3 vViewNormal;
  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

export const NORMAL_FRAG = /* glsl */ `
  varying vec3 vViewNormal;
  void main() {
    // Always alpha=1 — only SSR-reflective meshes are even rendered to this
    // target (filtered via camera.layers). Pixels not covered remain at the
    // cleared alpha=0 and are treated as "not SSR-reflective" by the composite.
    gl_FragColor = vec4(normalize(vViewNormal) * 0.5 + 0.5, 1.0);
  }
`;

// ────────────────────────────────────────────────────────────────────
// SSR composite pass (GLSL ES 3.0)
// ────────────────────────────────────────────────────────────────────

export const SSR_VERT = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Reads:
//   tColor        — normal scene render / beauty pass. Mipmapped for cone
//                    tracing so SSR can read blurred color at higher roughness.
//   tDepth        — depth attachment from the same scene render.
//   tNormalRough  — view-space normal (RGB) + per-pixel roughness (A).
//   tEnvBackground — raw equirectangular HDR for fallback mode.
//
// Outputs final composited color directly to the canvas.
export const SSR_FRAG = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  out vec4 outColor;

  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler2D tNormalRough;
  uniform sampler2D tEnvBackground;

  uniform mat4 uProjMatrix;
  uniform mat4 uInvProjMatrix;
  uniform mat4 uInvViewMatrix;
  uniform vec2 uResolution;

  uniform float uMaxDistance;     // view-space ray length cap
  uniform float uThickness;       // depth comparison tolerance (linear)
  uniform int   uMaxSteps;        // hard cap on ray-march steps
  uniform int   uUseFallback;     // 0 = pure SSR, 1 = fall back to cubemap
  uniform float uIntensity;       // global SSR brightness scale
  uniform float uEnvExposure;     // exposure applied to env fallback samples
  uniform float uRoughness;       // single global roughness driving cone trace + gloss
  uniform int   uDebugMode;       // 0=off, 1=normal, 2=SSR hit mask, 3=depth

  const float PI = 3.14159265359;

  // ACES Filmic approximation by Krzysztof Narkowicz. Matches closely enough
  // to Three.js's ACESFilmicToneMapping for our env-fallback samples to
  // visually match the rest of the (already tone-mapped) colorTarget.
  vec3 acesTonemap(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  // Reconstruct view-space position from a UV and the depth buffer value.
  vec3 reconstructViewPos(vec2 uv, float depth) {
    float z = depth * 2.0 - 1.0;
    vec4 clipPos = vec4(uv * 2.0 - 1.0, z, 1.0);
    vec4 viewPos = uInvProjMatrix * clipPos;
    return viewPos.xyz / viewPos.w;
  }

  // Returns the view-space Z corresponding to a depth-buffer value (linear).
  float linearViewZ(float depth) {
    float z = depth * 2.0 - 1.0;
    vec4 viewPos = uInvProjMatrix * vec4(0.0, 0.0, z, 1.0);
    return viewPos.z / viewPos.w;
  }

  // Equirectangular sample of the raw HDR sky from a world-space direction.
  vec2 dirToEquirect(vec3 dir) {
    // Three.js convention: u from +X around to +Z (atan2 over xz plane).
    float u = atan(dir.z, dir.x) / (2.0 * PI) + 0.5;
    float v = asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5;
    return vec2(u, v);
  }

  void main() {
    vec3 baseColor = texture(tColor, vUv).rgb;
    vec4 normalRough = texture(tNormalRough, vUv);
    float reflectiveMask = normalRough.a;

    // Debug visualizers — wired to the side-panel checkboxes.
    if (uDebugMode == 1) {            // view-space normal as RGB
      outColor = vec4(normalRough.rgb, 1.0);
      return;
    }
    if (uDebugMode == 3) {            // depth buffer as gray (sharpened)
      float d = texture(tDepth, vUv).r;
      outColor = vec4(vec3(pow(d, 32.0)), 1.0);
      return;
    }

    // Layer-filtered: pixels with alpha=0 weren't drawn into the normal
    // target, meaning they aren't SSR-reflective. Pass the base color through.
    if (reflectiveMask < 0.5) {
      if (uDebugMode == 2) {
        outColor = vec4(vec3(0.0), 1.0);
        return;
      }
      outColor = vec4(baseColor, 1.0);
      return;
    }

    float depth = texture(tDepth, vUv).r;
    if (depth >= 0.9999) {
      // Sky / background pixel — leave as-is.
      if (uDebugMode == 2) {
        outColor = vec4(vec3(0.0), 1.0);
        return;
      }
      outColor = vec4(baseColor, 1.0);
      return;
    }

    vec3 viewPos = reconstructViewPos(vUv, depth);
    vec3 viewNormal = normalize(normalRough.xyz * 2.0 - 1.0);
    vec3 viewDir = normalize(viewPos);
    vec3 reflDir = normalize(reflect(viewDir, viewNormal));

    // Skip rays that point back toward the camera.
    if (reflDir.z >= 0.0) {
      if (uDebugMode == 2) {
        outColor = vec4(0.85, 0.12, 0.07, 1.0);
        return;
      }
      outColor = vec4(baseColor, 1.0);
      return;
    }

    // Ray endpoints in view space. The bias along the surface normal moves
    // the start off the source surface so the first marching steps don't
    // immediately re-detect it. For floor reflections the ray walks through
    // many screen pixels that are STILL floor pixels (perspective extends
    // back), and a small bias gets erased by perspective; 0.3 view-space
    // units is conservative but reliably escapes self-intersection.
    vec3 rayStart = viewPos + viewNormal * 0.3;
    vec3 rayEnd   = rayStart + reflDir * uMaxDistance;

    vec4 startClip = uProjMatrix * vec4(rayStart, 1.0);
    vec4 endClip   = uProjMatrix * vec4(rayEnd,   1.0);

    if (startClip.w <= 0.001 || endClip.w <= 0.001) {
      if (uDebugMode == 2) {
        outColor = vec4(0.85, 0.12, 0.07, 1.0);
        return;
      }
      outColor = vec4(baseColor, 1.0);
      return;
    }

    vec3 startScreen = (startClip.xyz / startClip.w) * 0.5 + 0.5;
    vec3 endScreen   = (endClip.xyz   / endClip.w)   * 0.5 + 0.5;

    vec3 deltaScreen = endScreen - startScreen;
    vec2 deltaPx = deltaScreen.xy * uResolution;
    float stepCountF = max(abs(deltaPx.x), abs(deltaPx.y));
    stepCountF = min(stepCountF, float(uMaxSteps));
    if (stepCountF < 2.0) {
      if (uDebugMode == 2) {
        outColor = vec4(0.85, 0.12, 0.07, 1.0);
        return;
      }
      outColor = vec4(baseColor, 1.0);
      return;
    }
    vec3 stepScreen = deltaScreen / stepCountF;

    // March with crossing detection (McGuire & Mara 2014). At each step we
    // record whether the ray is in front of the depth buffer; the surface
    // is hit when we transition front → behind across a single step. The
    // thickness gate then rejects hits where we passed clean through a
    // thin object (the depth on the other side is too far away to be the
    // same surface we just crossed).
    // Skip the first few steps explicitly. The pixel-stepped ray walks
    // through screen pixels that may belong to the SAME continuous surface
    // we're reflecting from (e.g. the floor extends back behind us); a
    // hit detected before the ray has materially separated from the source
    // surface is almost always a self-reflection.
    const int START_STEP = 6;
    vec3 cur  = startScreen + stepScreen * float(START_STEP);
    vec3 prev = startScreen + stepScreen * float(START_STEP - 1);
    float prevSceneDepth = texture(tDepth, prev.xy).r;
    bool prevInFront = prev.z < prevSceneDepth;

    bool hit = false;
    vec2 hitUv = vec2(0.0);

    for (int i = START_STEP; i < 256; i++) {
      if (float(i) > stepCountF) break;
      if (cur.x < 0.0 || cur.x > 1.0 || cur.y < 0.0 || cur.y > 1.0) break;

      float sceneDepth = texture(tDepth, cur.xy).r;
      bool curInFront = cur.z < sceneDepth;

      if (prevInFront && !curInFront && sceneDepth < 0.9999) {
        float rayLinZ   = linearViewZ(cur.z);
        float sceneLinZ = linearViewZ(sceneDepth);
        if (abs(rayLinZ - sceneLinZ) < uThickness) {
          hit = true;
          hitUv = cur.xy;
          break;
        }
      }

      prevInFront = curInFront;
      cur += stepScreen;
    }

    vec3 ssrColor = vec3(0.0);
    float hitWeight = 0.0;

    if (hit) {
      // Cone tracing: rougher surfaces sample blurrier mips.
      float mipLevel = uRoughness * 6.0;
      ssrColor = textureLod(tColor, hitUv, mipLevel).rgb;

      // Edge fade — reflections near screen edges are unreliable.
      vec2 edgeDist = min(hitUv, 1.0 - hitUv);
      float fade = smoothstep(0.0, 0.12, min(edgeDist.x, edgeDist.y));

      // Direction fade — rays that point too close to the camera exit the
      // frustum almost immediately and produce flickery near-camera hits.
      float dirFade = clamp(-reflDir.z, 0.0, 1.0);

      hitWeight = fade * dirFade;
    }

    if (uDebugMode == 2) {
      vec3 missColor = vec3(0.85, 0.12, 0.07);
      vec3 weakHit = vec3(0.10, 0.40, 1.00);
      vec3 strongHit = vec3(0.15, 1.00, 0.45);
      vec3 hitColor = mix(weakHit, strongHit, clamp(hitWeight, 0.0, 1.0));
      outColor = vec4(hit ? hitColor : missColor, 1.0);
      return;
    }

    // Cubemap fallback: where SSR didn't hit (or hit weakly), sample the
    // env map at the world-space reflection direction. Exactly the
    // "production" behavior the doc calls out for SSR + Cubemap mode.
    if (uUseFallback == 1) {
      vec3 worldRefl = (uInvViewMatrix * vec4(reflDir, 0.0)).xyz;
      vec3 envColor = texture(tEnvBackground, dirToEquirect(normalize(worldRefl))).rgb;
      envColor = acesTonemap(envColor * uEnvExposure);

      ssrColor = mix(envColor, ssrColor, hitWeight);
      hitWeight = 1.0;
    }

    // Schlick Fresnel — boosts grazing-angle reflections.
    float cosTheta = max(0.0, dot(viewNormal, -viewDir));
    float F0 = 0.04;
    float fresnel = F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);

    // The "(1 - roughness)" factor controls how much of the surface's color
    // is dominated by the reflection (mirror-smooth → all reflection,
    // matte → none). Combined with Fresnel for angle dependence.
    float gloss = clamp(1.0 - uRoughness * 1.1, 0.0, 1.0);
    float strength = gloss * fresnel * hitWeight * uIntensity;
    // Floor a small amount so reflections stay visible at near-normal
    // viewing angles (purely physical Fresnel makes the floor look matte
    // when viewed top-down — we want pedagogical clarity).
    strength = max(strength, gloss * 0.18 * hitWeight);

    vec3 finalColor = baseColor + ssrColor * strength;

    outColor = vec4(finalColor, 1.0);
  }
`;
