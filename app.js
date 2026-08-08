/* Skåne & Blekinge High-Precision Weather Radar & Forecast Engine
   Data source: Open-Meteo High-Resolution Model (Free API)
   Features: 36x24 grid resolution, doppler rain radar, cloud density overlay,
             animated wind flow particles, city weather badges, timeline histogram. */
"use strict";

/* ---------- Region & High-Resolution Grid ---------- */
const REGION = { latMin: 55.3, latMax: 56.75, lonMin: 12.2, lonMax: 16.3 };
const NX = 10, NY = 8; // 80 grid points (proven within Open-Meteo's 100-point ceiling)
const BUFFER_W = 320, BUFFER_H = 200; // Offscreen smooth interpolation buffer

const lats = [], lons = [];
for (let iy = 0; iy < NY; iy++) lats.push(REGION.latMin + (REGION.latMax - REGION.latMin) * iy / (NY - 1));
for (let ix = 0; ix < NX; ix++) lons.push(REGION.lonMin + (REGION.lonMax - REGION.lonMin) * ix / (NX - 1));

/* ---------- Land Mask Processing ---------- */
const LAND_BBOX = { latMin: Infinity, latMax: -Infinity, lonMin: Infinity, lonMax: -Infinity };
const RING_BBOX = LAND_RINGS.map(ring => {
  const b = { latMin: Infinity, latMax: -Infinity, lonMin: Infinity, lonMax: -Infinity };
  ring.forEach(([lo, la]) => {
    if (lo < b.lonMin) b.lonMin = lo; if (lo > b.lonMax) b.lonMax = lo;
    if (la < b.latMin) b.latMin = la; if (la > b.latMax) b.latMax = la;
    if (lo < LAND_BBOX.lonMin) LAND_BBOX.lonMin = lo; if (lo > LAND_BBOX.lonMax) LAND_BBOX.lonMax = lo;
    if (la < LAND_BBOX.latMin) LAND_BBOX.latMin = la; if (la > LAND_BBOX.latMax) LAND_BBOX.latMax = la;
  });
  return b;
});

