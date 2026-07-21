/* Skåne & Blekinge weather map — data: Open-Meteo (free, no key)
   Three things only: incoming rain (radar blobs), wind (speed-coloured arrows),
   temperature (coloured numbers). No background washes. */
"use strict";

/* ---------- Region & grid ---------- */
const REGION = { latMin: 55.3, latMax: 56.75, lonMin: 12.2, lonMax: 16.3 };
const NX = 15, NY = 9; // grid points: NX lon × NY lat
const BUFFER_W = 240, BUFFER_H = 150; // offscreen interpolation buffer
const EDGE_FADE = 1.6; // grid cells over which rain blobs fade past the grid edge

const lats = [], lons = [];
for (let iy = 0; iy < NY; iy++) lats.push(REGION.latMin + (REGION.latMax - REGION.latMin) * iy / (NY - 1));
for (let ix = 0; ix < NX; ix++) lons.push(REGION.lonMin + (REGION.lonMax - REGION.lonMin) * ix / (NX - 1));

/* ---------- Layers ---------- */
// kind: "field" = colour blob on the soft canvas · "arrows" = wind arrows · "labels" = temp numbers
const LAYER_DEFS = [
  { id: "temp",   name: "Temperature",   varName: "temperature_2m",   unit: "°C",   min: -10, max: 30, on: true, opacity: 1.0,  dot: "#f47067", kind: "labels" },
  { id: "wind",   name: "Wind",          varName: "wind_speed_10m",   unit: "m/s",  min: 0,   max: 25, on: true, opacity: 1.0,  dot: "#7ee787", kind: "arrows" },
  { id: "precip", name: "Precipitation", varName: "precipitation",    unit: "mm/h", min: 0,   max: 15, on: true, opacity: 0.9,  dot: "#58a6ff", kind: "field"  },
];

