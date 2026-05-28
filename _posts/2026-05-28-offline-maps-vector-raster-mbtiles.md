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

This is the pipeline I built to ship offline basemaps for [CamperMate](https://campermate.com) — the go-to free-camping and campground app across Australia and New Zealand, [iOS](https://apps.apple.com/app/campermate/id578975305) and [Android](https://play.google.com/store/apps/details?id=nz.co.campermate.app), 1M+ downloads, made at [Triptech Travel](https://triptechtravel.com). Users are in Fiordland, Kakadu, the Pilbara, the Tasmanian highlands. Cell coverage is a luxury, not a baseline. If the map doesn't work without bars, the app doesn't work. The pipeline below is platform-agnostic — the output is a `.mbtiles` SQLite file that any client can read. I'll walk through how it ships in a React Native consumer at the end, but the pipeline itself is independent of where the bytes are rendered.

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

- **Planetiler needs Java 21+.** If you have Zulu 17 installed for Android dev you'll see `UnsupportedClassVersionError: class file version 65.0`. The Docker image avoids the JDK juggle.
- **OpenMapTiles styles ship with Maptiler-hosted source URLs.** The default Positron `style.json` points at `api.maptiler.com` and needs a key. Rewrite `sources.openmaptiles.url` to `mbtiles://{openmaptiles}` and let tileserver-gl resolve it from the local MBTiles: `jq '.sources.openmaptiles = { type: "vector", url: "mbtiles://{openmaptiles}" }' positron.json > positron.local.json`.
- **Fonts are not in the `openmaptiles/fonts` master branch.** Master ships only TTF sources. The pre-built PBF glyph ranges are in the [v2.0 release asset](https://github.com/openmaptiles/fonts/releases/tag/v2.0). Without them tileserver-gl 500s on every tile containing a label, which is everything past z4.
- **Planetiler writes `bounds` and `center` metadata that breaks MapLibre GL Native.** Strip them after planetiler runs: `sqlite3 *.mbtiles "DELETE FROM metadata WHERE name IN ('bounds', 'center');"`.

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

The patch is ~750 lines across iOS and Android, applied via [`patch-package`](https://github.com/ds300/patch-package). It teaches `MapTileProvider` (Android) and `AIRMapUrlTile` (iOS) to detect the `mbtiles://` URL scheme and route to a new SQLite-backed tile reader instead of the HTTP path. The internals — connection caching, TMS y-flip, overzoom via in-memory parent-bitmap reuse — are a separate post. The user-facing surface is exactly the snippet above. I'll open-source the patch once it's been in production for a few weeks; [issue #5863](https://github.com/react-native-maps/react-native-maps/issues/5863) tracks it.

## Region splits and zoom levels

Two practical decisions shape the file layout. **Where to split** comes from how Geofabrik ships data: country-level PBFs for NZ (split by bbox into north/south islands with `osmium extract`), per-state PBFs for AU (no slicing needed). The split should also match how users travel — for a campervan app, per-island and per-state is the right grain because that's what people fly between.

**How deep to render** is the other consequential decision. Each zoom level quadruples tile count, and real-world size grows faster than the math suggests because inked tiles compress worse than empty ones. I shipped NZ at native z15 (full Apple-Maps-style detail: trail heads, suburb names, motorway shields, ~1.8 GB per island after dedup). AU at native z14 with overzoom (the patch stretches the largest available tile up to z18) is a 4× saving across an entire continent — road names still readable, dense urban POI labels the only loss. The asymmetry is deliberate: NZ is small enough that z15 doesn't blow up storage, AU isn't.

## The dedup schema — 50% savings for free

The MBTiles spec defines two acceptable schemas. The naive one — a single `tiles(zoom_level, tile_column, tile_row, tile_data)` table — is what most ad-hoc scripts produce. The normalised one trades a tiny bit of read complexity for **massive** storage savings:

```sql
CREATE TABLE images (tile_id TEXT PRIMARY KEY, tile_data BLOB);
CREATE TABLE map (zoom_level, tile_column, tile_row, tile_id);
CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row);
CREATE VIEW tiles AS
  SELECT map.zoom_level, map.tile_column, map.tile_row, images.tile_data
  FROM map JOIN images ON images.tile_id = map.tile_id;
```

`tile_id` is `sha1(tile_data)`. Identical tiles — every "pure ocean" tile, every patch of empty desert at mid-zoom, every uniform Southern Alps slope at z15 — collapse to one row in `images`, with many rows in `map` pointing at the same tile_id.

The `tiles` VIEW makes this completely transparent to consumers. Any `SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?` works identically against either schema.

The measured impact on NZ:

- **nz-north**: 716,859 tiles → 1.9 GB on disk (51% saving)
- **nz-south**: 859,891 tiles → 242,217 unique blobs (**71.8% tile dedup rate**), 1.8 GB on disk (57% saving)

Why so high? A region the size of New Zealand has *enormous* repetition at mid-zooms — endless ocean tiles, identical bush-cover tiles in the Fiordland interior, hundreds of identical "purple Southern Alps shading" tiles. Dense urban tiles (Auckland CBD) are all unique and don't dedup, but they're a small fraction of any region's total tile count.

Hashing every tile during pack adds CPU but it's microseconds per tile — invisible compared to the actual rendering time. Reading via the VIEW adds one indexed JOIN which doesn't measurably affect tile-fetch latency on mobile.

R2 cost: **~$0.15/month storage**, and **egress to devices is free** — the killer feature R2 has over S3. A user who only ever visits Tasmania downloads 376 MB once, free, and never pays storage either. The "I'm doing all of NSW" worst case is ~1.3 GB — acceptable on Wi-Fi as a one-time op.

## Style picks

For CamperMate I tested the free OpenMapTiles styles. All open-licensed, all render against the same vector MBTiles:

- **Positron** — minimal, white, designed as a backdrop for *other* content. Beautiful but wrong for an "offline map replacement" use case where the map *is* the content.
- **OSM Bright** — what I shipped with. Coloured roads, green parks, blue water, motorway shields, full POI labels. Reads like Apple Maps in light mode.
- **Dark Matter** — dark-mode equivalent of Positron. Future option for a night-mode toggle.

The aesthetic decision changes which file you ship to users; it doesn't change anything upstream. Vector MBTiles → re-render → upload. Hours, not days.

## Wrapping up

If you're building any kind of outdoor, overland, or regional travel app and your users care about offline coverage, this pipeline is repeatable. The tools are mature, the licensing is permissive (OSM is ODbL, the styles are BSD/MIT, planetiler is Apache-2, tileserver-gl is BSD-2), the storage is cheap, and the aesthetic is finally something you can put in a shipping app without an apology.

If you're heading to Australia or New Zealand and want to see the pipeline in production, [grab CamperMate on iOS](https://apps.apple.com/app/campermate/id578975305) or [Android](https://play.google.com/store/apps/details?id=nz.co.campermate.app) — free, no account required, offline maps under the "Downloads" tab. Your offline maps don't have to look like 2013 anymore.

---

*Header photo by [Marek Piwnicki](https://unsplash.com/@marekpiwnicki) on [Unsplash](https://unsplash.com).*