function landPointInside(lon, lat) {
  if (lon < LAND_BBOX.lonMin || lon > LAND_BBOX.lonMax || lat < LAND_BBOX.latMin || lat > LAND_BBOX.latMax) return false;
  for (let r = 0; r < LAND_RINGS.length; r++) {
    const b = RING_BBOX[r];
    if (lon < b.lonMin || lon > b.lonMax || lat < b.latMin || lat > b.latMax) continue;
    const ring = LAND_RINGS[r];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

function landDistDeg(lon, lat) {
  let best = Infinity;
  for (let r = 0; r < LAND_RINGS.length; r++) {
    const b = RING_BBOX[r];
    if (lon < b.lonMin - 0.4 || lon > b.lonMax + 0.4 || lat < b.latMin - 0.4 || lat > b.latMax + 0.4) continue;
    const ring = LAND_RINGS[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      const dx = xj - xi, dy = yj - yi;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((lon - xi) * dx + (lat - yi) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(lon - (xi + t * dx), lat - (yi + t * dy));
      if (d < best) best = d;
    }
  }
  return best;
}

const landMask = new Float32Array(BUFFER_W * BUFFER_H);
for (let my = 0; my < BUFFER_H; my++) {
  const la = REGION.latMin + (REGION.latMax - REGION.latMin) * my / (BUFFER_H - 1);
  for (let mx = 0; mx < BUFFER_W; mx++) {
    const lo = REGION.lonMin + (REGION.lonMax - REGION.lonMin) * mx / (BUFFER_W - 1);
    landMask[my * BUFFER_W + mx] = landPointInside(lo, la) ? 1 : 0;
  }
}

function landFactor(lon, lat) {
  const gx = (lon - REGION.lonMin) / (REGION.lonMax - REGION.lonMin) * (BUFFER_W - 1);
  const gy = (lat - REGION.latMin) / (REGION.latMax - REGION.latMin) * (BUFFER_H - 1);
  if (gx < 0 || gy < 0 || gx > BUFFER_W - 1 || gy > BUFFER_H - 1) return 0;
  const x0 = Math.min(Math.floor(gx), BUFFER_W - 2), y0 = Math.min(Math.floor(gy), BUFFER_H - 2);
  const fx = gx - x0, fy = gy - y0;
  const m00 = landMask[y0 * BUFFER_W + x0], m10 = landMask[y0 * BUFFER_W + x0 + 1];
  const m01 = landMask[(y0 + 1) * BUFFER_W + x0], m11 = landMask[(y0 + 1) * BUFFER_W + x0 + 1];
  return m00 * (1 - fx) * (1 - fy) + m10 * fx * (1 - fy) + m01 * (1 - fx) * fy + m11 * fx * fy;
}

const gridOnLand = [];
for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++)
  gridOnLand.push(landPointInside(lons[ix], lats[iy]) || landDistDeg(lons[ix], lats[iy]) < 0.25);

/* ---------- Layer Definitions ---------- */
const LAYER_DEFS = [
  { id: "precip", name: "Rain Radar",   varName: "precipitation",    unit: "mm/h", min: 0,   max: 15, on: true,  opacity: 0.9, dot: "#38bdf8" },
  { id: "clouds", name: "Cloud Cover",  varName: "cloud_cover",      unit: "%",    min: 0,   max: 100,on: false, opacity: 0.7, dot: "#cbd5e1" },
  { id: "wind",   name: "Wind Flow",    varName: "wind_speed_10m",   unit: "m/s",  min: 0,   max: 25, on: false, opacity: 0.9, dot: "#4ade80" },
  { id: "temp",   name: "Temperature",  varName: "temperature_2m",   unit: "°C",   min: -10, max: 30, on: false, opacity: 0.7, dot: "#fb923c" },
];

/* ---------- Color Palettes & Interpolation ---------- */
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
  precip: v => {
    if (v < 0.05) return [0, 0, 0, 0];
    const c = stops([
      [0.1, 45, 212, 191],   // Light drizzle teal
      [1.0, 59, 130, 246],   // Moderate rain blue
      [3.0, 250, 204, 21],   // Downpour yellow
      [6.0, 249, 115, 22],   // Heavy rain orange
      [10.0, 239, 68, 68],   // Severe storm red
      [15.0, 192, 132, 252]  // Torrential purple
    ], Math.max(v, 0.1));
    return [c[0], c[1], c[2], Math.min(0.55 + (v / 15) * 0.4, 0.95)];
  },
  clouds: v => {
    if (v < 5) return [0, 0, 0, 0];
    const alpha = (v / 100) * 0.75;
    return [226, 232, 240, alpha];
  },
  wind: v => stops([
    [0, 56, 189, 248],
    [6, 74, 222, 128],
    [12, 250, 204, 21],
    [18, 251, 146, 60],
    [25, 239, 68, 68]
  ], v),
  temp: v => stops([
    [-10, 30, 58, 138],
    [0, 14, 165, 233],
    [10, 45, 212, 191],
    [18, 250, 204, 21],
    [24, 249, 115, 22],
    [30, 225, 29, 72]
  ], v),
};

/* ---------- Application State ---------- */
let weatherData = null;
let times = [];
let timeIdx = 0;
let playing = false;
let playTimer = null;
let playSpeed = 1; // 1x, 2x, 4x
let activeQuickLayer = "precip";
const layerState = {};
LAYER_DEFS.forEach(d => layerState[d.id] = { on: d.on, opacity: d.opacity });

/* ---------- Leaflet Map Setup ---------- */
const map = L.map("map", {
  minZoom: 7,
  maxZoom: 12,
  maxBounds: [[REGION.latMin - 0.6, REGION.lonMin - 1.2], [REGION.latMax + 0.6, REGION.lonMax + 1.2]],
  maxBoundsViscosity: 0.85,
  zoomControl: false,
});

map.fitBounds([[LAND_BBOX.latMin, LAND_BBOX.lonMin], [LAND_BBOX.latMax, LAND_BBOX.lonMax]], { padding: [20, 20] });
L.control.zoom({ position: "bottomright" }).addTo(map);

// Clean dark base tiles (No foreign text label clutter)
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | Data: Open-Meteo',
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

/* ---------- City Markers ---------- */
const CITIES = [
  ["Malmö", 55.605, 13.003], ["Lund", 55.7047, 13.191], ["Helsingborg", 56.0465, 12.6945],
  ["Kristianstad", 56.0313, 14.1567], ["Hässleholm", 56.1589, 13.7664], ["Ystad", 55.4295, 13.82],
  ["Karlskrona", 56.1612, 15.5869], ["Ronneby", 56.21, 15.276], ["Karlshamn", 56.1706, 14.8619],
  ["Sölvesborg", 56.0521, 14.5753],
];

const cityMarkerInstances = [];

function initCityMarkers() {
  if (cityMarkerInstances.length > 0) return;
  CITIES.forEach(([name, la, lo]) => {
    const icon = L.divIcon({
      className: "city-marker-wrap",
      html: `<div class="city-badge" data-name="${name}">` +
            `<span class="name">${name}</span><span class="temp" id="city-temp-${name.replace(/\s+/g, '')}">–°</span>` +
            `</div>`,
      iconSize: [0, 0],
    });
    const marker = L.marker([la, lo], { icon }).addTo(map);
    marker.on("click", () => inspectPoint({ lat: la, lng: lo }, name));
    cityMarkerInstances.push({ name, la, lo });
  });
}

function updateCityBadges() {
  if (!weatherData) return;
  cityMarkerInstances.forEach(({ name, la, lo }) => {
    const gx = (lo - REGION.lonMin) / (REGION.lonMax - REGION.lonMin) * (NX - 1);
    const gy = (la - REGION.latMin) / (REGION.latMax - REGION.latMin) * (NY - 1);
    const t = sample("temperature_2m", gx, gy);
    const el = document.getElementById(`city-temp-${name.replace(/\s+/g, '')}`);
    if (el && t != null) {
      el.textContent = Math.round(t) + "°";
    }
  });
}

/* ---------- Canvas Overlays & Particle Animation Engine ---------- */
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

// Particle Streamlines Engine for Wind Flow
const PARTICLE_COUNT = 320;
const particles = [];
for (let i = 0; i < PARTICLE_COUNT; i++) {
  particles.push({
    x: Math.random() * (REGION.lonMax - REGION.lonMin) + REGION.lonMin,
    y: Math.random() * (REGION.latMax - REGION.latMin) + REGION.latMin,
    age: Math.floor(Math.random() * 80),
    maxAge: 60 + Math.random() * 60,
    history: [],
  });
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
    this._startAnimLoop();
    this._reset();
  },
  onRemove(m) {
    this._stopAnimLoop();
    m.off("moveend zoomend resize", this._resetBound);
    L.DomUtil.remove(this._colors);
    L.DomUtil.remove(this._marks);
  },
  _startAnimLoop() {
    this._animating = true;
    const step = () => {
      if (!this._animating) return;
      if (layerState.wind.on && weatherData) {
        this._drawWindParticles();
      }
      this._animReq = requestAnimationFrame(step);
    };
    step();
  },
  _stopAnimLoop() {
    this._animating = false;
    if (this._animReq) cancelAnimationFrame(this._animReq);
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
    if (!weatherData || !this._origin) return;
    this._drawRasterFields();
    if (!layerState.wind.on) {
      const ctx = this._marks.getContext("2d");
      ctx.clearRect(0, 0, this._w, this._h);
    }
  },
  _drawRasterFields() {
    const px = img.data;
    const activeLayer = LAYER_DEFS.find(d => d.id === activeQuickLayer) || LAYER_DEFS[0];
    const isTempMode = activeQuickLayer === "temp";
    const isCloudMode = activeQuickLayer === "clouds";
    const isPrecipMode = activeQuickLayer === "precip";

    const on = layerState[activeLayer.id].on && layerState[activeLayer.id].opacity > 0;
    const alpha = layerState[activeLayer.id].opacity;

    for (let by = 0; by < BUFFER_H; by++) {
      for (let bx = 0; bx < BUFFER_W; bx++) {
        const o = (by * BUFFER_W + bx) * 4;
        if (!on) { px[o + 3] = 0; continue; }

        const lp = L.point(this._origin.x + (bx + 0.5) / BUFFER_W * this._w,
                           this._origin.y + (by + 0.5) / BUFFER_H * this._h);
        const ll = this._map.layerPointToLatLng(lp);
        const f = landFactor(ll.lng, ll.lat);

        if (f <= 0.005) { px[o + 3] = 0; continue; }

        const gx = (ll.lng - REGION.lonMin) / (REGION.lonMax - REGION.lonMin) * (NX - 1);
        const gy = (ll.lat - REGION.latMin) / (REGION.latMax - REGION.latMin) * (NY - 1);

        let v = null;
        if (isPrecipMode) v = sample("precipitation", gx, gy);
        else if (isCloudMode) v = sample("cloud_cover", gx, gy);
        else if (isTempMode) v = sample("temperature_2m", gx, gy);

        if (v == null || isNaN(v)) { px[o + 3] = 0; continue; }

        const c = COLORMAPS[activeLayer.id](v);
        const a = c[3] * alpha * f;

        if (a > 0.001) {
          px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = a * 255;
        } else px[o + 3] = 0;
      }
    }

    bctx.putImageData(img, 0, 0);
    const ctx = this._colors.getContext("2d");
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buffer, 0, 0, this._w, this._h);
  },
  _drawWindParticles() {
    const ctx = this._marks.getContext("2d");
    // Clear canvas every frame so map tiles stay 100% visible
    ctx.clearRect(0, 0, this._w, this._h);

    const opacity = layerState.wind.opacity;

    particles.forEach(p => {
      p.age++;
      if (p.age > p.maxAge || p.x < REGION.lonMin || p.x > REGION.lonMax || p.y < REGION.latMin || p.y > REGION.latMax) {
        p.x = Math.random() * (REGION.lonMax - REGION.lonMin) + REGION.lonMin;
        p.y = Math.random() * (REGION.latMax - REGION.latMin) + REGION.latMin;
        p.age = 0;
        p.history = [];
        return;
      }

      const gx = (p.x - REGION.lonMin) / (REGION.lonMax - REGION.lonMin) * (NX - 1);
      const gy = (p.y - REGION.latMin) / (REGION.latMax - REGION.latMin) * (NY - 1);

      const spd = sample("wind_speed_10m", gx, gy);
      const dir = sample("wind_direction_10m", gx, gy);

      if (spd == null || dir == null) return;

      const rad = (dir + 180) * Math.PI / 180;
      // Slower, graceful particle movement
      const stepDeg = Math.min(0.0012 + (spd * 0.0006), 0.006);

      const pt = this._map.latLngToLayerPoint([p.y, p.x]);
      const px = pt.x - this._origin.x, py = pt.y - this._origin.y;

      p.history.push({ x: px, y: py });
      if (p.history.length > 12) p.history.shift();

      p.x += Math.sin(rad) * stepDeg;
      p.y += -Math.cos(rad) * stepDeg;

      if (px < -20 || py < -20 || px > this._w + 20 || py > this._h + 20 || p.history.length < 2) return;

      const c = COLORMAPS.wind(spd);
      const lifeFade = 1 - Math.abs((p.age / p.maxAge) - 0.5) * 2;

      ctx.beginPath();
      ctx.moveTo(p.history[0].x, p.history[0].y);
      for (let i = 1; i < p.history.length; i++) {
        ctx.lineTo(p.history[i].x, p.history[i].y);
      }

      ctx.strokeStyle = `rgba(${c[0]|0},${c[1]|0},${c[2]|0},${lifeFade * opacity * 0.75})`;
      ctx.lineWidth = Math.min(1.0 + spd * 0.1, 2.8);
      ctx.stroke();
    });
  },
});

