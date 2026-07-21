/* Skåne & Blekinge weather map — data: Open-Meteo (free, no key) */
"use strict";

/* ---------- Region & grid ---------- */
const REGION = { latMin: 55.3, latMax: 56.75, lonMin: 12.2, lonMax: 16.3 };
const NX = 15, NY = 9; // grid points: NX lon × NY lat
const BUFFER_W = 220, BUFFER_H = 140; // offscreen interpolation buffer

const lats = [], lons = [];
for (let iy = 0; iy < NY; iy++) lats.push(REGION.latMin + (REGION.latMax - REGION.latMin) * iy / (NY - 1));
for (let ix = 0; ix < NX; ix++) lons.push(REGION.lonMin + (REGION.lonMax - REGION.lonMin) * ix / (NX - 1));

/* ---------- Layers ---------- */
const LAYER_DEFS = [
  { id: "temp",     name: "Temperature",    varName: "temperature_2m",       unit: "°C",  min: -25, max: 30,   on: false, opacity: 0.7,  dot: "#f47067" },
  { id: "humidity", name: "Humidity",       varName: "relative_humidity_2m", unit: "%",   min: 0,   max: 100,  on: false, opacity: 0.55, dot: "#39c5cf" },
  { id: "pressure", name: "Air pressure",   varName: "surface_pressure",     unit: "hPa", min: 965, max: 1045, on: false, opacity: 0.55, dot: "#d2a8ff" },
  { id: "wind",     name: "Wind",           varName: "wind_speed_10m",       unit: "m/s", min: 0,   max: 25,   on: true,  opacity: 0.5,  dot: "#7ee787" },
  { id: "cloud",    name: "Cloud cover",    varName: "cloud_cover",          unit: "%",   min: 0,   max: 100,  on: true,  opacity: 0.85, dot: "#c9d1d9" },
  { id: "precip",   name: "Precipitation",  varName: "precipitation",        unit: "mm/h",min: 0,   max: 15,   on: true,  opacity: 0.9,  dot: "#58a6ff" },
];
// render order: first = bottom, last = top
const RENDER_ORDER = ["temp", "humidity", "pressure", "wind", "cloud", "precip"];

/* ---------- Colour maps ---------- */
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
  temp:     v => stops([[-25,49,54,149],[-10,69,117,180],[0,116,173,209],[10,171,221,164],[18,255,255,150],[24,255,190,80],[30,215,25,28]], v),
  humidity: v => stops([[0,247,252,240],[40,178,226,226],[70,84,196,211],[100,8,81,156]], v),
  pressure: v => stops([[965,110,60,170],[995,150,110,200],[1015,120,130,140],[1030,230,170,80],[1045,230,120,40]], v),
  wind:     v => stops([[0,26,152,80],[6,120,198,121],[12,255,237,120],[18,244,140,49],[25,215,25,28]], v),
  cloud:    v => { const c = Math.max(0, Math.min(100, v)); return [235, 240, 245, c / 100]; },
  precip:   v => {
    if (v < 0.05) return [0, 0, 0, 0];
    const f = Math.min(1, v / 15);
    return [120 + (10 - 120) * f, 190 + (40 - 190) * f, 255 + (180 - 255) * f, Math.min(0.3 + f * 0.7, 0.97)];
  },
};
const ALPHA_DEFAULT = { temp: 0.75, humidity: 0.6, pressure: 0.6, wind: 0.55, cloud: 1, precip: 1 };

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

// subtle region outline
L.rectangle([[REGION.latMin, REGION.lonMin], [REGION.latMax, REGION.lonMax]],
  { color: "#58a6ff", weight: 1, dashArray: "4 6", fill: false, opacity: 0.35, interactive: false }).addTo(map);

// city labels
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

/* ---------- Canvas overlay ---------- */
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

