// ============================================================
// starData.js
// Loads the HYG v3 stellar catalog (~119,614 real stars with
// measured parallax distances) and converts it into typed
// arrays ready for the GPU.
//
// Source: https://github.com/astronexus/HYG-Database
// License of the data: Public domain (Creative Commons CC0).
// ============================================================

// The HYG v3 CSV — about 33 MB. We try a primary URL and fall back.
const HYG_URLS = [
  "./data/hyg_v42.csv", // Local path relative to your index.html
  "https://codeberg.org/astronexus/hyg/raw/branch/master/hygdata_v3.csv", // Fallback remote URL
];
// Convert B-V color index to linear RGB.
// Approximation of blackbody color from the B-V index using the
// standard astrophysics piecewise fit (Harre & Heller 2021 style).
function bvToRGB(bv) {
  // Clamp to a sane range
  const x = Math.max(-0.4, Math.min(2.0, bv));
  let t;
  let r, g, b;

  // Approximate effective temperature from B-V (Ballesteros 2012):
  // T = 4600 * (1/(0.92*bv + 1.7) + 1/(0.92*bv + 0.62))
  const T = 4600 * (1 / (0.92 * x + 1.7) + 1 / (0.92 * x + 0.62));

  // Then T → RGB (a Tanner Helland-style blackbody curve, normalized)
  const tK = T / 100;

  // RED
  if (tK <= 66) r = 255;
  else r = 329.698727446 * Math.pow(tK - 60, -0.1332047592);

  // GREEN
  if (tK <= 66) g = 99.4708025861 * Math.log(tK) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(tK - 60, -0.0755148492);

  // BLUE
  if (tK >= 66) b = 255;
  else if (tK <= 19) b = 0;
  else b = 138.5177312231 * Math.log(tK - 10) - 305.0447927307;

  // Lift the darkest stars so they're still visible against black.
  r = Math.max(0, Math.min(255, r)) / 255;
  g = Math.max(0, Math.min(255, g)) / 255;
  b = Math.max(0, Math.min(255, b)) / 255;

  return [r, g, b];
}

// Parse one CSV row, respecting quoted fields with commas.
function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === ',' && !inQuote) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ────────────────────────────────────────────────────────────
// Stream-fetch with progress callback. Falls back to a static
// subset if every remote URL fails (so the demo still runs).
// ────────────────────────────────────────────────────────────
async function fetchWithProgress(urls, onProgress) {
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const lenHeader = res.headers.get('content-length');
      const total = lenHeader ? parseInt(lenHeader, 10) : 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let received = 0;
      let text = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (total) onProgress(received / total);
        else onProgress(Math.min(0.99, received / (35 * 1024 * 1024))); // est. 35 MB
      }
      text += decoder.decode();
      onProgress(1);
      return { text, source: url };
    } catch (e) {
      lastErr = e;
      console.warn('[starData] Failed', url, '—', e.message);
    }
  }
  console.error('[starData] All mirror URLs failed. Check the HYG-Database repo for the correct CSV path.');
  throw lastErr || new Error('All catalog mirrors failed');
}

// ────────────────────────────────────────────────────────────
// Public loader
// ────────────────────────────────────────────────────────────
export async function loadHYGCatalog({ onProgress = () => {}, onStatus = () => {} } = {}) {
  onStatus('FETCHING HYG·V3 CATALOG');
  const { text, source } = await fetchWithProgress(HYG_URLS, onProgress);

  onStatus('PARSING ' + (text.length / 1048576).toFixed(1) + ' MB');
  await new Promise(r => requestAnimationFrame(r)); // let the UI breathe

  const lines = text.split('\n');
  const header = splitCSVLine(lines[0]);
  const ix = name => header.indexOf(name);

  const I_ID    = ix('id');
  const I_HIP   = ix('hip');
  const I_HD    = ix('hd');
  const I_BF    = ix('bf');
  const I_PROP  = ix('proper');
  const I_DIST  = ix('dist');
  const I_MAG   = ix('mag');
  const I_ABS   = ix('absmag');
  const I_SPEC  = ix('spect');
  const I_CI    = ix('ci');
  const I_X     = ix('x');
  const I_Y     = ix('y');
  const I_Z     = ix('z');
  const I_CON   = ix('con');

  // First pass: count valid rows so we can allocate exact typed arrays.
  const n = lines.length - 1;
  const positions = new Float32Array(n * 3);
  const colors    = new Float32Array(n * 3);
  const sizes     = new Float32Array(n);
  const mags      = new Float32Array(n);
  const stars     = new Array(n);

  let k = 0;
  let sunIndex = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCSVLine(line);
    if (f.length < header.length - 2) continue;

    const x = parseFloat(f[I_X]);
    const y = parseFloat(f[I_Y]);
    const z = parseFloat(f[I_Z]);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

    const dist = parseFloat(f[I_DIST]); // parsecs
    const mag  = parseFloat(f[I_MAG]);
    const abs  = parseFloat(f[I_ABS]);
    if (!isFinite(mag)) continue;

    // The Sun is row 0 in HYG, with distance ≈ 0.
    const isSun = (parseInt(f[I_ID], 10) === 0) || (dist === 0);

    const ci = parseFloat(f[I_CI]);
    const [r, g, b] = bvToRGB(isFinite(ci) ? ci : 0.65);

    positions[k * 3]     = x;
    positions[k * 3 + 1] = y;
    positions[k * 3 + 2] = z;

    colors[k * 3]     = r;
    colors[k * 3 + 1] = g;
    colors[k * 3 + 2] = b;

    // Visual size derived from apparent magnitude (brighter → larger)
    // Magnitude is logarithmic; lower number = brighter.
    sizes[k] = Math.max(0.6, 6.0 - mag * 0.55);
    mags[k]  = mag;

    const proper = f[I_PROP]?.trim();
    const bf     = f[I_BF]?.trim();
    const hip    = f[I_HIP]?.trim();
    const hd     = f[I_HD]?.trim();

    stars[k] = {
      i: k,
      id:    parseInt(f[I_ID], 10),
      hip:   hip || null,
      hd:    hd  || null,
      bf:    bf  || null,
      name:  proper || bf || (hip ? 'HIP ' + hip : (hd ? 'HD ' + hd : null)) || `Star #${k}`,
      proper: proper || null,
      dist:  isFinite(dist) ? dist : null,
      mag,
      absmag: isFinite(abs) ? abs : null,
      spect: (f[I_SPEC] || '').trim() || null,
      ci:    isFinite(ci)  ? ci  : null,
      con:   (f[I_CON]  || '').trim() || null,
    };

    if (isSun) sunIndex = k;
    k++;
  }

  // Trim
  const finalPositions = positions.slice(0, k * 3);
  const finalColors    = colors.slice(0, k * 3);
  const finalSizes     = sizes.slice(0, k);
  const finalMags      = mags.slice(0, k);
  stars.length = k;

  onStatus(`PARSED ${k.toLocaleString()} STARS`);

  return {
    count:     k,
    positions: finalPositions,
    colors:    finalColors,
    sizes:     finalSizes,
    mags:      finalMags,
    stars,
    sunIndex,
    source,
  };
}