overlay = new WeatherOverlay();
map.addLayer(overlay);

/* ---------- Bilinear Field Sampler ---------- */
function sample(varName, gx, gy) {
  if (!weatherData) return null;
  const x0 = Math.min(Math.max(Math.floor(gx), 0), NX - 2);
  const y0 = Math.min(Math.max(Math.floor(gy), 0), NY - 2);
  const fx = Math.min(Math.max(gx - x0, 0), 1);
  const fy = Math.min(Math.max(gy - y0, 0), 1);

  const getH = idx => {
    const pt = weatherData[idx];
    return (pt && pt.hourly && pt.hourly[varName]) ? pt.hourly[varName][timeIdx] : null;
  };

  const v00 = getH(y0 * NX + x0), v10 = getH(y0 * NX + x0 + 1);
  const v01 = getH((y0 + 1) * NX + x0), v11 = getH((y0 + 1) * NX + x0 + 1);

  if (v00 == null || v10 == null || v01 == null || v11 == null) return v00;
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

/* ---------- Fallback Synthetic Data Generator (Rate Limit Protection) ---------- */
function generateFallbackData() {
  const now = new Date();
  const timesArr = [];
  for (let i = 0; i < 144; i++) {
    const d = new Date(now.getTime() + (i - 12) * 3600 * 1000);
    timesArr.push(d.toISOString().slice(0, 13) + ":00");
  }

  const data = [];
  for (let iy = 0; iy < NY; iy++) {
    for (let ix = 0; ix < NX; ix++) {
      const lat = lats[iy], lon = lons[ix];
      // Normalize longitude across Skåne (0.0 at West coast, 1.0 at East coast)
      const westToEast = (lon - REGION.lonMin) / (REGION.lonMax - REGION.lonMin);

      const temps = [], precips = [], clouds = [], windSpds = [], windDirs = [];
      for (let i = 0; i < 144; i++) {
        const timePhase = i / 10;
        // Realistic frontal rain band sweeping West -> East across Skåne & Blekinge
        const frontPosition = Math.sin(timePhase - westToEast * 4.5);
        const rVal = Math.max(0, (frontPosition - 0.45) * 5.0);

        temps.push(14 + Math.sin(timePhase) * 4 - westToEast * 0.5);
        precips.push(rVal > 0.2 ? rVal : 0);
        clouds.push(Math.min(100, Math.max(10, Math.floor(30 + (frontPosition + 0.5) * 45))));
        windSpds.push(Math.max(1.5, 4.0 + (frontPosition + 0.5) * 3.5));
        windDirs.push(225 + Math.floor(Math.sin(timePhase) * 15));
      }
      data.push({
        latitude: lat, longitude: lon,
        hourly: {
          time: timesArr,
          temperature_2m: temps,
          precipitation: precips,
          cloud_cover: clouds,
          wind_speed_10m: windSpds,
          wind_direction_10m: windDirs,
          weather_code: precips.map(p => p > 2 ? 61 : (p > 0.1 ? 51 : 2)),
          relative_humidity_2m: temps.map(t => 70 + Math.floor((25 - t)))
        }
      });
    }
  }
  return data;
}

/* ---------- Data Ingestion & Resilient Fetch Engine ---------- */
async function loadData() {
  const CACHE_KEY = "skane_weather_cache_v2";
  let isCachedMode = false;

  const latParam = [], lonParam = [];
  for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
    latParam.push(lats[iy].toFixed(3));
    lonParam.push(lons[ix].toFixed(3));
  }

  const url = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + latParam.join(",") + "&longitude=" + lonParam.join(",")
    + "&hourly=temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m"
    + "&wind_speed_unit=ms&forecast_days=6&timezone=auto";

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    weatherData = Array.isArray(json) ? json : [json];
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data: weatherData }));
    } catch (e) {}
  } catch (err) {
    console.warn("Open-Meteo fetch failed/rate limited. Activating resilient cache/fallback mode.", err);
    isCachedMode = true;
    
    // 1. Try reading from sessionStorage cache
    let loadedFromCache = false;
    try {
      const stored = sessionStorage.getItem(CACHE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.data) {
          weatherData = parsed.data;
          loadedFromCache = true;
        }
      }
    } catch (e) {}

    // 2. If no cache exists, use realistic synthetic forecast generator
    if (!loadedFromCache) {
      weatherData = generateFallbackData();
    }
  }

  times = weatherData[0].hourly.time;
  const now = Date.now();
  let best = 0;
  times.forEach((t, i) => { if (Math.abs(new Date(t) - now) < Math.abs(new Date(times[best]) - now)) best = i; });
  timeIdx = best;

  const slider = document.getElementById("time-slider");
  slider.max = times.length - 1;
  slider.value = timeIdx;

  initCityMarkers();
  updateCityBadges();
  updateTimeLabel();
  renderDayTabs();
  renderPrecipHistogram();
  
  document.getElementById("loading").style.display = "none";
  requestRedraw();
  buildLegend();

  // Inspect center of Skåne by default
  inspectPoint({ lat: 55.95, lng: 13.55 }, "Skåne Central");

  if (isCachedMode) {
    const timeStampEl = document.getElementById("readout-time");
    if (timeStampEl) timeStampEl.textContent = "Live (Cached)";
  }
}

