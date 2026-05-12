// ============================================================
// galaxy.js
// Builds the THREE.Points cloud for the star catalog and a
// custom GLSL shader that gives each star a soft, color-tinted
// glow with proper distance attenuation.
// ============================================================

import * as THREE from 'three';

const VERT = /* glsl */`
  attribute float aSize;
  attribute vec3  aColor;
  attribute float aMag;
  attribute float aPhase;
  attribute float aShow;

  uniform float uPixelRatio;
  uniform float uSizeScale;
  uniform float uTime;

  varying vec3  vColor;
  varying float vMag;
  varying float vShow;

  void main() {
    vColor = aColor;
    vMag   = aMag;
    vShow  = aShow;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = -mvPosition.z;

    float size = aSize * uSizeScale * (300.0 / max(dist, 1.0));
    size = clamp(size, 1.0, 60.0);

    float twinkle = 0.85 + 0.15 * sin(uTime * 2.0 + aPhase * 6.2831);
    size *= twinkle;

    gl_PointSize = size * uPixelRatio * aShow;
    gl_Position  = projectionMatrix * mvPosition;
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  varying vec3  vColor;
  varying float vMag;
  varying float vShow;

  void main() {
    if (vShow < 0.5) discard;

    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv);

    float core = smoothstep(0.5, 0.0, r);
    float halo = exp(-r * 7.0);
    float alpha = core * 0.85 + halo * 0.55;

    if (alpha < 0.01) discard;

    float bright = clamp(1.5 - vMag * 0.18, 0.35, 1.4);
    vec3 col = vColor * bright;
    col = mix(col, vec3(1.0), pow(core, 4.0) * 0.4);

    gl_FragColor = vec4(col, alpha);
  }
`;

const HIGHLIGHT_VERT = /* glsl */`
  uniform float uPixelRatio;
  uniform float uTime;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = -mvPosition.z;

    float pulse = 1.0 + 0.18 * sin(uTime * 2.8);
    float size  = (700.0 / max(dist, 1.0)) * pulse;
    size = clamp(size, 18.0, 180.0);

    gl_PointSize = size * uPixelRatio;
    gl_Position  = projectionMatrix * mvPosition;
  }
`;

const HIGHLIGHT_FRAG = /* glsl */`
  precision highp float;
  uniform float uTime;

  void main() {
    vec2  uv = gl_PointCoord - 0.5;
    float r  = length(uv);

    // Thin ring centred at r = 0.38
    float ring  = exp(-pow((r - 0.38) * 14.0, 2.0));
    // Faint inner fill so the star is obviously circled
    float fill  = smoothstep(0.38, 0.0, r) * 0.12;
    float alpha = ring * 0.9 + fill;

    if (alpha < 0.01) discard;

    gl_FragColor = vec4(0.992, 0.478, 0.2, alpha); // amber
  }
`;

// Magnitude thresholds for performance tiers.
export const TIERS = {
  high: { magCap: 99,  label: 'HIGH' },     // everything
  med:  { magCap: 7.5, label: 'MED'  },     // about 25k stars
  low:  { magCap: 5.5, label: 'LOW'  },     // about 5k stars
};

export class Galaxy {
  constructor(catalog) {
    this.catalog = catalog;
    this.tier = 'med';

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uSizeScale:  { value: 1.0 },
        uTime:       { value: 0 },
      },
      vertexShader:   VERT,
      fragmentShader: FRAG,
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    // We pre-build the geometry from the full catalog and use a
    // draw range when switching tiers. We sort stars by apparent
    // magnitude (brightest first) so a draw range of N gives the
    // N brightest stars — the right behavior for "low" mode.
    this._buildGeometry();

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.setTier('med');

