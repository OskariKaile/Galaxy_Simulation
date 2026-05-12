// ============================================================
// main.js — entry point
// ============================================================

import * as THREE from 'three';
import { loadHYGCatalog } from './starData.js';
import { Galaxy, TIERS }   from './galaxy.js';
import { FlightControls }  from './controls.js';
import { PerformanceMonitor } from './performance.js';
import { UI } from './ui.js';

// ────────────────────────────────────────────────────────────
// 1. Bootstrap loading screen
// ────────────────────────────────────────────────────────────
const bootEl      = document.getElementById('boot');
const bootFill    = document.getElementById('bootFill');
const bootStatus  = document.getElementById('bootStatus');

function setBootProgress(p) {
  bootFill.style.right = ((1 - p) * 100).toFixed(2) + '%';
}
function setBootStatus(msg) { bootStatus.textContent = msg; }

async function main() {
  let catalog;
  try {
    catalog = await loadHYGCatalog({
      onProgress: p => setBootProgress(0.85 * p),
      onStatus:   s => setBootStatus(s),
    });
  } catch (err) {
    console.error(err);
    setBootStatus('CATALOG UNREACHABLE — CHECK NETWORK');
    bootFill.style.background = 'var(--warn)';
    return;
  }

  // 2. Set up renderer
  setBootStatus('INITIALIZING WEBGL');
  setBootProgress(0.9);
  await new Promise(r => requestAnimationFrame(r));

  const canvas = document.getElementById('stage');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,         // additive blending hides aliasing already
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x04060a, 1);

  // 3. Scene + camera
  const scene = new THREE.Scene();
  scene.fog = null; // do NOT fog stars — they're meant to be visible at distance

  const camera = new THREE.PerspectiveCamera(
    65,
    window.innerWidth / window.innerHeight,
    0.01,
    100000,
  );

  // Start the camera slightly above the Sun, looking toward the galactic center.
  // In HYG coordinates, the galactic center is roughly at (-8000 pc, 0, 0).
  camera.position.set(0, 0.3, 1.5);
  camera.lookAt(-1, 0, 0);

  // 4. Galaxy
  const galaxy = new Galaxy(catalog);
  scene.add(galaxy.points);

  // Faint reference grid that hints at the galactic plane.
  // (Stylistic — does not encode any data.)
  const grid = new THREE.GridHelper(2000, 40, 0x0a2a3a, 0x081820);
  grid.position.y = 0;
  grid.material.transparent = true;
  grid.material.opacity = 0.12;
  scene.add(grid);

  // 5. Controls
  const controls = new FlightControls(camera, canvas);
  controls.setCruise(2);

  // 6. UI
  const ui = new UI({ camera, galaxy, controls });
  ui.setMode('med', false);
  ui.starCountEl.textContent = `${galaxy.visibleCount().toLocaleString()} stars rendered`;

  controls.onCruiseChange = () => ui.updateTelemetry(perf.fps());

  // 7. Perf monitor
  const perf = new PerformanceMonitor({ lowFps: 30, holdMs: 2500 });
  perf.onDownshift = (fps) => {
    if (!ui.autoModeEnabled()) return;
    // Step down one tier
    const order = ['high', 'med', 'low'];
    const idx = order.indexOf(galaxy.tier);
    if (idx < order.length - 1) {
      console.warn(`[perf] ${fps.toFixed(0)} fps → downshift to ${order[idx + 1]}`);
      ui.setMode(order[idx + 1], false);
    }
  };

  // 8. Picking — screen-space nearest within radius, brightness-weighted
  const tmpV = new THREE.Vector3();

  function pickStar(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const ndcX = ((clientX - rect.left) / w) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / h) * 2 - 1);

    const positions = galaxy.geometry.attributes.position.array;
    const stars     = galaxy.reorderedStars;
    const mags      = galaxy.reorderedMags;

    const N = galaxy.visibleCount();
    let best = -1;
    let bestScore = Infinity;

    // Tolerance in NDC units: about 25 px on a 1080p screen.
    const tolerance = 60 / Math.min(w, h);

    for (let i = 0; i < N; i++) {
      tmpV.set(
        positions[i * 3],
        positions[i * 3 + 1],
        positions[i * 3 + 2],
      ).project(camera);

      if (tmpV.z < -1 || tmpV.z > 1) continue;

      const dx = tmpV.x - ndcX;
      const dy = tmpV.y - ndcY;
      const d  = Math.hypot(dx, dy);
      if (d > tolerance) continue;

      // Prefer brighter (lower mag) and closer to cursor.
      const score = d + mags[i] * 0.002;
      if (score < bestScore) { bestScore = score; best = i; }
    }

    return best >= 0 ? stars[best] : null;
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // We pick on mouseup if the user didn't drag much — that way
    // mouse-look (when locked) and click-to-inspect don't conflict.
    canvas._downX = e.clientX;
    canvas._downY = e.clientY;
    canvas._downT = performance.now();
  });
  canvas.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (controls.locked) {
      // In flight mode, center-of-screen click → pick at crosshair
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const t = performance.now() - (canvas._downT || 0);
      if (t < 350) {
        const star = pickStar(cx, cy);
        if (star) ui.showInspector(star);
      }
      return;
    }
    // Free mode (pre-lock or after Esc)
    const dx = Math.abs(e.clientX - (canvas._downX || 0));
    const dy = Math.abs(e.clientY - (canvas._downY || 0));
    if (dx + dy > 6) return; // it was a drag, ignore
    const star = pickStar(e.clientX, e.clientY);
    if (star) ui.showInspector(star);
  });

  // 9. Resize
  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const pr = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    galaxy.setPixelRatio(pr);
  });

  // 10. Animation loop
  setBootProgress(1);
  setBootStatus('READY');
  bootEl.classList.add('is-done');
  document.getElementById('solLabel').hidden = false;

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    controls.update(dt);
    galaxy.update(dt);
    perf.tick(dt);

    renderer.render(scene, camera);

    ui.updateTelemetry(perf.fps());
    ui.updateSolLabel(renderer);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 11. Keyboard quick-actions outside FlightControls
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ui.hideInspector();
  });

  // Expose for debugging in DevTools
  window.HELIOS = { renderer, scene, camera, galaxy, controls, perf, ui, catalog };
}

main();
