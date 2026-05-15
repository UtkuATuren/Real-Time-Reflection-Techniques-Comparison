// UI wiring — pulls DOM elements and exposes a small event API. The render
// loop and mode dispatcher live in main.js; this module is purely the bridge
// between the side panel/HTML and the rest of the app.

const $ = (sel) => document.querySelector(sel);

const METHOD_INFO = {
  cubemap: {
    badge: 'Cubemap',
    title: 'Cubemap',
    how: 'The material samples a prefiltered environment map using the reflected view direction. It is very fast because the shader reads one texture, but nearby scene objects are not really traced.',
    try: 'Orbit around the sphere and compare the cube positions against the reflection. The highlights stay plausible, but local objects do not line up with true parallax.',
  },
  planar: {
    badge: 'Planar',
    title: 'Planar reflection',
    how: 'A mirrored camera renders the scene from below the floor into a texture, then the floor projects that texture back onto itself. It is accurate for flat mirrors but costs another scene render.',
    try: 'Watch the floor around the cubes and pillars. Enable side mirrors to turn one planar reflection pass into three and compare the frame time.',
  },
  ssr: {
    badge: 'SSR',
    title: 'Screen-space reflections',
    how: 'The shader uses the already-rendered color, depth, and normal buffers. For reflective pixels it marches a ray through screen space and samples the color where the ray hits visible geometry.',
    try: 'Move objects toward a screen edge or enable the hit mask. Add side mirrors to see which reflected details SSR can only recover while they are visible on screen.',
  },
  ssrFallback: {
    badge: 'SSR + fallback',
    title: 'SSR with cubemap fallback',
    how: 'This mode keeps SSR where the ray finds visible scene geometry, then blends in the environment map when the ray misses or fades near unreliable screen edges.',
    try: 'Compare it with pure SSR while orbiting or after adding side mirrors. Reflections look less broken near misses, but the filled-in parts are approximate environment reflections.',
  },
};

export function bindUI({
  onModeChange,
  onRoughnessChange,
  onExtraReflectorsChange,
  onCameraReset,
  onLookAtHidden,
  onDebugToggle,
}) {
  // Mode radios
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (!e.target.checked || e.target.disabled) return;
      setMethodInfo(e.target.value);
      onModeChange?.(e.target.value);
    });
  });
  setMethodInfo(document.querySelector('input[name="mode"]:checked')?.value ?? 'cubemap');

  // Roughness slider — also updates its <output> readout in real time.
  const slider = $('#roughness');
  const readout = $('#roughnessValue');
  const updateSlider = () => {
    const v = parseFloat(slider.value);
    readout.textContent = v.toFixed(2);
    onRoughnessChange?.(v);
  };
  slider.addEventListener('input', updateSlider);
  updateSlider();

  // Extra reflective surfaces
  const extraReflectors = $('#extraReflectors');
  const updateExtraReflectors = () => {
    onExtraReflectorsChange?.(Boolean(extraReflectors?.checked));
  };
  extraReflectors?.addEventListener('change', updateExtraReflectors);
  updateExtraReflectors();

  // Camera buttons
  $('#resetView')?.addEventListener('click', () => onCameraReset?.());
  $('#lookAtHidden')?.addEventListener('click', () => onLookAtHidden?.());

  // Shader debug toggles are mutually exclusive; the off-screen indicator is
  // a separate overlay and can stay enabled with either shader view.
  const shaderDebugInputs = {
    depth: $('#showDepth'),
    hits: $('#showRays'),
  };
  for (const [kind, input] of Object.entries(shaderDebugInputs)) {
    input?.addEventListener('change', (e) => {
      if (e.target.checked) {
        for (const [otherKind, otherInput] of Object.entries(shaderDebugInputs)) {
          if (otherKind !== kind && otherInput) otherInput.checked = false;
        }
      }
      onDebugToggle?.(kind, e.target.checked);
    });
  }
  $('#showOffscreen')?.addEventListener('change', (e) => onDebugToggle?.('offscreen', e.target.checked));

  // About modal
  bindModal();
}

function bindModal() {
  const modal = document.getElementById('aboutModal');
  const openBtn = document.getElementById('aboutBtn');
  if (!modal || !openBtn) return;

  const open = () => {
    modal.hidden = false;
    document.addEventListener('keydown', onKey);
  };
  const close = () => {
    modal.hidden = true;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  openBtn.addEventListener('click', open);
  modal.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', close);
  });
}

export function setPerf({ fps, frameMs }) {
  const fpsEls = document.querySelectorAll('#fpsValue, #fpsMetric');
  const frameEls = document.querySelectorAll('#frameValue, #frameMetric');
  for (const el of fpsEls) el.textContent = fps.toFixed(0);
  for (const el of frameEls) el.textContent = frameMs.toFixed(1);
}

export function setSSRTime(ms) {
  const el = document.getElementById('ssrMetric');
  if (el) el.textContent = ms == null ? '—' : ms.toFixed(2);
}

export function hideLoadingOverlay() {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  // Remove from DOM after the fade completes so it doesn't intercept events.
  setTimeout(() => overlay.remove(), 500);
}

function setMethodInfo(mode) {
  const info = METHOD_INFO[mode] ?? METHOD_INFO.cubemap;
  const badge = document.getElementById('methodInfoBadge');
  const title = document.getElementById('methodInfoTitle');
  const how = document.getElementById('methodInfoHow');
  const tryText = document.getElementById('methodInfoTry');

  if (badge) badge.textContent = info.badge;
  if (title) title.textContent = info.title;
  if (how) how.textContent = info.how;
  if (tryText) tryText.textContent = info.try;
}
