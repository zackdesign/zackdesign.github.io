---
layout: post
title: "Offline maps that look like 2026, not 2013 — a vector→raster MBTiles pipeline"
description: "How to ship offline basemaps with a modern MapLibre aesthetic (Positron, OSM Bright) from OpenStreetMap data: OSM PBF → planetiler → tileserver-gl → raster MBTiles → Cloudflare R2. Platform-agnostic, free, no API keys, no Mapbox bill. The pipeline I built for CamperMate."
excerpt: "OSM → planetiler → tileserver-gl → raster MBTiles → Cloudflare R2. A platform-agnostic pipeline for shipping offline basemaps with a modern MapLibre aesthetic — free, no API keys, no Mapbox bill. Built for CamperMate."
image: /images/blog/offline-maps-pipeline.jpg
image_alt: A small campervan on a rural road at twilight beneath a perfectly conical mountain — the kind of place cell coverage runs out and offline maps start mattering
date: 2026-05-28
last_modified_at: 2026-05-28
categories: [engineering]
tags: [offline-maps, mbtiles, openmaptiles, openstreetmap, planetiler, tileserver-gl, maplibre, cloudflare-r2, react-native, campermate]
---

Most "offline maps" tutorials route you through one of two corners. **Corner A** is a 2013-era Mapnik stack rendering OSM-Carto — beautiful in its day, but the day is over. **Corner B** is a paid Mapbox or MapTiler subscription that solves the aesthetic problem and bills you for the privilege. There's a third corner that no tutorial walks you to: a fully self-hosted vector-to-raster pipeline using modern open-source tools, producing tiles that look like Mapbox or Apple Maps, hosted on object storage with free egress.

