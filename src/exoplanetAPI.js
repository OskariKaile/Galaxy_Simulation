// ============================================================
// exoplanetAPI.js
// Looks up confirmed planets orbiting a given host star.
//
// Data comes from a snapshot of the NASA Exoplanet Archive
// stored in data/exoplanets.json. The archive's TAP endpoint
// doesn't send CORS headers, so it can't be queried directly
// from the browser. Refresh the snapshot with:
//
//   node scripts/update-exoplanets.mjs
// ============================================================

const DATA_URL = "data/exoplanets.json";
const SOURCE = "NASA Exoplanet Archive";

// Generate plausible host-star aliases from a HYG row.
export function aliasesForStar(s) {
  const aliases = new Set();
  if (s.proper) {
    aliases.add(s.proper);
    aliases.add(s.proper.replace(/ /g, ""));
  }
  if (s.hip) aliases.add("HIP " + s.hip);
  if (s.hd) aliases.add("HD " + s.hd);
  if (s.bf) {
    // Bayer/Flamsteed designation like "21Alp CMa" or "Alp CMa"
    aliases.add(s.bf);
    aliases.add(s.bf.replace(/\s+/g, " ").trim());
  }
  return [...aliases];
}

// Load the snapshot once and index planets by host star name.
let _byHostPromise = null;
function loadByHost() {
  if (_byHostPromise) return _byHostPromise;
  _byHostPromise = fetch(DATA_URL)
    .then((res) => {
      if (!res.ok) throw new Error("Exoplanet data returned HTTP " + res.status);
      return res.json();
    })
    .then(({ cols, rows }) => {
      const byHost = new Map();
      for (const r of rows) {
        const row = Object.fromEntries(cols.map((c, i) => [c, r[i]]));
        const planet = {
          name: row.pl_name,
          hostname: row.hostname,
          method: row.discoverymethod,
          year: row.disc_year,
          periodDays: row.pl_orbper,
          radiusEarth: row.pl_rade,
          massEarth: row.pl_bmasse,
          tempK: row.pl_eqt,
          smaxisAU: row.pl_orbsmax,
          starSpectype: row.st_spectype,
        };
        if (!byHost.has(row.hostname)) byHost.set(row.hostname, []);
        byHost.get(row.hostname).push(planet);
      }
      return byHost;
    })
    .catch((err) => {
      _byHostPromise = null; // allow retry
      throw err;
    });
  return _byHostPromise;
}

// Every confirmed exoplanet host star name.
export async function fetchAllHostStars() {
  const byHost = await loadByHost();
  return new Set(byHost.keys());
}

export async function fetchExoplanets(star, { signal } = {}) {
  const aliases = aliasesForStar(star);
  if (aliases.length === 0) {
    return { aliases: [], planets: [], source: SOURCE };
  }

  const byHost = await loadByHost();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const planets = [];
  for (const a of aliases) {
    const found = byHost.get(a);
    if (found) planets.push(...found);
  }

  return { aliases, planets, source: SOURCE };
}