/* ---------- Colour scales ---------- */
function stops(stopsArr, v) {
  if (v <= stopsArr[0][0]) return stopsArr[0].slice(1);
  const last = stopsArr[stopsArr.length - 1];
  if (v >= last[0]) return last.slice(1);
  for (let i = 0; i < stopsArr.length - 1; i++) {
    const a = stopsArr[i], b = stopsArr[i + 1];
    if (v >= a[0] && v <= b[0]) {
      const f = (v - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return last.slice(1);
}
const COLORMAPS = {
  temp: v => stops([[-10,80,140,255],[0,110,200,230],[10,120,210,150],[18,255,230,110],[24,255,160,60],[30,235,60,60]], v),
  wind: v => stops([[0,140,220,160],[6,120,200,255],[12,255,230,110],[18,255,150,50],[25,235,60,60]], v),
  // radar-style: green = light rain, yellow/orange = moderate, red/purple = heavy
  precip: v => {
    if (v < 0.05) return [0, 0, 0, 0];
    const c = stops([[0.1,70,200,120],[1,120,220,90],[3,250,235,80],[6,250,160,50],[10,235,60,60],[15,190,70,210]], Math.max(v, 0.1));
    return [c[0], c[1], c[2], Math.min(0.5 + v / 15 * 0.45, 0.95)];
  },
};

/* ---------- State ---------- */
let weatherData = null;   // array of per-point responses
let times = [];
let timeIdx = 0;
let playing = false;
let playTimer = null;
const layerState = {};
LAYER_DEFS.forEach(d => layerState[d.id] = { on: d.on, opacity: d.opacity });

/* ---------- Map ---------- */
const map = L.map("map", {
  center: [56.0, 14.2],
  zoom: 8,
  minZoom: 7,
  maxZoom: 12,
  maxBounds: [[REGION.latMin - 0.6, REGION.lonMin - 1.2], [REGION.latMax + 0.6, REGION.lonMax + 1.2]],
  maxBoundsViscosity: 0.8,
  zoomControl: false,
});
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | Data: Open-Meteo',
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

// city names for orientation
const CITIES = [
  ["Malmö", 55.605, 13.003], ["Lund", 55.7047, 13.191], ["Helsingborg", 56.0465, 12.6945],
  ["Kristianstad", 56.0313, 14.1567], ["Hässleholm", 56.1589, 13.7664], ["Ystad", 55.4295, 13.82],
  ["Karlskrona", 56.1612, 15.5869], ["Ronneby", 56.21, 15.276], ["Karlshamn", 56.1706, 14.8619],
  ["Sölvesborg", 56.0521, 14.5753],
];
CITIES.forEach(([name, la, lo]) =>
  L.marker([la, lo], {
    interactive: false, keyboard: false,
    icon: L.divIcon({ className: "city-label", html: name, iconSize: [0, 0] }),
  }).addTo(map));

/* ---------- Canvas overlays ---------- */
const buffer = document.createElement("canvas");
buffer.width = BUFFER_W; buffer.height = BUFFER_H;
const bctx = buffer.getContext("2d");
const img = bctx.createImageData(BUFFER_W, BUFFER_H);

let redrawQueued = false;
let overlay = null;
function requestRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; if (overlay) overlay.redraw(); });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const WeatherOverlay = L.Layer.extend({
  onAdd(m) {
    this._map = m;
    const pane = m.getPanes().overlayPane;
    this._colors = L.DomUtil.create("canvas", "weather-colors");
    this._marks = L.DomUtil.create("canvas", "weather-arrows");
    pane.appendChild(this._colors);
    pane.appendChild(this._marks);
    this._resetBound = this._reset.bind(this);
    m.on("moveend zoomend resize", this._resetBound);
    this._reset();
  },
  onRemove(m) {
    m.off("moveend zoomend resize", this._resetBound);
    L.DomUtil.remove(this._colors);
    L.DomUtil.remove(this._marks);
  },
  _reset() {
    const size = this._map.getSize();
    this._w = Math.max(1, size.x);
    this._h = Math.max(1, size.y);
    this._colors.width = this._marks.width = this._w;
    this._colors.height = this._marks.height = this._h;
    this._origin = this._map.containerPointToLayerPoint(L.point(0, 0));
    L.DomUtil.setPosition(this._colors, this._origin);
    L.DomUtil.setPosition(this._marks, this._origin);
    requestRedraw();
  },
  redraw() {
    if (!weatherData) return;
    this._drawRain();
    this._drawMarks();
  },
  // rain blobs only — nothing is drawn where it doesn't rain
  _drawRain() {
    const px = img.data;
    const on = layerState.precip.on && layerState.precip.opacity > 0;
    const alpha = layerState.precip.opacity;
    for (let by = 0; by < BUFFER_H; by++) {
      for (let bx = 0; bx < BUFFER_W; bx++) {
        const o = (by * BUFFER_W + bx) * 4;
        if (!on) { px[o + 3] = 0; continue; }
        const lp = L.point(this._origin.x + (bx + 0.5) / BUFFER_W * this._w,
                           this._origin.y + (by + 0.5) / BUFFER_H * this._h);
        const ll = this._map.layerPointToLatLng(lp);
        const gx = (ll.lng - REGION.lonMin) / (REGION.lonMax - REGION.lonMin) * (NX - 1);
        const gy = (ll.lat - REGION.latMin) / (REGION.latMax - REGION.latMin) * (NY - 1);
        const ox = Math.max(-gx, gx - (NX - 1), 0);
        const oy = Math.max(-gy, gy - (NY - 1), 0);
        const dEdge = Math.hypot(ox, oy);
        if (dEdge >= EDGE_FADE) { px[o + 3] = 0; continue; }
        const t = dEdge / EDGE_FADE;
        const feather = 1 - t * t * (3 - 2 * t);
        const v = sample("precipitation", Math.min(Math.max(gx, 0), NX - 1), Math.min(Math.max(gy, 0), NY - 1));
        if (v == null || isNaN(v)) { px[o + 3] = 0; continue; }
        const c = COLORMAPS.precip(v);
        const a = c[3] * alpha * feather;
        if (a > 0.001) { px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = a * 255; }
        else px[o + 3] = 0;
      }
    }
    bctx.putImageData(img, 0, 0);
    const ctx = this._colors.getContext("2d");
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buffer, 0, 0, this._w, this._h);
  },
  // crisp canvas: temperature numbers + wind arrows
  _drawMarks() {
    const ctx = this._marks.getContext("2d");
    ctx.clearRect(0, 0, this._w, this._h);
    const pt = (iy, ix) => {
      const p = this._map.latLngToLayerPoint([lats[iy], lons[ix]]);
      return { x: p.x - this._origin.x, y: p.y - this._origin.y };
    };
    // temperature numbers on every other grid point
    if (layerState.temp.on) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "600 13px 'Segoe UI', system-ui, sans-serif";
      for (let iy = 0; iy < NY; iy += 2) for (let ix = 0; ix < NX; ix += 2) {
        const t = weatherData[iy * NX + ix].hourly.temperature_2m[timeIdx];
        if (t == null) continue;
        const { x, y } = pt(iy, ix);
        if (x < -20 || y < -20 || x > this._w + 20 || y > this._h + 20) continue;
        const label = Math.round(t) + "°";
        const w = ctx.measureText(label).width + 12;
        ctx.fillStyle = "rgba(13,17,23,0.55)";
        roundRect(ctx, x - w / 2, y - 30, w, 18, 9);
        ctx.fill();
        const c = COLORMAPS.temp(t);
        ctx.fillStyle = `rgba(${c[0]|0},${c[1]|0},${c[2]|0},${layerState.temp.opacity})`;
        ctx.fillText(label, x, y - 21);
      }
    }
    // wind arrows, colour = speed, direction = where the wind is going
    if (layerState.wind.on) {
      for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
        const loc = weatherData[iy * NX + ix];
        const spd = loc.hourly.wind_speed_10m[timeIdx];
        const dir = loc.hourly.wind_direction_10m[timeIdx];
        if (spd == null || dir == null) continue;
        const { x, y } = pt(iy, ix);
        if (x < -20 || y < -20 || x > this._w + 20 || y > this._h + 20) continue;
        const rad = (dir + 180) * Math.PI / 180;
        const len = Math.min(7 + spd * 1.7, 36);
        const dx = Math.sin(rad) * len, dy = -Math.cos(rad) * len;
        const c = COLORMAPS.wind(spd);
        const a = 0.25 + 0.75 * layerState.wind.opacity;
        ctx.strokeStyle = ctx.fillStyle = `rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - dx * 0.5, y - dy * 0.5);
        ctx.lineTo(x + dx * 0.5, y + dy * 0.5);
        ctx.stroke();
        const tx = x + dx * 0.5, ty = y + dy * 0.5, s = 5;
        const ux = dx / len, uy = dy / len;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - ux * s - uy * s * 0.6, ty - uy * s + ux * s * 0.6);
        ctx.lineTo(tx - ux * s + uy * s * 0.6, ty - uy * s - ux * s * 0.6);
        ctx.closePath();
        ctx.fill();
      }
    }
  },
});
overlay = new WeatherOverlay();
map.addLayer(overlay);

// bilinear sample of a variable at fractional grid coords
function sample(varName, gx, gy) {
  const x0 = Math.min(Math.floor(gx), NX - 2), y0 = Math.min(Math.floor(gy), NY - 2);
  const fx = gx - x0, fy = gy - y0;
  const h = i => weatherData[i].hourly[varName][timeIdx];
  const v00 = h(y0 * NX + x0), v10 = h(y0 * NX + x0 + 1);
  const v01 = h((y0 + 1) * NX + x0), v11 = h((y0 + 1) * NX + x0 + 1);
  if (v00 == null || v10 == null || v01 == null || v11 == null) return null;
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

/* ---------- Data fetch ---------- */
async function loadData() {
  const latParam = [], lonParam = [];
  for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) { latParam.push(lats[iy]); lonParam.push(lons[ix]); }
  const url = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + latParam.join(",") + "&longitude=" + lonParam.join(",")
    + "&hourly=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m"
    + "&wind_speed_unit=ms&forecast_days=6&timezone=auto";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Open-Meteo request failed: HTTP " + res.status);
  const json = await res.json();
  weatherData = Array.isArray(json) ? json : [json];
  times = weatherData[0].hourly.time;
  // start at the hour closest to now
  const now = Date.now();
  let best = 0;
  times.forEach((t, i) => { if (Math.abs(new Date(t) - now) < Math.abs(new Date(times[best]) - now)) best = i; });
  timeIdx = best;
  const slider = document.getElementById("time-slider");
  slider.max = times.length - 1;
  slider.value = timeIdx;
  updateTimeLabel();
  document.getElementById("loading").style.display = "none";
  requestRedraw();
  buildLegend();
  setPlaying(true); // autoplay so the weather movement is visible immediately
}

/* ---------- UI: layer panel ---------- */
function buildLayerPanel() {
  const wrap = document.getElementById("layer-rows");
  LAYER_DEFS.forEach(d => {
    const row = document.createElement("div");
    row.className = "layer-row";
    row.innerHTML =
      `<span class="dot" style="background:${d.dot}"></span>` +
      `<input type="checkbox" id="cb-${d.id}" ${d.on ? "checked" : ""}>` +
      `<label for="cb-${d.id}">${d.name}</label>` +
      `<input type="range" id="op-${d.id}" min="0" max="100" value="${Math.round(d.opacity * 100)}" title="Opacity">`;
    wrap.appendChild(row);
    row.querySelector(`#cb-${d.id}`).addEventListener("change", e => {
      layerState[d.id].on = e.target.checked;
      requestRedraw(); buildLegend();
    });
    row.querySelector(`#op-${d.id}`).addEventListener("input", e => {
      layerState[d.id].opacity = e.target.value / 100;
      requestRedraw();
    });
  });
}