This is the pipeline I built to ship offline basemaps for [CamperMate](https://campermate.com) — the camping and free-camping app I work on at [Triptech Travel](https://triptechtravel.com). Users are in Fiordland, Kakadu, the Pilbara, the Tasmanian highlands. Cell coverage is a luxury, not a baseline. If the map doesn't work without bars, the app doesn't work. The pipeline below is platform-agnostic — the output is a `.mbtiles` SQLite file that any client can read. I'll walk through how it ships in a React Native consumer at the end, but the pipeline itself is independent of where the bytes are rendered.

No MapLibre migration. No Mapbox bill. No awful Mapnik-from-2013 cartography.

<!-- more -->

## The wrong path: Mapnik with OSM-Carto

The first thing every "offline OSM tiles" guide tells you is to spin up [`overv/openstreetmap-tile-server`](https://hub.docker.com/r/overv/openstreetmap-tile-server/) — a Docker container with `osm2pgsql`, PostGIS, and Mapnik rendering the canonical `openstreetmap-carto` style. That's what powers `openstreetmap.org`.

I tried it. The pipeline works, but the output looks like 2013. Olive landuse fills, mustard buildings, brick-coloured motorways, that classic OSM look that every modern map product has moved on from. It's not what people expect when they tap "offline maps" in 2026.

It's also a *single-stage* pipeline that's deceptively hard to evolve. Want to tweak the aesthetic? You're editing CartoCSS and re-baking from PostGIS. Want a different style entirely? You're rebuilding the whole stack. Mapnik is excellent at what it does, but what it does is render in a tradition that no longer matches what mobile users see daily on Apple Maps and Google Maps.

## The right path: vector → raster with MapLibre GL Native

The trick is to **split rendering from data extraction**:

```
                 (one-time per region)              (per style)
                       ↓                                ↓
   OSM PBF  →  planetiler  →  vector MBTiles  →  tileserver-gl  →  raster MBTiles
                                  (single source of truth)            (re-renderable
                                                                       any time)
```

Two stages. The vector MBTiles is a *neutral* intermediate — same data, no styling. The raster MBTiles is what your app loads. You can re-render the raster in any MapLibre GL style — Positron, OSM Bright, Voyager, Dark Matter, a custom one — without touching the data pipeline.

Stage 1 (`planetiler`) is **minutes**. Stage 2 (`tileserver-gl`) is **CPU-bound rendering** — minutes for a city, hours for a country. Both run from Docker, both are open source, neither requires a third-party API key.

The rendering engine is [MapLibre GL Native](https://github.com/maplibre/maplibre-native), the same C++ engine that powers Mapbox GL JS and MapLibre GL JS on the web. That's why the output looks identical to a modern web map — because it *is* a modern web map, rendered offline.

## The tools

| Tool | Job | License |
|---|---|---|
| [Geofabrik](https://download.geofabrik.de) | OSM PBF source data, per country and per state | ODbL |
| [`osmium-tool`](https://osmcode.org/osmium-tool/) | Slice country PBFs into city/region bboxes | GPL-3 |
| [`planetiler`](https://github.com/onthegomap/planetiler) | OSM PBF → vector MBTiles (OpenMapTiles schema) | Apache-2 |
| [`tileserver-gl`](https://github.com/maptiler/tileserver-gl) | Vector MBTiles + GL style → raster PNG via MapLibre GL Native | BSD-2 |
| [OpenMapTiles fonts](https://github.com/openmaptiles/fonts) | Pre-built glyph PBFs for label rendering | OFL |
| [OpenMapTiles styles](https://github.com/openmaptiles) | Free MapLibre GL styles (Positron, OSM Bright, Dark Matter) | BSD-3 |

All free. No keys. No bills. The whole stack runs on a MacBook.

## The build script

The CamperMate offline-tiles build script is ~200 lines of bash that wires those tools together. Inputs: a region name, a Geofabrik path, a bbox, a max-zoom, a style name. Output: a single `.mbtiles` file ready to upload.

```bash
# NZ South Island, z0–15, rendered in OSM Bright
scripts/build-offline-tiles.sh nz-south \
  australia-oceania/new-zealand \
  '166.4,-47.3,174.5,-40.4' \
  15 \
  osm-bright
```

The pipeline:

```bash
# 1. Cache the source PBF (one-time per Geofabrik region)
curl -fL -o offline-tiles/pbf/nz.osm.pbf \
  https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf

# 2. Slice by bbox (skipped when Geofabrik already has per-state PBFs)
osmium extract --bbox=166.4,-47.3,174.5,-40.4 --strategy=smart --set-bounds \
  -o offline-tiles/pbf/nz-south-extract.osm.pbf \
  offline-tiles/pbf/nz.osm.pbf

# 3. Generate vector MBTiles with planetiler (OpenMapTiles schema)
docker run --rm -e JAVA_TOOL_OPTIONS="-Xmx4g" -v offline-tiles:/data \
  ghcr.io/onthegomap/planetiler:latest \
    --osm_path=/data/pbf/nz-south-extract.osm.pbf \
    --mbtiles=/data/nz-south-vector.mbtiles \
    --bounds=166.4,-47.3,174.5,-40.4 --maxzoom=15 --download --force

# 4. Render vector → raster via tileserver-gl
docker run -d --name tileserver-gl-nz-south -p 8765:8080 \
  -v offline-tiles:/data \
  maptiler/tileserver-gl:latest \
    -c /data/tileserver-config-nz-south.json

# 5. curl-loop every tile in the bbox; pack into raster MBTiles
python3 render_and_pack.py nz-south '166.4,-47.3,174.5,-40.4' 15
```

A few non-obvious things that took me a day to learn:

### Planetiler needs Java 21+

If you have Zulu 17 installed for Android development, you'll see `UnsupportedClassVersionError: class file version 65.0`. Either install a second JDK or run planetiler from its Docker image (`ghcr.io/onthegomap/planetiler:latest`). I picked Docker — pinned runtime, no JDK juggling.

### OpenMapTiles styles ship with Maptiler-hosted source URLs

The default Positron `style.json` references `api.maptiler.com` and needs an API key. For local rendering, rewrite the style's `sources.openmaptiles.url` to `mbtiles://{openmaptiles}` and let tileserver-gl resolve it from the local MBTiles via its config:

```bash
jq '.sources.openmaptiles = { type: "vector", url: "mbtiles://{openmaptiles}" }' \
  positron.json > positron.local.json
```

### Fonts are not in the `openmaptiles/fonts` master branch

`master` only has the TTF source files. The pre-built PBF glyph ranges are in the [v2.0 release asset](https://github.com/openmaptiles/fonts/releases/tag/v2.0). Without those, tileserver-gl 500s on every tile that contains a label — which is everything past zoom 4. Took me a 1652-error run to figure that out.

### Planetiler writes `bounds` and `center` metadata that breaks MapLibre GL Native

Strip them after planetiler runs:

```bash
sqlite3 nz-south-vector.mbtiles \
  "DELETE FROM metadata WHERE name IN ('bounds', 'center');"
```

### The `vt-raster-converter` README is misleading

There's no published Docker image. `docker pull ghcr.io/smart-mapping/vt-raster-converter:latest` returns `manifest unknown`. The README says "build locally with `docker compose up --build`" — but `tileserver-gl` (which uses the same MapLibre GL Native engine) has a real published image and a render endpoint at `/styles/<id>/{z}/{x}/{y}.png`. Use that instead and `curl`-loop the tiles out.

## Shipping it in a React Native app

The pipeline above is platform-agnostic — the output is just an MBTiles file. Web clients can read it via MapLibre GL JS + the [`mbtiles` protocol plugin](https://github.com/maplibre/maplibre-gl-mbtiles). Native iOS / Android can read it via their SQLite stack directly. Flutter has [`flutter_map`](https://docs.fleaflet.dev/) with MBTiles plugins. The thing that needs care is *how* the consumer reads tile bytes from the archive.

For CamperMate's React Native app, the existing map stack is `react-native-maps`, which wraps Google Maps (Android) and Apple MapKit (iOS). Both expose a `<UrlTile>` primitive — but it expects an HTTP URL template:

```jsx
<UrlTile urlTemplate="https://server/{z}/{x}/{y}.png" />
```

That's fine for online tile servers. For an offline `.mbtiles` archive, there are three obvious options, all bad:

1. **Pre-extract `{z}/{x}/{y}.png` files and use `<LocalTile>`.** Loses MBTiles' single-file storage win and doesn't work over a CDN.
2. **Run a localhost HTTP server inside the app** that serves tiles from the archive on demand. Adds startup cost, port management, battery, and JS-bridge contention per tile.
3. **Switch to MapLibre RN.** Solves the problem natively. But it's an entire map-view replacement, losing every line of code that touches markers, callouts, gesture handlers, and providers.

The fourth option — and the one I shipped — is a **small native patch** to `react-native-maps` that teaches `<UrlTile>` to read tile bytes directly from an MBTiles SQLite file via a custom `mbtiles://` URL scheme. The JSX surface stays identical:

```jsx
<UrlTile
  urlTemplate="mbtiles:///var/.../offline/nz-north.mbtiles"
  maximumNativeZ={15}
  maximumZ={18}
  shouldReplaceMapContent
/>
```

The patch is ~700 lines across iOS and Android, applied via [`patch-package`](https://github.com/ds300/patch-package). It teaches `MapTileProvider` (Android) and `AIRMapUrlTile` (iOS) to detect the `mbtiles://` URL scheme and route to a new SQLite-backed tile reader instead of the HTTP path.

Highlights:

- **Android (`MBTilesReader.java`):** LRU connection pool capped at 3 open SQLite handles, TMS y-flip per the MBTiles spec, vector-format gate (rejects `.pbf` archives with a clear log because MapKit/Google Maps can't render vector), `OutOfMemory`/`SQLiteException` recovery, stale-handle eviction.
- **iOS (`AIRMapMBTilesOverlay.m`):** `MKTileOverlay` subclass with a cached prepared statement per connection, `@synchronized`-protected stmt access (so concurrent tile fetches share one connection safely), CoreImage-based overzoom for `z > maximumNativeZ` (because MapKit's built-in overzoom isn't reliable for arbitrary `MKTileOverlay` subclasses).
- **JSX:** unchanged. Same `<UrlTile>` component, just a different URL scheme.

I'll open-source the patch on GitHub once it's been in production for a few weeks. Until then, the [react-native-maps issue #5863](https://github.com/react-native-maps/react-native-maps/issues/5863) and PR #5878 give the context.

## Per-region strategy

Two practical insights drove the file layout:

**For NZ:** Geofabrik only ships a country-level PBF. The North/South Island split is done with `osmium extract --bbox=...` from the country PBF, then planetiler runs against the slice. Two files (`nz-north.mbtiles`, `nz-south.mbtiles`) match how campervan trips actually work — most trips are one island, and the Cook Strait ferry costs $200+ for a camper so people fly + swap vehicles. There's no point forcing a combined download when one island will do.

**For AU:** Geofabrik already publishes per-state PBFs (`australia-oceania/australia/queensland`, etc.). No osmium step. Seven state files (NSW + ACT bundled together per Geofabrik's grouping), each downloaded independently. Again, this matches reality: campervan users fly between Australian states, they don't drive Sydney to Perth.

I shipped NZ at z15 (full Apple-Maps-style detail: trail heads, suburb names, motorway shields) and AU at z14 with overzoom (one zoom level lower native + the patch stretches z14 tiles for higher display zooms). The asymmetry is deliberate — NZ is small enough that z15 doesn't blow up storage; AU is so big that z14 is a 4× saving across an entire continent, and Australian campervan users mostly need road navigation rather than dense urban POI detail.

| Region | Native max-z | Real size | Real users download |
|---|---|---|---|
| NZ North | z15 | **3.5 GB** | "I'm doing North Island" |
| NZ South | z15 | ~3 GB (est.) | "I'm doing South Island" |
| AU TAS | z14 | ~250 MB (est.) | Tasmania loop |
| AU VIC | z14 | ~700 MB (est.) | Melbourne + Great Ocean Rd |
| AU SA  | z14 | ~500 MB (est.) | Adelaide + Flinders |
| AU NT  | z14 | ~400 MB (est.) | Darwin + Uluru + Stuart Hwy |
| AU WA  | z14 | ~900 MB (est.) | Perth → Margaret River → Pilbara |
| AU NSW (+ACT) | z14 | ~1 GB (est.) | Sydney trip |
| AU QLD | z14 | ~1.2 GB (est.) | Brisbane → Cairns |
| **Total** | | **~12 GB on R2** | One region per trip |

(The z15 NZ tiles came in 3–4× bigger than my first-pass estimate. Lesson: OpenMapTiles + OSM Bright produces dense, inked tiles for populated regions, and "small region scaled linearly" is not a safe extrapolation. The AU z14 numbers are post-NZ recalibrated.)

R2 cost: **~$0.20/month storage**, and **egress to devices is free** — the killer feature R2 has over S3. A user who only ever visits Tasmania downloads 250 MB once, free, and never pays storage either. A worst-case "I'm doing all of NSW" download is ~1 GB — acceptable on Wi-Fi as a one-time op.

## The native zoom vs overzoom decision

The native max zoom is the most consequential single parameter. Each level quadruples tile count, and the real-world size on a populated region is bigger than the math suggests because inked tiles compress less efficiently:

| Native max-z | NZ North actual / projected | Trail head labels visible? |
|---|---|---|
| z14 | ~900 MB | Geometry yes, names usually no |
| **z15** | **3.5 GB** (measured) | Yes |
| z16 | ~14 GB | Yes (overkill) |
| z17 | ~55 GB | Definitely overkill |

z15 is the sweet spot for an Apple Maps replacement when storage isn't a constraint — trail head POIs, road names, settlement labels are all rendered. For continent-scale coverage (Australia), **z14 with overzoom is the practical compromise**: 4× cheaper storage, road names still readable, dense urban POI detail is the only thing lost. Above the native max the device overzooms — stretches the largest available tile up to z18 — which looks blocky at street zoom but is recognisable enough for orientation.

The on-device overzoom is implemented in the native patch (not relying on MapKit's built-in behaviour, which is unreliable for `MKTileOverlay` subclasses). On Android the patch reads the parent z15 tile from SQLite and upscales via `Bitmap` + `Canvas`. On iOS it does the same via `CoreImage`. Same logic both platforms.

## Style picks

For CamperMate I tested four free MapLibre styles. All free, all open-licensed, all render against the same vector MBTiles:

- **Positron** — minimal, white, designed as a backdrop for *other* content. Beautiful but wrong for an "offline map replacement" use case where the map *is* the content.
- **OSM Bright** — what I shipped with. Coloured roads, green parks, blue water, motorway shields, full POI labels. Reads like Apple Maps in light mode.
- **Voyager** — middle ground; not actually hosted by OpenMapTiles, lives on CartoDB's repo.
- **Dark Matter** — dark mode equivalent of Positron. Future option for a night-mode toggle.

The aesthetic decision changes which file you ship to users; it doesn't change anything upstream. Vector MBTiles → re-render → upload. Hours, not days.

## What CamperMate ships

[CamperMate](https://campermate.com) is on iOS and Android — the go-to free-camping and campground app across Australia and New Zealand. Offline maps are an opt-in feature: users pick a region, the app downloads the appropriate `.mbtiles` file from R2 (free egress, attribution-required), and the `mbtiles://` UrlTile renders it directly with no network round-trips.

If you're building any kind of outdoor / overland / regional travel app on React Native and your users care about offline coverage, this pipeline is repeatable. The tools are mature, the licensing is permissive (OSM is ODbL, the styles are BSD/MIT, planetiler is Apache-2, tileserver-gl is BSD-2), the storage is cheap, and the aesthetic is finally something you can put in a shipping app without an apology.

If you want to reproduce the pipeline, the gist is:

1. `docker pull ghcr.io/onthegomap/planetiler:latest`
2. `docker pull maptiler/tileserver-gl:latest`
3. Download the [openmaptiles/fonts v2.0 release zip](https://github.com/openmaptiles/fonts/releases/tag/v2.0)
4. Download an OpenMapTiles style JSON (Positron or OSM Bright)
5. Get an OSM PBF from Geofabrik
6. Run planetiler, then tileserver-gl, then `curl`-loop the bbox
7. Pack the resulting PNGs into a SQLite MBTiles file
8. Upload to R2 (or any object store with free or cheap egress)

And if you ship on React Native, [patch `react-native-maps`](https://github.com/react-native-maps/react-native-maps/pulls?q=is%3Apr+author%3Aisaacrowntree) to grok `mbtiles://`. Or wait for me to upstream it.

Either way — your offline maps don't have to look like 2013 anymore.

---

*Header photo by [Marek Piwnicki](https://unsplash.com/@marekpiwnicki) on [Unsplash](https://unsplash.com).*