    this._buildHighlight();
  }

  _buildHighlight() {
    this._highlightMat = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uTime:       { value: 0 },
      },
      vertexShader:   HIGHLIGHT_VERT,
      fragmentShader: HIGHLIGHT_FRAG,
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    this._highlightGeo = new THREE.BufferGeometry();
    this._highlightGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(3), 3),
    );

    this.highlight = new THREE.Points(this._highlightGeo, this._highlightMat);
    this.highlight.frustumCulled = false;
    this.highlight.visible = false;
  }

  setHighlight(starIndex) {
    const arr = this.geometry.attributes.position.array;
    const pos = this._highlightGeo.attributes.position.array;
    pos[0] = arr[starIndex * 3];
    pos[1] = arr[starIndex * 3 + 1];
    pos[2] = arr[starIndex * 3 + 2];
    this._highlightGeo.attributes.position.needsUpdate = true;
    this.highlight.visible = true;
  }

  clearHighlight() {
    this.highlight.visible = false;
  }

  _buildGeometry() {
    const { count, positions, colors, sizes, mags, stars } = this.catalog;

    // Build an index of stars sorted by brightness (lowest mag first).
    const order = new Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    order.sort((a, b) => mags[a] - mags[b]);

    // Re-arrange the attribute arrays into brightness order so that
    // draw ranges from 0..N produce the N brightest stars.
    const pos2  = new Float32Array(count * 3);
    const col2  = new Float32Array(count * 3);
    const siz2  = new Float32Array(count);
    const mag2  = new Float32Array(count);
    const phase = new Float32Array(count);
    const reorderedStars = new Array(count);

    for (let i = 0; i < count; i++) {
      const j = order[i];
      pos2[i * 3]     = positions[j * 3];
      pos2[i * 3 + 1] = positions[j * 3 + 1];
      pos2[i * 3 + 2] = positions[j * 3 + 2];
      col2[i * 3]     = colors[j * 3];
      col2[i * 3 + 1] = colors[j * 3 + 1];
      col2[i * 3 + 2] = colors[j * 3 + 2];
      siz2[i]         = sizes[j];
      mag2[i]         = mags[j];
      phase[i]        = Math.random();
      reorderedStars[i] = stars[j];
      reorderedStars[i].i = i; // update index to reflect new position
    }

    this.reorderedStars = reorderedStars;
    this.reorderedMags  = mag2;

    // Find the (new) index of the Sun
    this.sunIndex = reorderedStars.findIndex(s => s.dist === 0 || s.id === 0);
    if (this.sunIndex >= 0) {
      this.sunPos = new THREE.Vector3(
        pos2[this.sunIndex * 3],
        pos2[this.sunIndex * 3 + 1],
        pos2[this.sunIndex * 3 + 2],
      );
    } else {
      this.sunPos = new THREE.Vector3(0, 0, 0);
    }

    this._showAttr = new Float32Array(count).fill(1);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
    g.setAttribute('aColor',   new THREE.BufferAttribute(col2, 3));
    g.setAttribute('aSize',    new THREE.BufferAttribute(siz2, 1));
    g.setAttribute('aMag',     new THREE.BufferAttribute(mag2, 1));
    g.setAttribute('aPhase',   new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aShow',    new THREE.BufferAttribute(this._showAttr, 1));
    this.geometry = g;
  }

  /** Show only stars whose reordered index is in the Set. */
  setFilter(visibleSet) {
    const arr = this._showAttr;
    for (let i = 0; i < arr.length; i++) {
      arr[i] = visibleSet.has(i) ? 1 : 0;
    }
    this.geometry.attributes.aShow.needsUpdate = true;
    this._filtered = true;
  }

  clearFilter() {
    this._showAttr.fill(1);
    this.geometry.attributes.aShow.needsUpdate = true;
    this._filtered = false;
  }

  isFiltered() { return !!this._filtered; }

  isStarShown(i) { return this._showAttr[i] > 0.5; }

  /** Switch performance tier — high/med/low. */
  setTier(tier) {
    if (!TIERS[tier]) return;
    this.tier = tier;
    const cap = TIERS[tier].magCap;

    // Binary search for the boundary in the sorted magnitude array.
    const mags = this.reorderedMags;
    let lo = 0, hi = mags.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mags[mid] <= cap) lo = mid + 1;
      else hi = mid;
    }
    this.geometry.setDrawRange(0, lo);
    this.activeCount = lo;
  }

  /** Per-frame update. */
  update(dt) {
    this.material.uniforms.uTime.value += dt;
    this._highlightMat.uniforms.uTime.value += dt;
  }

  /** Resize hook — update pixel ratio for the size shader. */
  setPixelRatio(pr) {
    this.material.uniforms.uPixelRatio.value = pr;
  }

  /** Returns the visible (drawn) count given the current tier. */
  visibleCount() { return this.activeCount; }
}
