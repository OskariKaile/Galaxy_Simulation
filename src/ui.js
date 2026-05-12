// ============================================================
// ui.js
// All DOM wiring for the HUD: telemetry, settings, the inspector
// panel, and the projected "YOU ARE HERE" plaque on the Sun.
// ============================================================

import * as THREE from 'three';
import { fetchExoplanets, aliasesForStar } from './exoplanetAPI.js';

// 1 parsec ≈ 3.26156 light years
const PC_TO_LY = 3.26156;

const $ = (id) => document.getElementById(id);

export class UI {
  constructor({ camera, galaxy, controls }) {
    this.camera = camera;
    this.galaxy = galaxy;
    this.controls = controls;

    // Telemetry refs
    this.telX = $('telX');
    this.telY = $('telY');
    this.telZ = $('telZ');
    this.telDist = $('telDist');
    this.telVel = $('telVel');
    this.telFps = $('telFps');

    // Sun label
    this.solLabel = $('solLabel');
    this.solSub = this.solLabel.querySelector('.sol-label__sub');

    // Inspector
    this.inspector = $('inspector');
    this.iEyebrow = $('iEyebrow');
    this.iName = $('iName');
    this.iAlt = $('iAltName');
    this.iDist = $('iDist');
    this.iMag = $('iMag');
    this.iAbs = $('iAbs');
    this.iSpec = $('iSpec');
    this.iConst = $('iConst');
    this.iHip = $('iHip');
    this.iPlanets = $('iPlanets');
    this.iDividerLabel = $('iDividerLabel');

    $('inspectorClose').addEventListener('click', () => this.hideInspector());

    // Mode buttons
    this.modeButtons = document.querySelectorAll('.seg__btn');
    this.starCountEl = $('starCount');
    this.modeButtons.forEach(btn => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode, true));
    });

    // Auto toggle
    this.autoToggle = $('autoPerf');

    // Active inspector fetch controller (so we can cancel)
    this._inspectorAbort = null;

    // Active inspector star (so we don't refetch on rapid clicks)
    this._activeStarIndex = -1;
  }

  setMode(mode, fromUser) {
    this.galaxy.setTier(mode);
    this.modeButtons.forEach(b => b.classList.toggle('is-active', b.dataset.mode === mode));
    this.starCountEl.textContent = `${this.galaxy.visibleCount().toLocaleString()} stars rendered`;
    if (!fromUser) this._userDowngradedReason();
  }

  _userDowngradedReason() {
    this.starCountEl.style.color = 'var(--warn)';
    this.starCountEl.textContent =
      `${this.galaxy.visibleCount().toLocaleString()} stars · auto-downshift`;
    setTimeout(() => { this.starCountEl.style.color = ''; }, 4000);
  }

  autoModeEnabled() { return this.autoToggle.checked; }

  // ────────────────────────────────────────────────────────
  // Per-frame updates
  // ────────────────────────────────────────────────────────
  updateTelemetry(fps) {
    const p = this.camera.position;
    this.telX.textContent = (p.x >= 0 ? '+' : '') + p.x.toFixed(2) + ' pc';
    this.telY.textContent = (p.y >= 0 ? '+' : '') + p.y.toFixed(2) + ' pc';
    this.telZ.textContent = (p.z >= 0 ? '+' : '') + p.z.toFixed(2) + ' pc';

    const dist = p.distanceTo(this.galaxy.sunPos);
    this.telDist.textContent = (dist * PC_TO_LY).toFixed(2) + ' ly';

    const mult = this.controls.currentSpeedMultiplier();
    this.telVel.textContent = `${this.controls.cruise.toFixed(1)} pc/s ×${mult}`;
    this.telFps.textContent = fps.toFixed(0) + ' fps';
  }

  /** Project the Sun's world position to screen coords for the plaque. */
  updateSolLabel(renderer) {
    const v = this.galaxy.sunPos.clone();
    v.project(this.camera);

    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;

    // Hide if behind camera or off-screen
    const behind = v.z > 1;
    const off = x < -200 || x > w + 200 || y < -100 || y > h + 100;

    if (behind || off) {
      this.solLabel.hidden = true;
      return;
    }
    this.solLabel.hidden = false;
    this.solLabel.style.left = x + 'px';
    this.solLabel.style.top  = y + 'px';

    const dist = this.camera.position.distanceTo(this.galaxy.sunPos);
    this.solSub.textContent =
      dist < 0.01 ? '0.000 ly · home star'
                  : `${(dist * PC_TO_LY).toFixed(2)} ly · home star`;
  }

  // ────────────────────────────────────────────────────────
  // Inspector
  // ────────────────────────────────────────────────────────
  hideInspector() {
    this.inspector.hidden = true;
    this._activeStarIndex = -1;
    if (this._inspectorAbort) { this._inspectorAbort.abort(); this._inspectorAbort = null; }
  }

  showInspector(star) {
    if (!star) return;
    if (star.i === this._activeStarIndex) return;
    this._activeStarIndex = star.i;

    this.inspector.hidden = false;
    this.inspector.scrollTop = 0;

    this.iEyebrow.textContent =
      star.spect ? `STELLAR · ${star.spect}` : 'STELLAR · OBJECT';
    this.iName.textContent = star.name || 'Unnamed star';

    const altParts = [];
    if (star.bf && star.bf !== star.name) altParts.push(star.bf);
    if (star.hip) altParts.push('HIP ' + star.hip);
    this.iAlt.textContent = altParts.join(' · ');

    this.iDist.textContent = star.dist != null
      ? `${star.dist.toFixed(2)} pc · ${(star.dist * PC_TO_LY).toFixed(2)} ly`
      : '—';
    this.iMag.textContent = star.mag != null ? star.mag.toFixed(2) : '—';
    this.iAbs.textContent = star.absmag != null ? star.absmag.toFixed(2) : '—';
    this.iSpec.textContent = star.spect || '—';
    this.iConst.textContent = star.con || '—';
    this.iHip.textContent =
      (star.hip ? 'HIP ' + star.hip : '') +
      (star.hd ? (star.hip ? ' · ' : '') + 'HD ' + star.hd : '') || '—';

    // Sol: skip API, show hardcoded solar system
    const isSol = star.id === 0 || star.dist === 0;
    if (isSol) {
      if (this._inspectorAbort) { this._inspectorAbort.abort(); this._inspectorAbort = null; }
      this.iDividerLabel.textContent = 'SOLAR · SYSTEM';
      this.renderSolarSystem();
      return;
    }

    this.iDividerLabel.textContent = 'EXOPLANETARY · DATA';

    // Fetch exoplanets
    if (this._inspectorAbort) this._inspectorAbort.abort();
    this._inspectorAbort = new AbortController();

    this.iPlanets.innerHTML =
      '<div class="planets__state">Querying NASA Exoplanet Archive…</div>';

    fetchExoplanets(star, { signal: this._inspectorAbort.signal })
      .then(({ planets, aliases }) => {
        if (this._activeStarIndex !== star.i) return; // user moved on
        this.renderPlanets(planets, aliases);
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        if (this._activeStarIndex !== star.i) return;
        this.iPlanets.innerHTML =
          `<div class="planets__state">Lookup failed: ${err.message}</div>`;
      });
  }

  renderSolarSystem() {
    const planets = [
      { name: 'Mercury', periodDays: 87.97,    radiusEarth: 0.38,  massEarth: 0.055,   smaxisAU: 0.387,  tempK: 440  },
      { name: 'Venus',   periodDays: 224.70,   radiusEarth: 0.95,  massEarth: 0.815,   smaxisAU: 0.723,  tempK: 737  },
      { name: 'Earth',   periodDays: 365.25,   radiusEarth: 1.00,  massEarth: 1.000,   smaxisAU: 1.000,  tempK: 288  },
      { name: 'Mars',    periodDays: 686.97,   radiusEarth: 0.53,  massEarth: 0.107,   smaxisAU: 1.524,  tempK: 210  },
      { name: 'Jupiter', periodDays: 4332.59,  radiusEarth: 11.21, massEarth: 317.8,   smaxisAU: 5.203,  tempK: 165  },
      { name: 'Saturn',  periodDays: 10759.22, radiusEarth: 9.45,  massEarth: 95.2,    smaxisAU: 9.537,  tempK: 134  },
      { name: 'Uranus',  periodDays: 30688.50, radiusEarth: 4.01,  massEarth: 14.5,    smaxisAU: 19.191, tempK: 76   },
      { name: 'Neptune', periodDays: 60182.00, radiusEarth: 3.88,  massEarth: 17.1,    smaxisAU: 30.069, tempK: 72   },
    ];

    const fmt = (v, digits = 2, suffix = '') =>
      v == null ? '—' : v.toFixed(digits) + suffix;

    this.iPlanets.innerHTML = planets.map(p => `
      <div class="planet">
        <div class="planet__name">${p.name}</div>
        <div class="planet__grid">
          <span>Orbital period</span><b>${fmt(p.periodDays, 2, ' d')}</b>
          <span>Radius</span><b>${fmt(p.radiusEarth, 2, ' R⊕')}</b>
          <span>Mass</span><b>${fmt(p.massEarth, 3, ' M⊕')}</b>
          <span>Semi-major axis</span><b>${fmt(p.smaxisAU, 3, ' AU')}</b>
          <span>Avg. temperature</span><b>${fmt(p.tempK, 0, ' K')}</b>
        </div>
      </div>
    `).join('');
  }

  renderPlanets(planets, aliases) {
    if (!planets.length) {
      this.iPlanets.innerHTML = `
        <div class="planets__state">
          No confirmed exoplanets on record for this star.<br>
          <span style="color:var(--ink-faint)">Searched: ${aliases.slice(0, 3).join(', ') || 'no aliases'}</span>
        </div>`;
      return;
    }

    const fmt = (v, digits = 2, suffix = '') =>
      v == null || !isFinite(v) ? '—' : v.toFixed(digits) + suffix;

    this.iPlanets.innerHTML = planets.map(p => `
      <div class="planet">
        <div class="planet__name">${p.name || '—'}</div>
        <div class="planet__grid">
          <span>Discovered</span><b>${p.year ?? '—'} · ${p.method || '—'}</b>
          <span>Orbital period</span><b>${fmt(p.periodDays, 2, ' d')}</b>
          <span>Radius</span><b>${fmt(p.radiusEarth, 2, ' R⊕')}</b>
          <span>Mass</span><b>${fmt(p.massEarth, 2, ' M⊕')}</b>
          <span>Semi-major axis</span><b>${fmt(p.smaxisAU, 3, ' AU')}</b>
          <span>Eq. temperature</span><b>${fmt(p.tempK, 0, ' K')}</b>
        </div>
      </div>
    `).join('');
  }
}
