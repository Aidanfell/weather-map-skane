# Skåne & Blekinge Weather Map

An interactive meteorological map covering only southern Sweden (Skåne & Blekinge).
Pure static site — no build step, no API key. Data: [Open-Meteo](https://open-meteo.com/) (free).

## Features

- Leaflet map locked to the Skåne / Blekinge region (dark CARTO basemap)
- Live forecast data from Open-Meteo on a 15×9 point grid over the region
- Toggleable / opacity-adjustable layers:
  - Cloud cover
  - Precipitation (mm/h)
  - Temperature
  - Wind speed + animated direction arrows
  - Air pressure
  - Humidity
- Time slider (72 h forecast) with play/pause animation
- Hover anywhere on the map for exact interpolated values
- Dynamic legend per active layer

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