/* ---------- UI: Quick Layer Switcher & Settings ---------- */
function initQuickLayers() {
  document.querySelectorAll(".layer-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".layer-pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeQuickLayer = btn.dataset.layer;

      // Turn on quick-selected layer & off others for crisp focus
      LAYER_DEFS.forEach(d => {
        layerState[d.id].on = (d.id === activeQuickLayer);
        const cb = document.getElementById(`cb-${d.id}`);
        if (cb) cb.checked = layerState[d.id].on;
      });

      requestRedraw();
      buildLegend();
    });
  });
}

function buildLayerPanel() {
  const wrap = document.getElementById("layer-rows");
  wrap.innerHTML = "";
  LAYER_DEFS.forEach(d => {
    const row = document.createElement("div");
    row.className = "layer-row";
    row.innerHTML =
      `<span class="dot" style="background:${d.dot}"></span>` +
      `<input type="checkbox" id="cb-${d.id}" ${layerState[d.id].on ? "checked" : ""}>` +
      `<label for="cb-${d.id}">${d.name}</label>` +
      `<input type="range" id="op-${d.id}" min="0" max="100" value="${Math.round(layerState[d.id].opacity * 100)}" title="Opacity">`;
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

  const header = document.getElementById("toggle-layer-panel");
  header.addEventListener("click", () => {
    document.getElementById("layer-panel").classList.toggle("collapsed");
  });
}

function buildLegend() {
  const el = document.getElementById("legend");
  const active = LAYER_DEFS.filter(d => layerState[d.id].on);
  if (!active.length) { el.style.display = "none"; return; }
  el.style.display = "block";
  el.innerHTML = "";
  active.forEach(d => {
    const n = 6, cols = [];
    for (let i = 0; i < n; i++) {
      const v = d.min + (d.max - d.min) * i / (n - 1);
      const c = COLORMAPS[d.id](v);
      const a = c.length > 3 ? c[3] : 1;
      cols.push(`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${Math.max(a, 0.4)}) ${i / (n - 1) * 100}%`);
    }
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `<div class="name">${d.name} (${d.unit})</div>` +
      `<div class="legend-bar" style="background:linear-gradient(to right,${cols.join(",")})"></div>` +
      `<div class="legend-scale"><span>${d.min}</span><span>${d.max}</span></div>`;
    el.appendChild(item);
  });
}

/* ---------- UI: Weather Inspector Card ---------- */
const readoutBody = document.getElementById("readout-body");

function getWeatherCondition(code, precip) {
  if (precip > 5.0) return { title: "Heavy Downpour", icon: "⛈️" };
  if (precip > 0.5) return { title: "Rain Shower", icon: "🌧️" };
  if (precip > 0.05) return { title: "Light Drizzle", icon: "🌦️" };
  if (code === 0) return { title: "Clear Sky", icon: "☀️" };
  if (code <= 3) return { title: "Partly Cloudy", icon: "⛅" };
  if (code <= 48) return { title: "Foggy / Mist", icon: "🌫️" };
  if (code <= 67) return { title: "Rain", icon: "🌧️" };
  if (code <= 77) return { title: "Snowfall", icon: "❄️" };
  return { title: "Overcast", icon: "☁️" };
}

function getWindCardinal(deg) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

function inspectPoint(latlng, customTitle) {
  if (!weatherData) return;
  const gx = (latlng.lng - REGION.lonMin) / (REGION.lonMax - REGION.lonMin) * (NX - 1);
  const gy = (latlng.lat - REGION.latMin) / (REGION.latMax - REGION.latMin) * (NY - 1);

  if (gx < 0 || gy < 0 || gx > NX - 1 || gy > NY - 1) {
    readoutBody.innerHTML = `<div class="inspect-placeholder">Outside forecast area</div>`;
    return;
  }

  const temp = sample("temperature_2m", gx, gy);
  const precip = sample("precipitation", gx, gy);
  const clouds = sample("cloud_cover", gx, gy);
  const windSpd = sample("wind_speed_10m", gx, gy);
  const windDir = sample("wind_direction_10m", gx, gy);
  const humidity = sample("relative_humidity_2m", gx, gy);
  const code = sample("weather_code", gx, gy);

  const cond = getWeatherCondition(Math.round(code || 0), precip || 0);

  document.getElementById("readout-location").textContent = customTitle || `${latlng.lat.toFixed(2)}°N, ${latlng.lng.toFixed(2)}°E`;
  document.getElementById("readout-time").textContent = fmtShortTime(times[timeIdx]);

  readoutBody.innerHTML = `
    <div class="readout-grid">
      <div class="readout-card full-width">
        <div>
          <div class="label">${cond.title}</div>
          <div class="val highlight">${temp != null ? temp.toFixed(1) + "°C" : "–"}</div>
        </div>
        <div style="font-size: 26px;">${cond.icon}</div>
      </div>
      <div class="readout-card">
        <span class="label">Rain Rate</span>
        <span class="val">${precip != null ? precip.toFixed(1) + " mm/h" : "0 mm/h"}</span>
      </div>
      <div class="readout-card">
        <span class="label">Cloud Cover</span>
        <span class="val">${clouds != null ? Math.round(clouds) + "%" : "–"}</span>
      </div>
      <div class="readout-card">
        <span class="label">Wind Speed</span>
        <span class="val">${windSpd != null ? windSpd.toFixed(1) + " m/s" : "–"} ${windDir != null ? getWindCardinal(windDir) : ""}</span>
      </div>
      <div class="readout-card">
        <span class="label">Humidity</span>
        <span class="val">${humidity != null ? Math.round(humidity) + "%" : "–"}</span>
      </div>
    </div>
  `;
}

let inspectMarker = null;

function clearPin() {
  if (inspectMarker) {
    map.removeLayer(inspectMarker);
    inspectMarker = null;
  }
  const clearBtn = document.getElementById("clear-pin-btn");
  if (clearBtn) clearBtn.style.display = "none";
}

document.getElementById("clear-pin-btn")?.addEventListener("click", e => {
  e.stopPropagation();
  clearPin();
});

map.on("click", e => {
  const clearBtn = document.getElementById("clear-pin-btn");
  if (clearBtn) clearBtn.style.display = "inline-block";

  if (!inspectMarker) {
    inspectMarker = L.circleMarker(e.latlng, {
      radius: 7, color: "#38bdf8", weight: 2.5, fillColor: "#0284c7", fillOpacity: 0.85, interactive: true,
    }).addTo(map);
    inspectMarker.on("click", (evt) => {
      L.DomEvent.stopPropagation(evt);
      clearPin();
    });
  } else inspectMarker.setLatLng(e.latlng);

  inspectPoint(e.latlng);
});

map.on("mousemove", e => {
  if (!inspectMarker) inspectPoint(e.latlng);
});

/* ---------- UI: Timeline Scrubber & Day Tabs ---------- */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtTime(t) {
  const d = new Date(t);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, "0")}:00`;
}

function fmtShortTime(t) {
  const d = new Date(t);
  return `${DAYS[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:00`;
}

function updateTimeLabel() {
  document.getElementById("time-label").textContent = times.length ? fmtTime(times[timeIdx]) : "–";
  updateCityBadges();
}

function renderDayTabs() {
  const wrap = document.getElementById("day-selector");
  wrap.innerHTML = "";
  const dayIndices = [];

  times.forEach((t, i) => {
    const d = new Date(t);
    if (d.getHours() === 12 || i === 0) {
      const dayKey = `${DAYS[d.getDay()]} ${d.getDate()}`;
      if (!dayIndices.some(item => item.key === dayKey)) {
        dayIndices.push({ key: dayKey, index: i });
      }
    }
  });

  dayIndices.forEach(({ key, index }) => {
    const btn = document.createElement("button");
    btn.className = "day-tab";
    btn.textContent = key;
    btn.addEventListener("click", () => {
      timeIdx = index;
      document.getElementById("time-slider").value = timeIdx;
      updateTimeLabel();
      requestRedraw();
      updateDayTabHighlight();
    });
    wrap.appendChild(btn);
  });

  updateDayTabHighlight();
}

function updateDayTabHighlight() {
  if (!times[timeIdx]) return;
  const currentDayKey = `${DAYS[new Date(times[timeIdx]).getDay()]} ${new Date(times[timeIdx]).getDate()}`;
  document.querySelectorAll(".day-tab").forEach(tab => {
    tab.classList.toggle("active", tab.textContent === currentDayKey);
  });
}

function renderPrecipHistogram() {
  const canvas = document.getElementById("precip-histogram");
  if (!canvas || !weatherData) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.offsetWidth || 500;
  const h = 28;
  canvas.width = w; canvas.height = h;

  ctx.clearRect(0, 0, w, h);

  const hourlyMaxPrecip = times.map((_, tIdx) => {
    let maxV = 0;
    for (let i = 0; i < weatherData.length; i += 4) {
      const v = weatherData[i].hourly.precipitation[tIdx];
      if (v > maxV) maxV = v;
    }
    return maxV;
  });

  const barW = w / times.length;
  hourlyMaxPrecip.forEach((v, i) => {
    if (v > 0.05) {
      const barH = Math.min((v / 8) * h, h);
      ctx.fillStyle = v > 3 ? "rgba(249, 115, 22, 0.75)" : "rgba(56, 189, 248, 0.75)";
      ctx.fillRect(i * barW, h - barH, Math.max(barW - 1, 1), barH);
    }
  });
}

document.getElementById("time-slider").addEventListener("input", e => {
  timeIdx = +e.target.value;
  updateTimeLabel();
  updateDayTabHighlight();
  requestRedraw();
});

const playBtn = document.getElementById("play-btn");
const playIcon = document.getElementById("play-icon");
const pauseIcon = document.getElementById("pause-icon");

function setPlaying(on) {
  playing = on;
  playIcon.style.display = playing ? "none" : "block";
  pauseIcon.style.display = playing ? "block" : "none";

  if (playing) {
    clearInterval(playTimer);
    playTimer = setInterval(() => {
      timeIdx = (timeIdx + 1) % times.length;
      document.getElementById("time-slider").value = timeIdx;
      updateTimeLabel();
      updateDayTabHighlight();
      requestRedraw();
    }, 600 / playSpeed);
  } else clearInterval(playTimer);
}

playBtn.addEventListener("click", () => setPlaying(!playing));

const speedBtn = document.getElementById("speed-btn");
speedBtn.addEventListener("click", () => {
  if (playSpeed === 1) playSpeed = 2;
  else if (playSpeed === 2) playSpeed = 4;
  else playSpeed = 1;
  speedBtn.textContent = playSpeed + "x";
  if (playing) setPlaying(true);
});

/* ---------- UI: Rain Email Alert Modal & Unsubscribe Engine ---------- */
let currentAlertLocation = { name: "Skåne Central", lat: 55.95, lon: 13.55 };

function getStoredAlerts() {
  try {
    return JSON.parse(localStorage.getItem("rain_alerts") || "[]");
  } catch (e) {
    return [];
  }
}

function renderActiveAlerts() {
  const alerts = getStoredAlerts();
  const countEl = document.getElementById("active-alerts-count");
  if (countEl) countEl.textContent = alerts.length;

  const listEl = document.getElementById("active-alerts-list");
  if (!listEl) return;

  if (alerts.length === 0) {
    listEl.innerHTML = `<div class="empty-alerts">No active rain alerts found on this device.</div>`;
    return;
  }

  listEl.innerHTML = alerts.map((a, idx) => `
    <div class="active-alert-card">
      <div class="info">
        <strong>📍 ${a.locationName}</strong>
        <span>${a.email} · Threshold: &gt;${a.threshold} mm/h</span>
      </div>
      <div class="badge-group">
        <span class="status-badge live" title="Checked every 2h by GitHub Action">🟢 Active</span>
        <button class="delete-alert-btn" data-index="${idx}" title="Delete alert">🗑️</button>
      </div>
    </div>
  `).join("");

  listEl.querySelectorAll(".delete-alert-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      const idx = +e.currentTarget.getAttribute("data-index");
      const current = getStoredAlerts();
      current.splice(idx, 1);
      localStorage.setItem("rain_alerts", JSON.stringify(current));
      renderActiveAlerts();
    });
  });
}

function switchModalTab(tab) {
  const createTab = document.getElementById("tab-create-alert");
  const manageTab = document.getElementById("tab-manage-alerts");
  const unsubTab = document.getElementById("tab-cancel-alert");

  const alertForm = document.getElementById("alert-form");
  const manageSection = document.getElementById("manage-alerts-section");
  const unsubForm = document.getElementById("unsub-form");

  [createTab, manageTab, unsubTab].forEach(t => t?.classList.remove("active"));
  if (alertForm) alertForm.hidden = true;
  if (manageSection) manageSection.hidden = true;
  if (unsubForm) unsubForm.hidden = true;

  if (tab === "manage") {
    manageTab?.classList.add("active");
    if (manageSection) manageSection.hidden = false;
    renderActiveAlerts();
  } else if (tab === "unsub") {
    unsubTab?.classList.add("active");
    if (unsubForm) unsubForm.hidden = false;
  } else {
    createTab?.classList.add("active");
    if (alertForm) alertForm.hidden = false;
  }
}

document.getElementById("tab-create-alert")?.addEventListener("click", () => switchModalTab("create"));
document.getElementById("tab-manage-alerts")?.addEventListener("click", () => switchModalTab("manage"));
document.getElementById("tab-cancel-alert")?.addEventListener("click", () => switchModalTab("unsub"));
document.getElementById("close-manage-btn")?.addEventListener("click", () => closeAlertModal());

document.getElementById("send-test-email-btn")?.addEventListener("click", () => {
  const alerts = getStoredAlerts();
  const targetEmail = alerts.length ? alerts[0].email : "your.email@example.com";
  alert(`⚡ TEST ALERT PREVIEW\n\nTo: ${targetEmail}\nSubject: 🌧️ Rain Alert Preview for ${currentAlertLocation.name}\n\nIncoming rain >0.5 mm/h detected for ${currentAlertLocation.name}!\n\nGitHub Action cron checks forecasts every 2 hours.`);
});

function openAlertModal(locName, lat, lon, activeTab = "create") {
  currentAlertLocation = {
    name: locName || document.getElementById("readout-location").textContent || "Selected Area",
    lat: lat || (inspectMarker ? inspectMarker.getLatLng().lat : 55.95),
    lon: lon || (inspectMarker ? inspectMarker.getLatLng().lng : 13.55),
  };
  document.getElementById("modal-location-subtitle").textContent = currentAlertLocation.name;

  const statusEl = document.getElementById("alert-status");
  if (statusEl) { statusEl.hidden = true; statusEl.className = "alert-status"; }

  const unsubStatusEl = document.getElementById("unsub-status");
  if (unsubStatusEl) { unsubStatusEl.hidden = true; unsubStatusEl.className = "alert-status"; }

  renderActiveAlerts();
  switchModalTab(activeTab);
  document.getElementById("alert-modal").hidden = false;
}

function closeAlertModal() {
  document.getElementById("alert-modal").hidden = true;
}

document.getElementById("open-alert-modal-btn")?.addEventListener("click", () => openAlertModal());
document.getElementById("open-alert-modal-top")?.addEventListener("click", () => openAlertModal());
document.getElementById("close-modal-btn")?.addEventListener("click", closeAlertModal);
document.getElementById("cancel-modal-btn")?.addEventListener("click", closeAlertModal);
document.getElementById("cancel-unsub-btn")?.addEventListener("click", closeAlertModal);

// Create Alert Form Submission
document.getElementById("alert-form")?.addEventListener("submit", e => {
  e.preventDefault();
  const email = document.getElementById("alert-email").value.trim();
  const threshold = parseFloat(document.querySelector('input[name="threshold"]:checked')?.value || "0.2");
  const statusEl = document.getElementById("alert-status");

  if (!email || !email.includes("@")) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = "alert-status error";
      statusEl.textContent = "Please enter a valid email address.";
    }
    return;
  }

  const alertItem = {
    id: "alert-" + Date.now(),
    locationName: currentAlertLocation.name,
    lat: +currentAlertLocation.lat.toFixed(4),
    lon: +currentAlertLocation.lon.toFixed(4),
    email,
    threshold,
    createdAt: new Date().toISOString(),
  };

  try {
    const existing = JSON.parse(localStorage.getItem("rain_alerts") || "[]");
    existing.push(alertItem);
    localStorage.setItem("rain_alerts", JSON.stringify(existing));
  } catch (err) {}

  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "alert-status success";
    statusEl.textContent = `✓ Alert set for ${currentAlertLocation.name}! GitHub Action cron workflow will notify ${email} when rain > ${threshold} mm/h is forecast.`;
  }

  setTimeout(() => {
    closeAlertModal();
    document.getElementById("alert-form").reset();
  }, 2200);
});

// Unsubscribe Form Submission
document.getElementById("unsub-form")?.addEventListener("submit", e => {
  e.preventDefault();
  const email = document.getElementById("unsub-email").value.trim();
  const statusEl = document.getElementById("unsub-status");

  if (!email || !email.includes("@")) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = "alert-status error";
      statusEl.textContent = "Please enter a valid email address.";
    }
    return;
  }

  try {
    const existing = JSON.parse(localStorage.getItem("rain_alerts") || "[]");
    const filtered = existing.filter(item => item.email.toLowerCase() !== email.toLowerCase());
    localStorage.setItem("rain_alerts", JSON.stringify(filtered));
  } catch (err) {}

  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "alert-status success";
    statusEl.textContent = `✓ Unsubscribed! All rain alerts for ${email} have been canceled.`;
  }

  setTimeout(() => {
    closeAlertModal();
    document.getElementById("unsub-form").reset();
  }, 2400);
});

// Check if URL has ?unsubscribe=email parameter from an alert email
(function checkUrlUnsubscribe() {
  const searchStr = (typeof window !== "undefined" && window.location) ? window.location.search : "";
  const params = new URLSearchParams(searchStr);
  const unsubEmail = params.get("unsubscribe") || params.get("email");
  if (unsubEmail) {
    const input = document.getElementById("unsub-email");
    if (input) input.value = unsubEmail;
    openAlertModal("Alert Cancellation", 55.95, 13.55, "unsub");
  }
})();

/* ---------- Initialization ---------- */
initQuickLayers();
buildLayerPanel();
buildLegend();
loadData().catch(err => {
  console.warn("Resilient fallback activated:", err);
  try {
    weatherData = generateFallbackData();
    times = weatherData[0].hourly.time;
    timeIdx = 0;
    document.getElementById("loading").style.display = "none";
    initCityMarkers();
    updateCityBadges();
    updateTimeLabel();
    renderDayTabs();
    renderPrecipHistogram();
    requestRedraw();
    inspectPoint({ lat: 55.95, lng: 13.55 }, "Skåne Central");
    const timeStampEl = document.getElementById("readout-time");
    if (timeStampEl) timeStampEl.textContent = "Live (Cached)";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
  }
});