const WeatherOverlay = L.Layer.extend({
  onAdd(m) {
    this._map = m;
    this._canvas = L.DomUtil.create("canvas", "weather-overlay");
    m.getPanes().overlayPane.appendChild(this._canvas);
    this._resetBound = this._reset.bind(this);
    m.on("moveend zoomend resize", this._resetBound);
    this._reset();
  },
  onRemove(m) {
    m.off("moveend zoomend resize", this._resetBound);
    L.DomUtil.remove(this._canvas);
  },
  _reset() {
    const nw = this._map.latLngToLayerPoint([REGION.latMax, REGION.lonMin]);
    const se = this._map.latLngToLayerPoint([REGION.latMin, REGION.lonMax]);
    this._nw = nw;
    this._w = Math.max(1, Math.round(se.x - nw.x));
    this._h = Math.max(1, Math.round(se.y - nw.y));
    this._canvas.width = this._w; this._canvas.height = this._h;
    L.DomUtil.setPosition(this._canvas, nw);
    requestRedraw();
  },
  redraw() {
    if (!weatherData) return;
    const ctx = this._canvas.getContext("2d");
    const px = img.data;
    const active = RENDER_ORDER.filter(id => layerState[id].on && layerState[id].opacity > 0);
    for (let by = 0; by < BUFFER_H; by++) {
      for (let bx = 0; bx < BUFFER_W; bx++) {
        const lp = L.point(this._nw.x + (bx + 0.5) / BUFFER_W * this._w,
                           this._nw.y + (by + 0.5) / BUFFER_H * this._h);
        const ll = this._map.layerPointToLatLng(lp);
        const gx = (ll.lng - REGION.lonMin) / (REGION.lonMax - REGION.lonMin) * (NX - 1);
        const gy = (ll.lat - REGION.latMin) / (REGION.latMax - REGION.latMin) * (NY - 1);
        const o = (by * BUFFER_W + bx) * 4;
        if (gx < 0 || gy < 0 || gx > NX - 1 || gy > NY - 1) { px[o + 3] = 0; continue; }
        let r = 0, g = 0, b = 0, a = 0;
        for (const id of active) {
          const v = sample(LAYER_DEFS.find(d => d.id === id).varName, gx, gy);
          if (v == null || isNaN(v)) continue;
          const c = COLORMAPS[id](v);
          let ca = (c.length > 3 ? c[3] : ALPHA_DEFAULT[id]) * layerState[id].opacity;
          if (ca <= 0) continue;
          // source-over
          r = c[0] * ca + r * (1 - ca);
          g = c[1] * ca + g * (1 - ca);
          b = c[2] * ca + b * (1 - ca);
          a = ca + a * (1 - ca);
        }
        if (a > 0.001) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; px[o + 3] = a * 255; }
        else px[o + 3] = 0;
      }
    }
    bctx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buffer, 0, 0, this._w, this._h);

    // wind arrows on top
    if (layerState.wind.on) {
      for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
        const loc = weatherData[iy * NX + ix];
        const spd = loc.hourly.wind_speed_10m[timeIdx];
        const dir = loc.hourly.wind_direction_10m[timeIdx];
        if (spd == null || dir == null) continue;
        const p = this._map.latLngToLayerPoint([lats[iy], lons[ix]]);
        const x = p.x - this._nw.x, y = p.y - this._nw.y;
        if (x < 0 || y < 0 || x > this._w || y > this._h) continue;
        const rad = (dir + 180) * Math.PI / 180; // point where wind goes to
        const len = Math.min(6 + spd * 1.6, 34);
        const dx = Math.sin(rad) * len, dy = -Math.cos(rad) * len;
        const c = COLORMAPS.wind(spd);
        ctx.strokeStyle = ctx.fillStyle = `rgba(${c[0]|0},${c[1]|0},${c[2]|0},0.95)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - dx * 0.5, y - dy * 0.5);
        ctx.lineTo(x + dx * 0.5, y + dy * 0.5);
        ctx.stroke();
        // arrowhead
        const tx = x + dx * 0.5, ty = y + dy * 0.5, s = 5;
        const ux = dx / len, uy = dy / len;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - ux * s - uy * s * 0.6, ty - uy * s + ux * s * 0.6);
        ctx.lineTo(tx - ux * s + uy * s * 0.6, ty - uy * s - ux * s * 0.6);
        ctx.closePath(); ctx.fill();
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
    + "&hourly=temperature_2m,relative_humidity_2m,precipitation,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m"
    + "&wind_speed_unit=ms&forecast_days=3&timezone=auto";
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
      const a = c.length > 3 ? c[3] : ALPHA_DEFAULT[d.id];
      cols.push(`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${Math.max(a, 0.15)}) ${i / (n - 1) * 100}%`);
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
function updateTimeLabel() {
  document.getElementById("time-label").textContent =
    times.length ? times[timeIdx].replace("T", " ") : "–";
}
document.getElementById("time-slider").addEventListener("input", e => {
  timeIdx = +e.target.value;
  updateTimeLabel();
  requestRedraw();
});
const playBtn = document.getElementById("play-btn");
playBtn.addEventListener("click", () => {
  playing = !playing;
  playBtn.textContent = playing ? "❚❚" : "▶";
  if (playing) {
    playTimer = setInterval(() => {
      timeIdx = (timeIdx + 1) % times.length;
      document.getElementById("time-slider").value = timeIdx;
      updateTimeLabel();
      requestRedraw();
    }, 500);
  } else clearInterval(playTimer);
});

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
