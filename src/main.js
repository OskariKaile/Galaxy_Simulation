// ============================================================
// main.js — entry point
// ============================================================

import * as THREE from 'three';
import { loadHYGCatalog } from './starData.js';
import { Galaxy, TIERS }   from './galaxy.js';
import { FlightControls }  from './controls.js';
import { PerformanceMonitor } from './performance.js';
import { UI } from './ui.js';
import { fetchAllHostStars } from './exoplanetAPI.js';

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
  const SOL_POS  = new THREE.Vector3(0, 0.3, 1.5);
  const SOL_LOOK = new THREE.Vector3(-1, 0, 0);
  camera.position.copy(SOL_POS);
  camera.lookAt(SOL_LOOK);
  const SOL_QUAT = camera.quaternion.clone();

  // 4. Galaxy
  const galaxy = new Galaxy(catalog);
  scene.add(galaxy.points);
  scene.add(galaxy.highlight);


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

      if (!galaxy.isStarShown(i)) continue;

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

  // 11. Exoplanets-only filter button
  const exoBtn = document.getElementById('exoFilter');

  // Build lookup maps from the reordered HYG stars once.
  function buildLookup() {
    const byHD  = new Map();
    const byHIP = new Map();
    const byName = new Map();
    for (const s of galaxy.reorderedStars) {
      if (s.hd)     byHD.set(parseInt(s.hd),   s.i);
      if (s.hip)    byHIP.set(parseInt(s.hip),  s.i);
      if (s.proper) byName.set(s.proper.toLowerCase().replace(/\s+/g, ''), s.i);
      if (s.bf)     byName.set(s.bf.toLowerCase().replace(/\s+/g, ''),     s.i);
    }
    return { byHD, byHIP, byName };
  }

  function matchHostname(hostname, lookup) {
    const h = hostname.trim();
    const hd  = h.match(/^HD\s*(\d+)/i);
    if (hd)  return lookup.byHD.get(parseInt(hd[1]))  ?? -1;
    const hip = h.match(/^HIP\s*(\d+)/i);
    if (hip) return lookup.byHIP.get(parseInt(hip[1])) ?? -1;
    return lookup.byName.get(h.toLowerCase().replace(/\s+/g, '')) ?? -1;
  }

  exoBtn.addEventListener('click', async () => {
    // Toggle off
    if (galaxy.isFiltered()) {
      galaxy.clearFilter();
      exoBtn.classList.remove('is-active');
      exoBtn.textContent = 'EXOPLANETS ONLY';
      return;
    }

    exoBtn.classList.add('is-loading');
    exoBtn.textContent = 'LOADING…';

    try {
      const hostnames = await fetchAllHostStars();
      const lookup    = buildLookup();
      const visible   = new Set();

      for (const name of hostnames) {
        const idx = matchHostname(name, lookup);
        if (idx >= 0) visible.add(idx);
      }

      // Always keep Sol visible
      if (galaxy.sunIndex >= 0) visible.add(galaxy.sunIndex);

      galaxy.setFilter(visible);
      exoBtn.classList.remove('is-loading');
      exoBtn.classList.add('is-active');
      exoBtn.textContent = `EXOPLANETS ONLY · ${visible.size}`;
    } catch (err) {
      exoBtn.classList.remove('is-loading');
      exoBtn.textContent = 'FETCH FAILED — RETRY';
      setTimeout(() => { exoBtn.textContent = 'EXOPLANETS ONLY'; }, 3000);
    }
  });

  // 12. Return to Sol button
  const returnBtn = document.getElementById('returnToSol');
  returnBtn.addEventListener('click', () => {
    returnBtn.classList.add('is-flying');
    controls.exitLock();
    controls.flyTo(SOL_POS, SOL_QUAT);
    controls.onFlyDone = () => {
      returnBtn.classList.remove('is-flying');
      controls.onFlyDone = null;
    };
  });

  // 12. Legend key lighting
  const kbdMap = new Map();
  document.querySelectorAll('kbd[data-key]').forEach(el => {
    el.dataset.key.split(' ').forEach(code => {
      if (!kbdMap.has(code)) kbdMap.set(code, []);
      kbdMap.get(code).push(el);
    });
  });
  window.addEventListener('keydown', e => {
    kbdMap.get(e.code)?.forEach(el => el.classList.add('is-pressed'));
  });
  window.addEventListener('keyup', e => {
    kbdMap.get(e.code)?.forEach(el => el.classList.remove('is-pressed'));
  });

  const clickKbd = document.getElementById('kbdClick');
  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) clickKbd?.classList.add('is-pressed');
  });
  window.addEventListener('mouseup', e => {
    if (e.button === 0) clickKbd?.classList.remove('is-pressed');
  });

  // 13. Keyboard quick-actions outside FlightControls
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ui.hideInspector();
  });

  // Expose for debugging in DevTools
  window.HELIOS = { renderer, scene, camera, galaxy, controls, perf, ui, catalog };
}

main();
