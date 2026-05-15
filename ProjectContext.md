# CENG510 Final Project — Real-Time Reflection Techniques Comparison Tool

> **Context document for Claude Code.** This document contains everything needed to understand and implement this project: academic background, design decisions, technical architecture, and step-by-step implementation guidance.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Academic Context](#2-academic-context)
3. [The Four Reflection Techniques](#3-the-four-reflection-techniques-the-research-summary)
4. [Project Goals](#4-project-goals)
5. [Scene Design](#5-scene-design)
6. [User Interface Specification](#6-user-interface-specification)
7. [Technical Architecture](#7-technical-architecture)
8. [Implementation Plan](#8-implementation-plan)
9. [Technical Deep-Dives](#9-technical-deep-dives)
10. [Acceptance Criteria](#10-acceptance-criteria)
11. [Reference Materials](#11-reference-materials)

---

## 1. Project Overview

### 1.1 What This Is

An **interactive web-based comparison tool** that demonstrates three real-time reflection techniques (cubemap, planar, and screen-space reflections) on a single Three.js scene. Users can toggle between techniques in real time, adjust roughness, orbit the camera, and observe — visually and through performance metrics — the trade-offs each technique makes.

### 1.2 Why This Project

This is the final project for **CENG510 (Advanced Computer Graphics)**, a Master's level course at Çukurova University. The project topic was chosen to fulfill three criteria:

- **Within the curriculum** — reflections connect to Weeks 2 (Light), 4–5 (Ray Tracing), 6 (Shading), 7 (Sampling)
- **Deep enough to research** — 40+ years of literature, multiple distinct techniques
- **Implementable as a mini project** — a Three.js comparison tool ticks both the academic and interactive boxes

The midterm research report has already been delivered to the instructor (Öğr. Gör. Yunus Emre Çogurcu) and approved.

### 1.3 Audience

The instructor will evaluate this project. He explicitly approved the project idea during the April 15 meeting. He also requested a final written report with academic rigor — that's a separate deliverable, but the project should be self-explanatory and demonstrative without requiring the report to make sense.

### 1.4 Hosting & Delivery

- **GitHub repository** (public — required by instructor)
- **GitHub Pages deployment** for one-click access via URL
- **No build step preferred** if possible — direct browser-runnable code is ideal for a demo

---

## 2. Academic Context

### 2.1 The Problem Space

In offline ray tracing, reflections are easy: trace a secondary ray in the mirror direction at every shiny surface point. In real-time rendering, this is too expensive — you have ~16 ms per frame for 60 fps, and a 1080p frame has 2 million pixels. The history of real-time reflections is the history of **clever approximations**.

### 2.2 The Progression Story

This narrative structures the entire project. Each technique fixes the biggest failure of the previous one:

| Year | Technique | What It Fixed | New Limitation |
|------|-----------|---------------|----------------|
| 1976 | **Cubemaps** | Made real-time reflections possible at all | No parallax, no nearby objects, frozen in time |
| 1990s | **Planar reflections** | Pixel-perfect accuracy for flat surfaces | Only flat surfaces; cost doubles per mirror |
| 2014 | **Screen-space reflections** | Works on any shape; reuses existing frame data | Can only reflect what's on screen |
| 2018+ | **Hybrid ray tracing** | Sees the full 3D scene, not just the screen | Requires dedicated GPU hardware |

The project demonstrates the first three. Hybrid RT is discussed in the report but not implemented (WebGPU ray tracing is still experimental).

### 2.3 Physics Foundations

The user does not need to see equations, but the implementation uses them:

- **Reflection vector**: `r = d - 2(d·n)n` — built into GLSL as `reflect(d, n)`
- **Fresnel (Schlick)**: `F = F₀ + (1 - F₀)(1 - cos θ)⁵` — automatically included in Three.js's `MeshStandardMaterial` and `MeshPhysicalMaterial`
- **Microfacet model**: Roughness controls how randomly oriented the microscopic mirrors are; low roughness = sharp reflections, high roughness = blurred reflections

### 2.4 Key Papers Referenced

Cited in the academic report and informing this project's design:

1. **Blinn & Newell (1976)** — Environment mapping
2. **Greene (1986)** — Cubemap parameterisation
3. **Whitted (1980)** — Recursive ray tracing baseline
4. **Karis (2013)** — Split-sum approximation for PBR cubemaps (UE4)
5. **McGuire & Mara (2014)** — *The* foundational SSR paper, JCGT — primary reference for SSR implementation
6. **Uludag (2014)** — Hi-Z cone-traced SSR optimization
7. **Stachowiak (2015)** — Stochastic SSR for glossy surfaces
8. **Ganestam & Doggett (2015)** — Hybrid rendering, peer-reviewed (The Visual Computer)

---

## 3. The Four Reflection Techniques (The Research Summary)

This section describes how each technique works at a level sufficient for implementation. Read this carefully before writing code — the *why* drives the *how*.

### 3.1 Cubemaps (Environment Mapping)

**Intuition:** Take 6 photos of the surroundings (one per cube face), glue them onto an imaginary box around the reflective object, and look up reflections in this box.

**Algorithm:**
1. Compute reflection vector `r = reflect(viewDir, normal)` in the fragment shader
2. Sample the cubemap texture using `r` as a 3D direction vector
3. The sampled colour is the reflection
4. For PBR: pre-blur the cubemap at multiple mip levels (split-sum); rougher surfaces sample blurrier mips

**Implementation in Three.js:**
- Use a static HDR environment map (loaded via `RGBELoader` or `CubeTextureLoader`)
- Set `scene.environment` to make it affect all PBR materials automatically
- Three.js handles split-sum internally for `MeshStandardMaterial`/`MeshPhysicalMaterial`
- For dynamic cubemaps: `CubeCamera` re-renders 6 faces every frame (expensive — only use if needed)

**Strengths:** Fast (single texture lookup), works on any shape, supports roughness via mips
**Weaknesses:** No parallax (objects in cubemap don't shift as you move), no self-reflection, frozen in time

---

### 3.2 Planar Reflections

**Intuition:** For flat reflective surfaces, place a virtual camera on the other side of the mirror plane, render the scene from there, and project the result onto the surface.

**Algorithm:**
1. Compute the reflection matrix for the mirror plane: `M = I - 2nnᵀ`
2. Apply this matrix to the camera's position and orientation to get the reflected camera
3. Set up oblique near-plane clipping so geometry below the plane doesn't render
4. Render the scene to a `WebGLRenderTarget` (off-screen texture) using the reflected camera
5. In the main pass, project this texture onto the floor using screen-space UV mapping
6. Blend with the floor's base colour using Fresnel

**Implementation in Three.js:**
- **Easy path:** Use `Reflector` from `three/examples/jsm/objects/Reflector.js` — it handles the entire pipeline
- **Manual path:** `WebGLRenderTarget` + custom shader material with projective texture sampling
- Be aware: each reflective plane requires re-rendering the entire scene → 2× cost

**Strengths:** Pixel-perfect for flat surfaces, parallax correct, dynamic objects reflected
**Weaknesses:** Only flat surfaces, expensive with multiple reflectors, roughness via post-blur is a hack

---

### 3.3 Screen-Space Reflections (SSR) — THE CORE OF THIS PROJECT

**Intuition:** After the GPU has rendered the frame, two buffers exist in memory: the **colour buffer** (the image you see) and the **depth buffer** (how far each pixel is from the camera). SSR reuses these. For each reflective pixel, walk along the reflection direction in screen space, comparing the ray's depth to the depth buffer at each step. When the ray goes "behind" the depth buffer, you've hit something — read the colour at that pixel.

**Algorithm (per reflective pixel, in a post-process fragment shader):**

1. **Read G-buffer data** at this pixel: world-space position, normal, roughness, metalness
2. **Compute reflection direction in view space:**
   ```
   viewDir = normalize(viewPos)
   reflDir = reflect(viewDir, viewNormal)
   ```
3. **Project reflection ray into screen space:** transform start and end points by the projection matrix, divide by w, scale to [0,1] UV space
4. **Ray march along screen-space line:**
   - At each step (pixel by pixel along the dominant axis — DDA approach):
     - Sample the depth buffer at current screen position
     - Compute the ray's expected depth at this position (linear interpolation)
     - If `rayDepth > sceneDepth + thickness`: ray has passed behind a surface → potential hit
     - If hit found: refine with binary search for sub-pixel accuracy
5. **Read colour buffer** at the hit pixel — this is the reflected colour
6. **Apply edge fade:** as the hit approaches the screen edge, fade out (data unreliable beyond edges)
7. **Cubemap fallback:** if no hit found OR fade region, blend with cubemap reflection

**Marching strategies:**
- **Linear:** Fixed-size steps. Simple but risks stepping over thin objects.
- **DDA:** One pixel at a time along the dominant axis. Pixel-perfect, never misses. Used by McGuire & Mara.
- **Hi-Z:** Hierarchical depth pyramid (min-depth mipmap). Skips empty space fast. More complex but much faster for long rays. Optional — implement if time allows.

**Roughness handling (two options):**
- **Cone tracing:** Read from blurred mip levels of the colour buffer based on roughness. Simple, fast, approximate.
- **Stochastic multi-ray:** Fire multiple jittered rays per pixel from the GGX distribution; temporal accumulation reduces noise. Accurate but requires temporal AA infrastructure. **Recommend cone tracing for simplicity.**

**Implementation in Three.js:**
- **Easy path:** Use `SSRPass` from `three/examples/jsm/postprocessing/SSRPass.js` — it works but is limited
- **Recommended path:** Write a custom post-processing shader. Three.js has all the building blocks:
  - `EffectComposer` for the post-process pipeline
  - `RenderPass` for the base render
  - Custom `ShaderPass` for SSR
  - Access to depth buffer via `WebGLRenderTarget` with `DepthTexture`
- The McGuire & Mara 2014 paper has GLSL pseudo-code that translates almost directly

**The famous failure modes (must be demonstrated):**
1. **Off-screen objects** — gone from reflections at screen edges
2. **Back-facing surfaces** — depth buffer is single-layer, back faces invisible
3. **Thin objects** — large step sizes can skip them
4. **Grazing angles** — slow performance, banding artefacts

**This is why we have an "off-screen object" in the scene — to make the limitation visible.**

---

### 3.4 Hybrid Ray Tracing (NOT IMPLEMENTED, DISCUSS ONLY)

**Why not implemented:** WebGPU ray tracing is experimental as of 2026. Three.js does not support it. Implementing it would require rewriting the entire renderer in WebGPU + using ray tracing extensions that are still in flux.

**What to do:** Mention it in the UI/about section as the "next step" — show it as a disabled radio option with a tooltip explaining "Requires hardware ray tracing (RTX/RDNA 2+)" or similar.

---

## 4. Project Goals

### 4.1 Primary Goal

Allow users to **see and feel the differences** between cubemap, planar, and SSR reflections on a unified scene. Differences should be:

- **Visually obvious** at a glance
- **Quantitatively measurable** via FPS counter
- **Pedagogically clear** — the user should understand *why* each technique fails where it does

### 4.2 Demonstration Narrative

When the instructor (or any viewer) loads the page, the experience should tell a story:

1. **Cubemap mode** is loaded by default. Floor reflects the environment. Looks decent at first.
2. User toggles to **planar reflection**. Suddenly the floor reflection is *perfect*: objects on the floor are in the right positions, sharp, accurate. But only the floor reflects — the sphere doesn't.
3. User toggles to **SSR**. Now the sphere reflects too. Contact reflections look beautiful where objects meet the floor. But...
4. User **orbits the camera**. As they pan, reflections start vanishing at screen edges. Watch reflections of objects at the edge of the screen pop in and out.
5. User **looks at the off-screen object** (positioned behind the camera). It's visible in the cubemap reflection but completely missing from SSR.
6. User toggles to **SSR + cubemap fallback**. The cubemap smoothly fills in where SSR fails. This is what production engines do.
7. User **adjusts the roughness slider**. Each technique handles roughness differently — cubemap uses mip levels (smooth), planar uses post-blur (less smooth), SSR uses cone tracing (decent).
8. **FPS counter** shows the cost: cubemap is essentially free, planar doubles cost, SSR adds ~1-2ms.

### 4.3 Non-Goals (To Manage Scope)

- **NOT building a path tracer** or any offline rendering
- **NOT implementing hardware ray tracing** (out of scope for WebGL)
- **NOT building a full PBR engine** — Three.js's built-in PBR is sufficient
- **NOT optimising for production** — clarity > performance
- **NOT building a level editor** — one fixed scene is enough
- **NOT supporting mobile** — desktop browser focus

---

## 5. Scene Design

The scene is **deliberately constructed** to expose each technique's strengths and weaknesses. Every element has a purpose.

### 5.1 Scene Elements

| Element | Position | Purpose | What It Tests |
|---------|----------|---------|---------------|
| **Glossy floor plane** | y = 0, large (20×20 units) | Primary reflective surface | All techniques; roughness; contact reflections |
| **Metallic sphere** | (0, 1, 0), radius ~1 | Curved reflector | Cubemap (works), planar (fails), SSR (works) |
| **Coloured cubes** | Around the sphere, varying heights | Identifiable reflected content | Whether reflections track dynamic-looking content |
| **Teapot** (Utah teapot, optional) | Off to one side | Iconic CG model, complex geometry | SSR thin-feature handling (handle, spout) |
| **"Hidden" red cube** | **Behind the camera's default position** | THE star demonstration | Visible in cubemap, absent in SSR — the fundamental SSR failure |
| **HDR environment** | Skybox | Distant background, lighting | Provides the cubemap data |
| **Roughness gradient strip** | Inset on the floor or as a separate strip | Visualizes roughness behavior | How each technique handles varying roughness on one surface |

### 5.2 Lighting

- **Image-based lighting** from the HDR environment (primary light source)
- **One directional light** to provide a sun-like sharp shadow direction
- Ambient light is handled by the IBL — don't add extra ambient

### 5.3 HDR Environment

Use a **freely available HDR environment map** for the skybox/environment. Suggestions:

- [Poly Haven](https://polyhaven.com/hdris) — free, CC0 licensed
- Recommended: an outdoor or studio scene with strong directional features so reflections are visually rich
- Format: `.hdr` (use `RGBELoader`) or pre-processed `.exr`/cubemap PNGs
- Resolution: 2K is plenty (don't use 4K+, slows initial load)

### 5.4 Materials

| Object | Material | Albedo | Metalness | Roughness | Notes |
|--------|----------|--------|-----------|-----------|-------|
| Floor | `MeshStandardMaterial` | (0.5, 0.5, 0.5) | 0 (dielectric) | **Bound to slider** | Primary reflector |
| Sphere | `MeshStandardMaterial` | (1.0, 0.85, 0.6) | 1 (metallic) | 0.1 (smooth) | Gold-like; clear curved reflector |
| Cubes | `MeshStandardMaterial` | Various colours | 0 | 0.5 | Identifiable reflected objects |
| "Hidden" red cube | `MeshStandardMaterial` | (1, 0, 0) | 0 | 0.5 | High visibility colour for the SSR demo |
| Teapot | `MeshStandardMaterial` | (0.2, 0.6, 0.9) | 0.5 | 0.3 | Mid-glossy mid-metal |

---

## 6. User Interface Specification

### 6.1 Layout

```
┌─────────────────────────────────────────────────────────────┐
│  CENG510 — Real-Time Reflection Techniques  [About] [Code]  │  ← Top bar
├──────────────────────────────────┬──────────────────────────┤
│                                  │  Reflection Mode         │
│                                  │   ○ Cubemap              │
│                                  │   ○ Planar               │
│                                  │   ● SSR                  │
│                                  │   ○ SSR + Cubemap        │
│                                  │                          │
│         3D VIEWPORT              │  Roughness               │
│         (canvas)                 │   ▓▓▓▓▓░░░░░  0.4        │
│                                  │                          │
│                                  │  Camera                  │
│                                  │   [Reset View]           │
│                                  │   [Look at Hidden Cube]  │
│                                  │                          │
│                                  │  Debug                   │
│                                  │   ☐ Show depth buffer    │
│                                  │   ☐ Show SSR rays        │
│                                  │   ☐ Show off-screen      │
│                                  │     indicator            │
│                                  │                          │
│                                  │  Performance             │
│                                  │   FPS: 60                │
│                                  │   Frame time: 16.4 ms    │
│                                  │   SSR time: 2.1 ms       │
└──────────────────────────────────┴──────────────────────────┘
                                                          ↑
                                                 Side panel ~280px
```

### 6.2 Controls Specification

#### Reflection Mode (Radio buttons)
- **Cubemap** — Only environment map reflections (Three.js default behaviour with `scene.environment`)
- **Planar** — Floor uses Reflector; sphere falls back to cubemap (planar can't do curved)
- **SSR** — Custom SSR pass; cubemap as base
- **SSR + Cubemap fallback** — SSR with smooth blend to cubemap at edges/failures (the "production" mode)
- *(Disabled)* **Hybrid Ray Tracing** — tooltip: "Requires hardware ray tracing — out of scope for WebGL"

#### Roughness Slider
- Range: 0 to 1
- Default: 0.2 (slightly glossy — best demonstrates differences)
- Updates the floor material's roughness in real time
- Floor only — sphere stays at 0.1 (need a clear curved reflector regardless)

#### Camera Controls
- **OrbitControls** for normal interaction (mouse drag = orbit, scroll = zoom)
- **Reset View** button — returns to default position/orientation
- **Look at Hidden Cube** button — programmatically rotates camera to look behind, demonstrating the SSR failure

#### Debug Toggles
- **Show depth buffer** — overlay or replace the viewport with the depth buffer visualization
- **Show SSR rays** — visualize SSR ray paths for a few sample pixels (advanced, optional)
- **Show off-screen indicator** — visual marker (arrow or text) showing where the hidden red cube is when off-screen

#### Performance Overlay
- Always visible (top-right of viewport or in side panel)
- **FPS** — frames per second (averaged over ~30 frames)
- **Frame time** — milliseconds per frame
- **SSR time** — time spent in the SSR pass specifically (use `EXT_disjoint_timer_query_webgl2` or a CPU-side approximation)

### 6.3 Visual Style

- **Clean, modern, dark theme** (matches typical 3D tools)
- **No flashy animations** — the focus is the 3D viewport
- **Tooltips** on every control explaining what it does
- **No build step required** for the UI if possible (vanilla HTML/CSS/JS)

### 6.4 About / Help Section

Accessible via the "About" link in the top bar. A modal or sidebar containing:

- Brief description of the project (1-2 paragraphs)
- Links to the academic report PDF
- The four-technique progression table
- "Try this:" suggestions to demonstrate each technique's failures
- Credits and references

---

## 7. Technical Architecture

### 7.1 Tech Stack

- **Three.js** (latest stable — r160+ as of 2026)
- **Vanilla JavaScript ES modules** — no build tooling required
- **HTML/CSS** for UI (no React/Vue — overkill for this project)
- **GitHub Pages** for hosting
- Optional: `lil-gui` for quick UI panel if vanilla feels slow to develop

### 7.2 Project Structure

```
project-root/
├── index.html                  # Main HTML, loads the app
├── style.css                   # UI styling
├── README.md                   # GitHub README
├── LICENSE                     # MIT or similar
│
├── src/
│   ├── main.js                 # Entry point: scene setup, render loop
│   ├── scene.js                # Scene construction (objects, lighting)
│   ├── ui.js                   # UI event handlers, mode switching
│   ├── stats.js                # FPS / frame time tracking
│   │
│   ├── reflections/            # The reflection technique implementations
│   │   ├── cubemap.js          # Cubemap mode (mostly Three.js defaults)
│   │   ├── planar.js           # Planar reflection setup using Reflector
│   │   ├── ssr/
│   │   │   ├── SSRPass.js      # Custom SSR post-processing pass
│   │   │   ├── ssr.vert.glsl   # Vertex shader (full-screen quad)
│   │   │   └── ssr.frag.glsl   # The SSR fragment shader (the meat)
│   │   └── ssrFallback.js      # SSR + cubemap blending mode
│   │
│   └── debug/
│       ├── depthVisualizer.js  # Depth buffer overlay
│       ├── rayVisualizer.js    # SSR ray path visualization (optional)
│       └── offscreenIndicator.js # Arrow/marker for hidden objects
│
└── assets/
    ├── env/
    │   └── studio.hdr          # HDR environment map
    └── models/
        └── teapot.glb          # Optional Utah teapot
```

### 7.3 Mode Switching Architecture

Each reflection mode is a **strategy** — they share the same scene but differ in what gets rendered and how.

```javascript
// Pseudocode for the renderer
const modes = {
  cubemap: new CubemapMode(scene, renderer),
  planar: new PlanarMode(scene, renderer),
  ssr: new SSRMode(scene, renderer),
  ssrFallback: new SSRWithFallbackMode(scene, renderer),
};

let currentMode = modes.cubemap;

function render() {
  stats.begin();
  currentMode.render(camera);  // Each mode handles its own pipeline
  stats.end();
  requestAnimationFrame(render);
}

function switchMode(name) {
  currentMode.dispose?.();    // Clean up previous mode's resources
  currentMode = modes[name];
  currentMode.activate?.();   // Set up the new mode
}
```

### 7.4 Three.js APIs Used

- `WebGLRenderer` — the core renderer
- `Scene`, `PerspectiveCamera`, `OrbitControls` — basic 3D
- `MeshStandardMaterial` — PBR materials (handles cubemap reflections automatically when `scene.environment` is set)
- `RGBELoader` — load HDR environment
- `PMREMGenerator` — pre-filter HDR for split-sum cubemap reflections
- `Reflector` from `three/examples/jsm/objects/Reflector.js` — easy planar reflection
- `EffectComposer`, `RenderPass`, `ShaderPass` from `three/examples/jsm/postprocessing/` — for SSR
- `WebGLRenderTarget`, `DepthTexture` — for the G-buffer that SSR reads
- `Stats` from `three/examples/jsm/libs/stats.module.js` — FPS overlay (or build custom)

---

## 8. Implementation Plan

The project has 8 weeks. Each phase has a clear deliverable.

### Phase 1 — Project Setup (Week 1, ~3 days)

**Goal:** Repository ready, Three.js scene rendering, deployment pipeline working.

Tasks:
- [ ] Create GitHub repo with proper README, LICENSE, .gitignore
- [ ] Set up `index.html` loading Three.js from a CDN (or via npm if you prefer a build)
- [ ] Configure GitHub Pages on the `main` branch
- [ ] Create the basic file structure as specified in section 7.2
- [ ] Empty Three.js scene rendering — just a coloured background and a cube
- [ ] OrbitControls working
- [ ] FPS counter displayed

**Deliverable:** A live URL showing a spinning cube. Boring but proves the pipeline works.

---

### Phase 2 — Scene Construction (Week 2, ~5 days)

**Goal:** The full demo scene built with PBR materials and HDR environment.

Tasks:
- [ ] Source an HDR environment map (Poly Haven recommended)
- [ ] Load it via `RGBELoader` and `PMREMGenerator`
- [ ] Set `scene.environment` and `scene.background`
- [ ] Build the floor plane (large, glossy, bound roughness to a constant for now)
- [ ] Add the metallic sphere (gold-like)
- [ ] Add 3-4 coloured cubes around the sphere
- [ ] Add the "hidden" red cube positioned behind the default camera position
- [ ] Optional: load Utah teapot
- [ ] Verify cubemap reflections look correct on the sphere and floor
- [ ] Add the directional light

**Deliverable:** The complete static scene with cubemap reflections (this is "Mode 1: Cubemap"). It should already look good.

---

### Phase 3 — UI Framework (Week 3, ~3 days)

**Goal:** All UI controls functional, modes are stubs but switchable.

Tasks:
- [ ] HTML/CSS for the side panel layout
- [ ] Radio buttons for reflection modes
- [ ] Roughness slider (updates floor material in real time — works in cubemap mode immediately)
- [ ] Reset View / Look at Hidden Cube buttons
- [ ] Debug toggle stubs
- [ ] FPS / frame time displayed in real time
- [ ] About modal with placeholder content
- [ ] Tooltips on all controls

**Deliverable:** A polished UI where the cubemap mode and roughness slider work. Other modes show "Not implemented yet."

---

### Phase 4 — Planar Reflections (Week 4, ~4 days)

**Goal:** Mode 2 (Planar) fully implemented.

Tasks:
- [ ] Replace the floor `Mesh` with a `Reflector` from Three.js examples when in planar mode
- [ ] Configure the Reflector's resolution, color, recursion depth
- [ ] Handle roughness via post-blur on the reflector texture (since Reflector itself doesn't support roughness natively)
  - Render the reflection to an FBO at full resolution
  - Apply a blur pass with intensity proportional to roughness
  - Sample the blurred result in the floor shader
- [ ] Sphere should fall back to cubemap reflections (planar can't do curved)
- [ ] Mode switching: clean up Reflector when leaving planar mode
- [ ] Compare FPS — should be roughly half of cubemap mode

**Deliverable:** Switching to Planar mode shows a perfect mirror floor. Sphere uses cubemap. FPS roughly halved. Roughness slider works (with post-blur).

---

### Phase 5 — SSR Implementation (Weeks 5-7, ~10 days) — **THE BIG ONE**

**Goal:** Custom SSR shader working end-to-end.

This is the hardest part. Approach incrementally:

**Week 5 — G-Buffer Setup**
- [ ] Create a multi-target render pass that outputs: colour, view-space normal, view-space position (or depth), roughness/metalness
- [ ] Verify each render target by rendering it as a debug visualization
- [ ] Set up `EffectComposer` with a base render pass

**Week 6 — Core SSR Algorithm**
- [ ] Write the SSR fragment shader skeleton:
  - Read G-buffer textures
  - Compute reflection direction in view space
  - Project reflection ray endpoints into screen space
  - Linear ray march with fixed step size
  - Compare ray depth vs depth buffer at each step
  - Return hit colour or black if no hit
- [ ] Test with a simple smooth (roughness=0) floor — should see sharp reflections matching the planar version (within screen-space limits)
- [ ] Add binary refinement after coarse hit for sub-pixel accuracy
- [ ] Add edge fade (smoothly fade reflection strength as it approaches screen edges)

**Week 7 — Polish & Failure-Mode Demo**
- [ ] Roughness via cone tracing: sample blurred mip levels of the colour buffer
- [ ] SSR + cubemap fallback mode: blend cubemap into SSR result based on:
  - Distance from screen edge
  - Whether SSR found a valid hit
  - Surface roughness (high roughness → favor cubemap)
- [ ] **Verify the failure modes are visible:**
  - Off-screen objects missing from SSR ✓
  - Reflections cut off at screen edges ✓
  - Grazing angles produce banding ✓
- [ ] Implement debug visualizations:
  - Depth buffer overlay
  - SSR ray path visualization (optional)

**Deliverable:** All four modes working. SSR demonstrates its limitations clearly. SSR + Fallback mode looks production-quality.

**Reference for SSR implementation:**
- McGuire & Mara 2014 paper has GLSL pseudo-code: https://jcgt.org/published/0003/04/04/paper.pdf
- Three.js's built-in SSRPass source code as reference (don't copy wholesale — it's limited)
- Lots of open-source implementations to study

---

### Phase 6 — Polish & Final Touches (Week 8, ~5 days)

**Goal:** Project is presentable, GitHub repo is clean, README is comprehensive.

Tasks:
- [ ] Refine the About modal with full project description, references, and "try this" suggestions
- [ ] Test on Chrome, Firefox, Safari
- [ ] Optimize: ensure smooth 60fps in cubemap mode, ~30fps minimum in SSR mode
- [ ] Add loading screen for HDR environment (it can take a moment)
- [ ] Take screenshots/screen recordings for the README
- [ ] Write a comprehensive README with:
  - Project description
  - Live demo link
  - Screenshots
  - Mode-by-mode visual comparison
  - "How to run locally" instructions
  - References
  - Credits (Cem Yuksel courses, Three.js, Poly Haven, etc.)
- [ ] Code cleanup: comments, remove dead code, organize files

**Deliverable:** Project is ready to demo. GitHub repo is professional. URL works. README is informative.

---

### Phase 7 — Final Report (Week 8, parallel)

**Goal:** Written report describing implementation, results, and conclusions.

Tasks:
- [ ] Write the final report (separate from the midterm research report):
  - Implementation overview
  - Technical challenges and solutions
  - Performance comparison (numbers from the FPS counter)
  - Visual comparison (screenshots of each mode)
  - Discussion: what worked, what didn't, what was learned
  - Future work
- [ ] Match the academic style of the midterm report (APA 7)

---

## 9. Technical Deep-Dives

### 9.1 SSR Fragment Shader — Pseudo-Code Walk-Through

This is the heart of the project. Here's the algorithm in detail.

```glsl
// Inputs (uniforms)
uniform sampler2D tColor;        // Colour buffer from render pass
uniform sampler2D tDepth;        // Depth buffer
uniform sampler2D tNormal;       // View-space normals
uniform mat4 projectionMatrix;
uniform mat4 inverseProjectionMatrix;
uniform float maxDistance;       // Max SSR ray length (e.g. 50.0)
uniform float thickness;         // Hit tolerance (e.g. 0.5)
uniform int maxSteps;            // Max ray march iterations (e.g. 64)
uniform vec2 resolution;
uniform samplerCube envMap;      // For fallback
uniform float roughness;         // From G-buffer
uniform float metalness;         // From G-buffer

varying vec2 vUv;

void main() {
  // 1. Reconstruct view-space position from depth
  float depth = texture2D(tDepth, vUv).r;
  vec3 viewPos = reconstructViewPos(vUv, depth, inverseProjectionMatrix);
  
  // 2. Read normal in view space
  vec3 viewNormal = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
  
  // 3. Compute reflection direction in view space
  vec3 viewDir = normalize(viewPos);  // From camera (origin) to surface
  vec3 reflDir = reflect(viewDir, viewNormal);
  
  // 4. Compute ray start and end in view space
  vec3 rayStart = viewPos;
  vec3 rayEnd = viewPos + reflDir * maxDistance;
  
  // 5. Project both into screen space (NDC then UV)
  vec4 startClip = projectionMatrix * vec4(rayStart, 1.0);
  vec4 endClip = projectionMatrix * vec4(rayEnd, 1.0);
  vec2 startUV = (startClip.xy / startClip.w) * 0.5 + 0.5;
  vec2 endUV = (endClip.xy / endClip.w) * 0.5 + 0.5;
  
  // 6. Ray march along the screen-space line
  vec2 deltaUV = endUV - startUV;
  float steps = max(abs(deltaUV.x * resolution.x), abs(deltaUV.y * resolution.y));
  steps = min(steps, float(maxSteps));
  vec2 stepUV = deltaUV / steps;
  
  vec2 currentUV = startUV;
  float currentDepth = startClip.z / startClip.w;
  float depthStep = (endClip.z / endClip.w - currentDepth) / steps;
  
  bool hit = false;
  vec2 hitUV = vec2(0.0);
  
  for (float i = 0.0; i < float(maxSteps); i++) {
    if (i >= steps) break;
    
    currentUV += stepUV;
    currentDepth += depthStep;
    
    // Out of screen bounds → no hit (will use fallback)
    if (currentUV.x < 0.0 || currentUV.x > 1.0 ||
        currentUV.y < 0.0 || currentUV.y > 1.0) break;
    
    float sceneDepth = texture2D(tDepth, currentUV).r;
    
    // Convert ray's NDC depth to comparable form
    // (this requires care — depth buffer is non-linear)
    
    if (currentDepth > sceneDepth + thickness * sceneDepth) {
      // Hit!
      hit = true;
      hitUV = currentUV;
      // Optional: binary refinement for sub-pixel accuracy
      break;
    }
  }
  
  // 7. Compute reflection colour
  vec3 ssrColor = vec3(0.0);
  float ssrWeight = 0.0;
  
  if (hit) {
    // Read colour, possibly from a blurred mip level for roughness
    float mipLevel = roughness * 8.0;  // Cone tracing approximation
    ssrColor = textureLod(tColor, hitUV, mipLevel).rgb;
    
    // Edge fade
    vec2 edgeDistance = min(hitUV, 1.0 - hitUV);
    float fade = smoothstep(0.0, 0.1, min(edgeDistance.x, edgeDistance.y));
    ssrWeight = fade;
  }
  
  // 8. Cubemap fallback
  vec3 worldReflDir = (inverseViewMatrix * vec4(reflDir, 0.0)).xyz;
  vec3 envColor = textureCube(envMap, worldReflDir).rgb;
  
  // Mix SSR with cubemap based on weight
  vec3 reflectedColor = mix(envColor, ssrColor, ssrWeight);
  
  // 9. Apply Fresnel and combine with surface colour
  // (typically done in the main lighting shader, not here)
  
  gl_FragColor = vec4(reflectedColor, 1.0);
}
```

**Key gotchas:**
- Depth buffer values are non-linear (z/w with perspective). Comparison must account for this.
- View-space position reconstruction: a common bug source. Test with simple rendered visualizations.
- `thickness` parameter is critical — too small causes missed hits, too large causes false hits.
- The fade region should be at least 5-10% of screen size for smooth fallback.

### 9.2 G-Buffer Setup with Three.js

Three.js doesn't have a native G-buffer system, but you can build one using `WebGLMultipleRenderTargets` (or via separate render passes for older versions).

```javascript
// Modern approach (Three.js r147+)
const gBuffer = new THREE.WebGLMultipleRenderTargets(
  window.innerWidth,
  window.innerHeight,
  4  // 4 targets: color, normal, position, params (roughness/metalness)
);

// Set up the G-buffer materials with custom shaders that output to the targets
// OR use a custom RenderPass that writes to multiple targets

// Then in the SSR pass:
ssrPass.uniforms.tColor.value = gBuffer.texture[0];
ssrPass.uniforms.tNormal.value = gBuffer.texture[1];
ssrPass.uniforms.tDepth.value = gBuffer.depthTexture;  // Or via target[2]
```

### 9.3 Performance Tips

- **Lower SSR resolution:** Render SSR at half resolution and upscale — typically imperceptible quality loss, 4× speedup
- **Limit SSR ray steps:** 32-64 steps usually sufficient. More than that → diminishing returns.
- **Skip SSR for matte surfaces:** If roughness > 0.7, just use the cubemap. SSR contribution is invisible at high roughness.
- **Async HDR loading:** Show a loading screen while the HDR is being processed (PMREM generation takes a moment).

### 9.4 Browser Compatibility

- **Chrome/Edge:** Best WebGL 2 support; recommended target
- **Firefox:** Usually fine, occasional shader compilation differences
- **Safari:** Most restrictive; some WebGL 2 features may not work. Test early.
- **WebGPU:** Don't use — not universally supported as of 2026.

---

## 10. Acceptance Criteria

The project is "done" when all of these are true:

### 10.1 Functional Criteria

- [ ] Loads in under 5 seconds on a typical broadband connection
- [ ] All four reflection modes selectable via radio buttons (Hybrid RT shown as disabled)
- [ ] Roughness slider works in real time, all modes respond appropriately
- [ ] OrbitControls work smoothly
- [ ] Reset View and Look at Hidden Cube buttons work
- [ ] FPS counter is accurate and updates in real time
- [ ] About modal opens and contains accurate project info

### 10.2 Visual Criteria

- [ ] **Cubemap mode:** Smooth environment reflections; clear lack of parallax for nearby objects
- [ ] **Planar mode:** Perfect mirror-like floor reflection; sphere uses cubemap
- [ ] **SSR mode:** Contact reflections visible; off-screen objects clearly missing; edge fade present
- [ ] **SSR + Cubemap:** Smooth blend at edges; cubemap fills in where SSR fails
- [ ] **Failure modes demonstrable** by orbiting the camera

### 10.3 Performance Criteria

- [ ] Cubemap mode: 60 fps on a typical laptop
- [ ] Planar mode: 30+ fps
- [ ] SSR mode: 30+ fps with default settings
- [ ] No memory leaks across mode switches (run for 10+ minutes without issues)

### 10.4 Code Quality Criteria

- [ ] No console errors or warnings in normal operation
- [ ] Code is commented, especially the SSR shader
- [ ] File structure matches section 7.2
- [ ] README is comprehensive
- [ ] License file present

### 10.5 Academic Criteria

- [ ] Project demonstrates the four-technique progression narrative
- [ ] Visual differences between modes are clear and pedagogically meaningful
- [ ] About page links to the academic report and key papers
- [ ] Code references the appropriate papers in comments (e.g., "// SSR algorithm based on McGuire & Mara 2014")

---

## 11. Reference Materials

### 11.1 Papers (read in this order)

1. **McGuire & Mara (2014)** — *Efficient GPU Screen-Space Ray Tracing*
   PDF: https://jcgt.org/published/0003/04/04/paper.pdf
   Author's blog with code: http://casual-effects.blogspot.com/2014/08/screen-space-ray-tracing.html
   *(Most important — this paper is the SSR foundation)*

2. **Karis (2013)** — *Real Shading in Unreal Engine 4*
   Slides: https://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_slides.pdf
   Course notes: https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf
   *(For PBR cubemaps and split-sum)*

3. **Stachowiak (2015)** — *Stochastic Screen-Space Reflections*
   https://www.ea.com/frostbite/news/stochastic-screen-space-reflections
   *(For glossy/rough SSR)*

4. **Blinn & Newell (1976)** — *Texture and Reflection in Computer Generated Images*
   https://people.csail.mit.edu/ericchan/bib/pdf/p542-blinn.pdf
   *(Historical context — short read)*

### 11.2 Three.js Documentation

- Main docs: https://threejs.org/docs/
- Examples: https://threejs.org/examples/
- Specific examples to study:
  - `webgl_postprocessing_ssr` — built-in SSR (limited but useful reference)
  - `webgl_mirror` — basic Reflector usage
  - `webgl_postprocessing` — EffectComposer pipeline
  - `webgl_materials_envmaps_*` — cubemap and HDR examples
  - `webgl_pbr` — PBR materials with environment lighting

### 11.3 Books and Courses

- **Marschner & Shirley (2015)** — *Fundamentals of Computer Graphics*, 4th ed. — primary textbook
- **Pharr, Jakob & Humphreys** — *Physically Based Rendering* — deep dive (free online: https://pbr-book.org/)
- **Cem Yuksel's courses** (the playlists used in CENG510):
  - CS 4600 (Intro to CG): https://graphics.cs.utah.edu/courses/cs4600/fall2020/
  - CS 6610 (Interactive CG): https://graphics.cs.utah.edu/courses/cs6610/spring2021/

### 11.4 Open-Source Implementations to Study (NOT to copy wholesale)

- **Three.js SSRPass source:** https://github.com/mrdoob/three.js/blob/dev/examples/jsm/postprocessing/SSRPass.js
- **Babylon.js SSR module** (different engine, similar concepts)
- **Filament (Google)** — production-grade PBR renderer in C++/Java, valuable reference for technique selection
- **Stochastic SSR demo** by Olli Etuaho: https://h3.gd/stochastic-ssr/

### 11.5 Assets

- **HDR environments (CC0):** https://polyhaven.com/hdris
- **3D models (CC0):** https://polyhaven.com/models
- **Utah teapot** (any GLB/OBJ available online — it's classic CG)

---

## 12. Quick Decision Reference

When in doubt during implementation, consult these:

| Question | Answer |
|----------|--------|
| Should I write SSR from scratch or use Three.js's SSRPass? | Use SSRPass as a reference, but write your own — it gives you control and matches the academic spirit |
| Should I implement Hi-Z optimization? | Only if you have time after Phase 5. Linear/DDA is sufficient for the demo. |
| Should I support stochastic SSR for roughness? | No — cone tracing is simpler and good enough for the demo |
| Should I target mobile? | No — desktop browser only |
| Should I add WebXR/VR support? | No — out of scope |
| Should I implement multiple light sources? | One directional light + IBL is sufficient |
| Should the scene have animations? | Optional — a slowly rotating sphere or moving cube can make the demo more dynamic, but isn't required |
| Should I support saving/loading scene configurations? | No — fixed scene only |

---

## 13. Final Notes

This project is the practical conclusion of a deep research effort. The midterm report has already established the academic foundation; this implementation makes it tangible. The instructor has approved both the topic and the project idea — the goal now is execution.

**The core deliverable is not "a working SSR shader."** It is "a tool that makes the four-technique trade-off visible to anyone who runs it." Every implementation decision should be evaluated against that goal: does this make the differences clearer? Does this help tell the progression story? If yes, do it. If it's a distracting optimization or feature, skip it.

Good luck. Build the simplest version that demonstrates the concept, then add polish. The paper trail (this document, the research report, the academic report) is already strong — let the project speak for the work.

---

*Document version: 1.0 — Generated as project handoff for Claude Code implementation.*
*Project: CENG510 Real-Time Reflection Techniques Comparison Tool.*
*Author: Utku, MSc Computer Engineering, Çukurova University.*
*Instructor: Öğr. Gör. Yunus Emre Çogurcu.*