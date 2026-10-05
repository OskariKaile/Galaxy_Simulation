// ============================================================
// update-exoplanets.mjs
// Downloads every confirmed planet from the NASA Exoplanet
// Archive and writes it to data/exoplanets.json.
//
// The archive doesn't send CORS headers, so the browser can't
// query it directly from GitHub Pages. Instead we snapshot the
// data into the repo. Re-run this to pick up new discoveries:
//
//   node scripts/update-exoplanets.mjs
// ============================================================

import { writeFile } from "node:fs/promises";

const TAP_BASE = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";

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
];

const query = `SELECT ${cols.join(",")} FROM ps WHERE default_flag=1`;
const url = TAP_BASE + "?query=" + encodeURIComponent(query) + "&format=json";

const res = await fetch(url);
if (!res.ok) throw new Error("NASA Exoplanet Archive returned HTTP " + res.status);
const rows = await res.json();

// Store as column list + row arrays to keep the file small.
const out = {
  source: "NASA Exoplanet Archive",
  updated: new Date().toISOString().slice(0, 10),
  cols,
  rows: rows.map((r) => cols.map((c) => r[c])),
};

const path = new URL("../data/exoplanets.json", import.meta.url);
await writeFile(path, JSON.stringify(out));
console.log(`Wrote ${rows.length} planets to data/exoplanets.json`);
