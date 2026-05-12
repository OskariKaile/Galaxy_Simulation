// ============================================================
// exoplanetAPI.js
// Queries the NASA Exoplanet Archive's TAP (Table Access
// Protocol) endpoint for confirmed planets orbiting a given
// host star.
//
// API docs: https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html
// ============================================================

const TAP_BASE = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const CORS_PROXY = "https://corsproxy.io/?";

// Build a TAP ADQL query. We try several aliases of the host
// star's name because exoplanet records use mixed nomenclatures.
function buildQuery(aliases) {
  // Quote-escape each alias.
  const ors = aliases
    .filter(Boolean)
    .map((a) => `hostname='${a.replace(/'/g, "''")}'`)
    .join(" OR ");

  if (!ors) return null;

  // Pick the columns we actually display.
  const cols = [
    "pl_name", // planet name
    "hostname",
    "discoverymethod",
    "disc_year",
    "pl_orbper", // orbital period (days)
    "pl_rade", // radius (Earth radii)
    "pl_bmasse", // mass (Earth masses)
    "pl_eqt", // equilibrium temp (K)
    "pl_orbsmax", // semi-major axis (AU)
    "st_spectype",
  ].join(",");

  return `SELECT ${cols} FROM ps WHERE (${ors}) AND default_flag=1`;
}

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

// Fetch every confirmed exoplanet host star name in one bulk query.
let _allHostsCache = null;
export async function fetchAllHostStars({ signal } = {}) {
  if (_allHostsCache) return _allHostsCache;
  const query = `SELECT DISTINCT hostname FROM ps WHERE default_flag=1`;
  const apiUrl = TAP_BASE + '?query=' + encodeURIComponent(query) + '&format=json';
  const url = CORS_PROXY + encodeURIComponent(apiUrl);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('NASA Exoplanet Archive returned HTTP ' + res.status);
  const data = await res.json();
  _allHostsCache = new Set((Array.isArray(data) ? data : []).map(r => r.hostname));
  return _allHostsCache;
}

// In-memory cache to avoid re-querying the same star.
const cache = new Map();

export async function fetchExoplanets(star, { signal } = {}) {
  const aliases = aliasesForStar(star);
  if (aliases.length === 0) {
    return { aliases: [], planets: [], source: "NASA Exoplanet Archive" };
  }

  const key = aliases.join("|");
  if (cache.has(key)) return cache.get(key);

  const query = buildQuery(aliases);
  if (!query) return { aliases, planets: [], source: "NASA Exoplanet Archive" };

  const apiUrl =
    TAP_BASE + "?query=" + encodeURIComponent(query) + "&format=json";

  const url = CORS_PROXY + encodeURIComponent(apiUrl);

  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error("NASA Exoplanet Archive returned HTTP " + res.status);
  }
  const data = await res.json();

  const planets = (Array.isArray(data) ? data : []).map((row) => ({
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
  }));

  const result = {
    aliases,
    planets,
    source: "NASA Exoplanet Archive",
  };
  cache.set(key, result);
  return result;
}
