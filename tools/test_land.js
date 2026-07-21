// Sanity test for the land mask: eval land.js + the pure "Region & grid / Land mask"
// section of app.js in a vm context, then check known points.
// Run: node tools/test_land.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const land = fs.readFileSync(path.join(root, "land.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

const start = app.indexOf("/* ---------- Region & grid ----------");
const end = app.indexOf("/* ---------- Layers ----------");
if (start < 0 || end < 0) { console.error("could not extract land section from app.js"); process.exit(1); }
const section = app.slice(start, end);

const t0 = Date.now();
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  land + "\n" + section +
  "\nglobalThis.__x = { landPointInside, landDistDeg, landFactor, gridOnLand, REGION, LAND_BBOX, lats, lons, NX, NY, LAND_RINGS };",
  ctx
);
const buildMs = Date.now() - t0;
const { landPointInside, landDistDeg, landFactor, gridOnLand, REGION, LAND_BBOX, lats, lons, NX, NY, LAND_RINGS } = ctx.__x;

let fails = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: expected ${expected}, got ${actual}`);
}
function checkRange(label, actual, lo, hi) {
  const ok = actual >= lo && actual <= hi;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: expected ${lo}..${hi}, got ${actual}`);
}

console.log(`rings: ${LAND_RINGS.length}, points: ${LAND_RINGS.reduce((n, r) => n + r.length, 0)}, mask+PIP build: ${buildMs} ms`);

// point-in-polygon: [name, lon, lat, expectedOnLand]
const POINTS = [
  ["Malmö",            13.003,  55.605,  true],
  ["Lund",             13.191,  55.7047, true],
  ["Kristianstad",     14.1567, 56.0313, true],
  ["Ystad",            13.82,   55.4295, true],
  ["Hässleholm",       13.7664, 56.1589, true],
  ["Öresund (sea)",    12.90,   55.62,   false],
  ["Copenhagen (DK)",  12.568,  55.676,  false],
  ["Baltic (sea)",     15.5,    55.5,    false],
  ["Kattegat (sea)",   12.3,    56.3,    false],
  ["Småland (north)",  14.2,    56.70,   false],
  ["Bornholm (DK)",    14.9,    55.1,    false],
];
for (const [name, lo, la, want] of POINTS) check(`landPointInside ${name}`, landPointInside(lo, la), want);

// waterfront cities sit on the shoreline/islands — may fail strict PIP but must be very close
for (const [name, lo, la] of [["Helsingborg", 12.6945, 56.0465], ["Karlskrona", 15.5869, 56.1612]]) {
  const d = landDistDeg(lo, la);
  console.log(`dist to coast: ${name} ${landPointInside(lo, la) ? "on land" : d.toFixed(4) + "°"}`);
  checkRange(`${name} within 0.05° of coastline`, landPointInside(lo, la) ? 0 : d, 0, 0.05);
}

// mask factor: solid land ≈ 1, open sea = 0, coastline fades between
checkRange("landFactor Malmö", landFactor(13.003, 55.605), 0.8, 1);
check("landFactor Baltic", landFactor(15.5, 55.5), 0);
check("landFactor outside region", landFactor(10.0, 60.0), 0);
let sawPartial = false;
for (let lo = 12.6; lo <= 13.2; lo += 0.001) { // cross the west coast into Malmö
  const f = landFactor(lo, 55.605);
  if (f > 0.05 && f < 0.95) { sawPartial = true; break; }
}
check("coastline feather (partial factor exists)", sawPartial, true);

// grid flags: grid points nearest these cities must show temp/wind
function nearestGridOnLand(lon, lat) {
  let best = 0, bd = 1e9;
  for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
    const d = Math.hypot(lons[ix] - lon, lats[iy] - lat);
    if (d < bd) { bd = d; best = iy * NX + ix; }
  }
  return gridOnLand[best];
}
check("grid point nearest Malmö shows marks", nearestGridOnLand(13.003, 55.605), true);
check("grid point nearest Helsingborg shows marks", nearestGridOnLand(12.6945, 56.0465), true);
check("grid point nearest Karlskrona shows marks", nearestGridOnLand(15.5869, 56.1612), true);
const onCount = gridOnLand.filter(Boolean).length;
console.log(`grid points on land: ${onCount}/${gridOnLand.length}`);
checkRange("on-land grid count", onCount, 30, 110);

console.log(`region bbox: lat ${REGION.latMin}..${REGION.latMax}, lon ${REGION.lonMin}..${REGION.lonMax}`);
console.log(`land bbox:   lat ${LAND_BBOX.latMin}..${LAND_BBOX.latMax}, lon ${LAND_BBOX.lonMin}..${LAND_BBOX.lonMax}`);
console.log(fails ? `\n${fails} FAILURE(S)` : "\nall checks passed");
process.exit(fails ? 1 : 0);