/* ---------- UI: legend ---------- */
function buildLegend() {
  const el = document.getElementById("legend");
  const active = LAYER_DEFS.filter(d => layerState[d.id].on);
  if (!active.length) { el.style.display = "none"; return; }
  el.style.display = "block";
  el.innerHTML = "<h2>Legend</h2>";
  active.forEach(d => {
    const n = 7, cols = [];
    for (let i = 0; i < n; i++) {
      const v = d.min + (d.max - d.min) * i / (n - 1);
      const c = COLORMAPS[d.id](v);
      const a = c.length > 3 ? c[3] : 1;
      cols.push(`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${Math.max(a, 0.3)}) ${i / (n - 1) * 100}%`);
    }
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `<div class="name">${d.name} (${d.unit})</div>` +
      `<div class="legend-bar" style="background:linear-gradient(to right,${cols.join(",")})"></div>` +
      `<div class="legend-scale"><span>${d.min}</span><span>${d.max}</span></div>`;
    el.appendChild(item);
  });
}

/* ---------- UI: time ---------- */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtTime(t) {
  const d = new Date(t);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, "0")}:00`;
}
function updateTimeLabel() {
  document.getElementById("time-label").textContent = times.length ? fmtTime(times[timeIdx]) : "–";
}
document.getElementById("time-slider").addEventListener("input", e => {
  timeIdx = +e.target.value;
  updateTimeLabel();
  requestRedraw();
});
const playBtn = document.getElementById("play-btn");
function setPlaying(on) {
  playing = on;
  playBtn.textContent = playing ? "❚❚" : "▶";
  if (playing) {
    clearInterval(playTimer);
    playTimer = setInterval(() => {
      timeIdx = (timeIdx + 1) % times.length;
      document.getElementById("time-slider").value = timeIdx;
      updateTimeLabel();
      requestRedraw();
    }, 600);
  } else clearInterval(playTimer);
}
playBtn.addEventListener("click", () => setPlaying(!playing));

/* ---------- UI: hover readout ---------- */
const readoutBody = document.getElementById("readout-body");
let readoutQueued = false;
map.on("mousemove", e => {
  if (!weatherData || readoutQueued) return;
  readoutQueued = true;
  requestAnimationFrame(() => {
    readoutQueued = false;
    const gx = (e.latlng.lng - REGION.lonMin) / (REGION.lonMax - REGION.lonMin) * (NX - 1);
    const gy = (e.latlng.lat - REGION.latMin) / (REGION.latMax - REGION.latMin) * (NY - 1);
    if (gx < 0 || gy < 0 || gx > NX - 1 || gy > NY - 1) { readoutBody.textContent = "Outside region"; return; }
    let html = "";
    LAYER_DEFS.forEach(d => {
      const v = sample(d.varName, gx, gy);
      if (v != null) html += `<div><span>${d.name}</span><span>${v.toFixed(1)} ${d.unit}</span></div>`;
    });
    readoutBody.innerHTML = html;
  });
});

/* ---------- Go ---------- */
buildLayerPanel();
buildLegend();
loadData().catch(err => {
  document.getElementById("loading").style.display = "none";
  const banner = document.getElementById("error-banner");
  banner.hidden = false;
  banner.textContent = "Could not load weather data: " + err.message + " — check your internet connection and reload.";
});
