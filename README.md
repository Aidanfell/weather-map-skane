# Skåne & Blekinge Weather Map

**Live: https://aidanfell.github.io/weather-map-skane/**

An interactive meteorological map covering only southern Sweden (Skåne & Blekinge).
Pure static site — no build step, no API key. Data: [Open-Meteo](https://open-meteo.com/) (free).

## Features

- Leaflet map locked to the Skåne / Blekinge region (dark CARTO basemap)
- Live 72 h forecast from Open-Meteo on a 15×9 point grid over the region
- Three focused layers (toggle + opacity slider each):
  - **Precipitation** — radar-style blobs (green → yellow → red), drawn only where it rains
  - **Wind** — arrows: colour = speed, direction = where the wind is going
  - **Temperature** — coloured numbers directly on the map
- Time slider with play/pause animation (autoplays on load)
- Hover anywhere for exact interpolated values; legend per active layer

## Run locally

```bash
cd D:\weather-map-skane
python -m http.server 8000
```

Then open http://localhost:8000

(Any static server works, e.g. `npx serve`.)

## Publish for free

**GitHub Pages**

```bash
cd D:\weather-map-skane
git init && git add -A && git commit -m "Weather map"
gh repo create weather-map-skane --public --source=. --push
gh api repos/{owner}/weather-map-skane/pages -X POST -f "build_type=workflow" -f "source[branch]=main" -f "source[path]=/"
```

(or enable Pages under repo Settings → Pages → deploy from branch `main`, root).
Site goes live at `https://<user>.github.io/weather-map-skane/`.

**Netlify**: `npx netlify deploy --dir . --prod` (drag-and-drop the folder at app.netlify.com also works).

**Vercel**: `npx vercel --prod` in this folder.
