# ATTRACT MODE

A single-page browser game built with [Three.js](https://threejs.org/): it opens as a
Space Invaders attract screen, pulls back to reveal the arcade cabinet, then launches
into an orbital Earth-defense sequence — one continuous WebGL scene.

## ▶ Play

**https://alexshen1227-spec.github.io/Space-Invader-Game/**

(Deployed automatically from `main` via GitHub Pages.)

## Run locally

The page is fully self-contained — `index.html` has the game inlined and pulls Three.js
from a CDN — but `file://` blocks ES-module imports, so serve it over HTTP:

```bash
python -m http.server 8123
# then open http://localhost:8123/
```

## Project layout

| File | Purpose |
| --- | --- |
| `index.html` | The deployable page. Contains the importmap, all UI/CSS, and an **inlined copy of `main.js`**. This is what GitHub Pages serves. |
| `main.js` | Source of truth for the game logic. After editing, re-inline it into `index.html`. |
| `.github/workflows/deploy-pages.yml` | Builds and publishes the site to GitHub Pages on every push to `main`. |

> **Note:** `index.html` ships with `main.js` inlined so the file works when opened
> directly. After changing `main.js`, replace the inline `<script type="module">…</script>`
> block in `index.html` with the new contents before committing.
