---
layout: post
title: "Offline maps that look like 2026, not 2013 — a vector→raster MBTiles pipeline"
description: "How to ship offline basemaps with a modern MapLibre aesthetic (Positron, OSM Bright) from OpenStreetMap data: OSM PBF → planetiler → tileserver-gl → raster MBTiles → Cloudflare R2. Platform-agnostic, free, no API keys, no Mapbox bill. The pipeline I built for CamperMate."
excerpt: "OSM → planetiler → tileserver-gl → raster MBTiles → Cloudflare R2. A platform-agnostic pipeline for shipping offline basemaps with a modern MapLibre aesthetic — free, no API keys, no Mapbox bill. Built for CamperMate."
image: /images/blog/offline-maps-pipeline.jpg
image_alt: A small campervan on a rural road at twilight beneath a perfectly conical mountain — the kind of place cell coverage runs out and offline maps start mattering
date: 2026-05-28
last_modified_at: 2026-09-01
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

Stage 1 (`planetiler`) is minutes for a region, tens of minutes for a continent. Stage 2 (`tileserver-gl`) is **CPU-bound rendering** — minutes for a city, hours for a country. Both are open source and neither needs a third-party API key. tileserver-gl runs from Docker; planetiler ships a jar, which is the better choice for an unattended build (see below).

The rendering engine is [MapLibre GL Native](https://github.com/maplibre/maplibre-native), the same C++ engine that powers Mapbox GL JS and MapLibre GL JS on the web. That's why the output looks identical to a modern web map — because it *is* a modern web map, rendered offline.

## The tools

| Tool | Job | License |
|---|---|---|
| [Geofabrik](https://download.geofabrik.de) | OSM PBF source data, plus a `.poly` boundary per extract | ODbL |
| [`osmium-tool`](https://osmcode.org/osmium-tool/) | Slice national PBFs to a region polygon | GPL-3 |
| [`planetiler`](https://github.com/onthegomap/planetiler) | OSM PBF → vector MBTiles (OpenMapTiles schema) | Apache-2 |
| [`tileserver-gl`](https://github.com/maptiler/tileserver-gl) | Vector MBTiles + GL style → raster PNG via MapLibre GL Native | BSD-2 |
| [`cwebp`](https://developers.google.com/speed/webp) (libwebp) | Re-encode rendered PNGs to WebP q80 — ~5× smaller (Pillow does it in-process, byte-identical) | BSD |
| [OpenMapTiles fonts](https://github.com/openmaptiles/fonts) | Pre-built glyph PBFs for label rendering | OFL |
| [OpenMapTiles styles](https://github.com/openmaptiles) | Free MapLibre GL styles (Positron, OSM Bright, Dark Matter) | BSD-3 |

All free. No keys. No bills. The whole stack runs on a MacBook.

## The build script

The CamperMate offline-tiles build script is ~350 lines of bash that wires those tools together. Inputs: a region name, a Geofabrik path, a bbox, a max-zoom and a style name, plus optional boundary polygon and margin. Output: a single `.mbtiles` file ready to upload.

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

# 2. Slice the national PBF to the region. Prefer --polygon over --bbox where a
#    boundary exists (see "Region splits" below) — and extract WIDER than you clip.
osmium extract --polygon=nz-south-data.poly --strategy=smart --set-bounds \
  -o offline-tiles/pbf/nz-south-extract.osm.pbf \
  offline-tiles/pbf/nz.osm.pbf

# 3. Generate vector MBTiles with planetiler (OpenMapTiles schema).
#    --polygon decides which TILES exist; the wider osmium clip above decides
#    which DATA backs them.
java -Xmx8g -jar planetiler.jar \
  --osm_path=offline-tiles/pbf/nz-south-extract.osm.pbf \
  --mbtiles=offline-tiles/nz-south-vector.mbtiles \
  --polygon=nz-south-tiles.poly --maxzoom=15 --download --force

# 4. Render vector → raster via tileserver-gl
docker run -d --name tileserver-gl-nz-south -p 8765:8080 \
  -v offline-tiles:/data \
  maptiler/tileserver-gl:latest \
    -c /data/tileserver-config-nz-south.json

# 5. curl-loop every tile in the bbox; pack into raster MBTiles
python3 render_and_pack.py nz-south '166.4,-47.3,174.5,-40.4' 15
```

A few non-obvious things that took me a day to learn:

- **Planetiler needs Java 21+.** With Zulu 17 installed for Android dev you'll see `UnsupportedClassVersionError: class file version 65.0`. The Docker image avoids the JDK juggle, but running the released jar directly is worth it for an unattended build — a container registry is one more thing that can hang, and it did: a pull that was quietly waiting on an interactive sign-in produced no output and no error for hours. If you do resolve a JDK yourself, verify the version you got rather than trusting `/usr/libexec/java_home -v 21`, which best-matches and cheerfully returns a 17 on a machine that has no 21.
- **OpenMapTiles styles ship with Maptiler-hosted source URLs.** The default Positron `style.json` points at `api.maptiler.com` and needs a key. Rewrite `sources.openmaptiles.url` to `mbtiles://{openmaptiles}` and let tileserver-gl resolve it from the local MBTiles: `jq '.sources.openmaptiles = { type: "vector", url: "mbtiles://{openmaptiles}" }' positron.json > positron.local.json`.
- **Fonts are not in the `openmaptiles/fonts` master branch.** Master ships only TTF sources. The pre-built PBF glyph ranges are in the [v2.0 release asset](https://github.com/openmaptiles/fonts/releases/tag/v2.0). Without them tileserver-gl 500s on every tile containing a label, which is everything past z4.
- **Planetiler writes `bounds` and `center` metadata that breaks MapLibre GL Native.** Strip them after planetiler runs: `sqlite3 *.mbtiles "DELETE FROM metadata WHERE name IN ('bounds', 'center');"`.

## Getting the render right: three things in a row

These three compound, and each one is invisible until you look closely at a tile. Together they decide whether your archive contains the detail its filename claims and whether anyone can read the labels.

**1. Use the 512px tile route, not the 256px one.** `/styles/{id}/{z}/{x}/{y}.png` returns a tile rendered from the vector tile at zoom **z−1**, not z — documented in [`serve_rendered.js`](https://github.com/maptiler/tileserver-gl/blob/master/src/serve_rendered.js): *"For 512px tiles, use the actual maplibre-native zoom. For 256px tiles, use zoom - 1."* MapLibre vector sources are 512px logical tiles, so a 256px viewport at zoom z covers half of one and resolves to the parent. Ask for `/styles/{id}/512/{z}/{x}/{y}.png` and downscale to 256 if that's the tile size you ship — otherwise every archive you build is a zoom level coarser than the number in its filename, at exactly the same byte cost.

**2. Scale the style before you downscale, or your labels come out half size.** Fixing the first problem creates this one: the 512 canvas covers the same ground as the 256 tile, so `text-size: 12` is 12px on a 512 canvas and 6px once you shrink it. Unreadable on a phone. `@2x` does *not* help — it scales canvas and text together, leaving the ratio unchanged. Multiply the style's pixel dimensions (`text-size`, `icon-size`, `line-width`, `text-halo-width`, translates) by your downscale factor first, leaving zoom stops, opacities and em-based offsets alone. Then downscale.

**3. Downscaling smears glyphs, so sharpen after it.** Even at the right size, resampling turns crisp strokes into mid-grey mush. Measured on one z14 tile, mid-grey pixels per solid dark pixel: 2.4 rendering natively, 6.4 after a plain downscale. Filter choice barely moves it (LANCZOS 6.4, HAMMING 7.3) — it is inherent to render-then-shrink. An unsharp pass (radius 1.0, ~60%) restores 2.8 for about 20% more bytes, where shipping 512px tiles outright costs 162%.

There is a fourth, cheaper trap in the same area: **render nothing until the tileserver is genuinely ready.** A freshly started tileserver-gl will answer requests before its style and glyphs have finished loading, and the tiles it returns in that window are bare background — which a packer will happily write as success. Probe it with a handful of known feature-bearing tiles and refuse to start until they all come back non-blank. If you shard across several tileserver instances for throughput, probe *every* instance: one that never received a probe stays cold while the check reports ready.

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

The patch is ~750 lines across iOS and Android, applied via [`patch-package`](https://github.com/ds300/patch-package). It teaches `MapTileProvider` (Android) and `AIRMapUrlTile` (iOS) to detect the `mbtiles://` URL scheme and route to a new SQLite-backed tile reader instead of the HTTP path. The internals — connection caching, TMS y-flip, overzoom via in-memory parent-bitmap reuse — are a separate post. The user-facing surface is exactly the snippet above. I intend to open-source the patch; [issue #5863](https://github.com/react-native-maps/react-native-maps/issues/5863) tracks the underlying request.

## Region splits and zoom levels

Two practical decisions shape the file layout. **Where to split** should match how users travel — for a campervan app, per-island and per-state is the right grain, because that's what people fly between.

**Where the data comes from matters more than where you split.** The obvious move is to use Geofabrik's per-state PBFs for Australia, since they exist and need no slicing. Don't. A per-state extract stops at the state line, but a region's *coverage* has to extend past it — nobody wants the map to end mid-drive at an invisible border. Feed a state PBF into a bounding box that crosses the border and every tile on the far side renders empty: opaque background where the neighbour has real map. Install two adjacent regions and whichever draws on top blanks the other.

Slice every region out of the **national** extract instead. Same tools, one argument different, and each region becomes self-sufficient at its edges.

**Clip to the real boundary, not a rectangle.** A bbox around a non-rectangular state is mostly other people's territory: my NSW box overlapped Victoria by nine degrees of longitude, which is not a border margin, it's a rectangle problem. Geofabrik publishes the `.poly` for every extract, and both `osmium extract --polygon` and planetiler `--polygon` take it directly. Clip to that polygon plus an explicit margin — I use 0.25°, about 27km, enough that crossing a border you haven't downloaded still shows map — and the overlap becomes a deliberate strip instead of a slab. For NSW/VIC that took the shared area from 32.4 to 7.0 square degrees.

Two traps in that, both of which cost me a rebuild:

- **A `.poly` is not always a state outline.** `tasmania.poly` is a ten-vertex box reaching 161°E and −56°S, because Tasmania administers Macquarie Island 1,500km away. Buffer that and your archive claims a vast tract of Southern Ocean. Intersect the polygon with a sane declared bbox.
- **The data clip must be wider than the tile clip.** planetiler emits any tile that *intersects* the shape, even by a fraction, but osmium only supplied data *inside* it — so edge tiles ship with a sliver of map. Extract at margin + one tile width (0.12° covers z12), clip tiles at margin. On a border that runs straight north–south, nearly parallel to the tile grid, an entire column lands in that state otherwise.

**How deep to render** is the other consequential decision. Each zoom level quadruples tile count, and real-world size grows faster than the math suggests because inked tiles compress worse than empty ones. Concretely, for NSW:

| zoom | tiles | MB |
|---|---:|---:|
| z12 | 15,211 | 25 |
| z13 | 57,199 | 90 |
| z14 | 209,424 | **265** |

The deepest level is half the archive. That's the whole argument in one table.

I shipped NZ at native z15 (trail heads, suburb names, motorway shields) and AU at native z14 with overzoom — the patch stretches the largest available tile up to z18 — for a 4× saving across an entire continent. The asymmetry is deliberate: NZ is small enough that z15 doesn't blow up storage, AU isn't.

"Native" is worth being precise about here, and it's where the 512px route above earns its keep. Render through the 256px route and a z15 archive carries z14 detail — the zoom in the filename is one level ahead of the data actually drawn. Render through `/512/` and downscale, and you get the detail the number promises for the same tile count and the same bytes.

That's the cheapest sharpness win available, and it's worth checking before reaching for a deeper zoom: one more level costs roughly 3× the archive, where fixing the route costs nothing.

## Low zooms belong to the country, not the region

Clipping fixes the borders at street zoom. It cannot fix them at continent zoom, and the reason is arithmetic: at z6 a single tile spans most of Australia. Every region renders that same tile from its own clipped data, so each one draws its own state and leaves the rest bare. Install two and you see whichever draws on top.

Measured agreement between neighbouring archives, before fixing it:

| zoom | agreement |
|---|---:|
| z6 | 0–60% |
| z8 | 17–96% |
| z10 | 73–90% |
| z12 | 83–98% |
| z14 | **100%** |

Deep zooms are fine — a z14 tile is small enough to sit inside one region's data. The shallow ones are hopeless, and no margin helps, because the tile is bigger than any margin you'd sanely add.

The fix is the one Organic Maps reached for with `World.mwm`: render the shallow zooms **once** from the unclipped national extract and give every region the identical set. In our layout that means copying them into each archive rather than shipping a separate file, which costs about 22MB per region for z0–10 — under 5% of a typical archive, and it makes the whole tier agree everywhere.

Pick the cut-off by measurement, not instinct. Mine failed at z10 and passed at z12, so I extended the shared base to z10 and sampled z11 to check the level above it — it passed, which saved 42MB per region over extending to z11 "to be safe". Each extra level roughly triples the base: z0–9 is 8MB, z0–10 is 21.7MB, z0–11 is 63.8MB.

The test that catches all of this is worth writing before you need it: for every pair of overlapping regions, at every zoom you care about, assert that shared tiles render substantially the same image. Blankness checks are not enough — a tile with one state's half drawn is not blank, it is wrong — so compare pixels. Mine samples z6/z8/z10/z11/z12/z14 across six pairs, and every defect above announced itself as a specific cell in that grid.

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

The measured impact on NZ, at the time, on PNG tiles and before the WebP step below:

- **nz-north**: 716,859 tiles → 1.9 GB on disk (51% saving over flat schema)
- **nz-south**: 859,891 tiles → 242,217 unique blobs (**71.8% tile dedup rate**), 1.8 GB on disk (57% saving)

Why so high? A region the size of New Zealand has *enormous* repetition at mid-zooms — endless ocean tiles, identical bush-cover tiles in the Fiordland interior, whole glaciers rendered as one flat wash of white at 30% opacity. Dense urban tiles (Auckland CBD) are all unique and don't dedup, but they're a small fraction of any region's total tile count.

Hashing every tile during pack adds CPU but it's microseconds per tile — invisible compared to the actual rendering time. Reading via the VIEW adds one indexed JOIN which doesn't measurably affect tile-fetch latency on mobile.

## WebP, not PNG — another ~5× shrink

The next surprise was the format choice. PNG is what tileserver-gl emits and what every MBTiles tutorial uses, but PNG is the wrong codec for inked map tiles. Roads, anti-aliased coastlines, low-opacity landcover washes, transparent green parks — none of it palettises well, which is what PNG's compression relies on. WebP's lossy mode is designed for exactly this kind of mixed graphical content.

I sampled 150 *inked* tiles from TAS at z13–z14 — the hard case, where the codec has roads, labels and landcover to work with rather than empty ocean — and compressed each as PNG (baseline), `pngquant --quality 75-95`, and WebP at four qualities. Size alone is a misleading axis for a lossy codec, so the table carries fidelity too, as PSNR against the source render:

| Codec | Size vs PNG | Fidelity |
|---|---:|---:|
| PNG (baseline) | 100% | lossless |
| pngquant 75–95 | 28% | 51.8 dB |
| WebP q75 | 10% | 40.8 dB |
| **WebP q80** | **12%** | **41.7 dB** |
| WebP q85 | 14% | 42.6 dB |
| WebP q90 | 19% | 43.7 dB |

Two things fall out. WebP is in a different weight class to `pngquant` on size — less than half of it at every quality tested — because palettisation is the wrong tool for anti-aliased lines and gradient shading. And the WebP quality ladder is steep in bytes but shallow in fidelity: going q75 → q90 nearly doubles the file for under 3 dB. q80 sits on the knee, and above ~40 dB the difference at street zoom is invisible — labels stay crisp, terrain shading stays smooth.

`pngquant` is the more faithful of the two lossy options at 51.8 dB, which matters if you're compressing screenshots or UI assets. For map tiles viewed at 1:1 on a phone, that fidelity is bought at 2.3× the bytes and isn't visible. The end-to-end re-render of TAS confirmed the trade: **376 MB → 61 MB** (it ships at 117 MB today, after the border and label work above).

The pipeline change is one line: after fetching the rendered PNG from tileserver-gl, pipe it through `cwebp -q 80` before hashing and inserting into the `images` table. (If you're rendering hundreds of thousands of tiles, do the encode in-process rather than shelling out — Pillow's WebP encoder at the same quality and method produces byte-identical output to `cwebp`, and skipping a subprocess spawn plus two temp files per tile roughly halved my encode time.) Update the MBTiles `format` metadata from `png` to `webp` so the spec stays honest; consumers that ignore that field (like my native patch, which passes raw bytes straight to `UIImage` / `BitmapFactory`) don't notice the change. Both platforms have decoded WebP natively for years — iOS 14+, Android API 14+.

End-to-end size for all 9 ANZ regions, walking through the optimisations:

| Pipeline state | Total |
|---|---:|
| Flat schema, PNG (naive baseline, projected) | ~21 GB |
| Dedup schema, PNG | 10.7 GB |
| **Dedup schema, WebP q80** | **2.3 GB** |

About 9× smaller than the naive starting point.

The shipping tier is larger than that figure, and worth breaking down because every increase was a deliberate trade rather than drift. It now sits at **3.7 GB** across nine regions:

| region | size |
|---|---:|
| Queensland | 693 MB |
| North Island | 617 MB |
| New South Wales | 564 MB |
| South Island | 542 MB |
| Western Australia | 426 MB |
| Victoria | 320 MB |
| South Australia | 251 MB |
| Northern Territory | 165 MB |
| Tasmania | 117 MB |

Four things account for the difference against the 2.3 GB above: real cross-border content where per-state extracts previously left blanks, label sizes doubled to survive the downscale, an unsharp pass, and ~22 MB per region of shared low-zoom base. Tasmania went 61 → 117 MB, and every one of those megabytes buys something a user can see.

R2 cost: **~$0.06/month storage** for the whole tier, and **egress to devices is free** — the killer feature R2 has over S3. Someone who only ever visits Tasmania downloads 117 MB once, free, and never pays storage either. The biggest single download is Queensland at 693 MB, which is unremarkable next to what OsmAnd or Organic Maps ship for comparable ground.

## Style picks

For CamperMate I tested the free OpenMapTiles styles. All open-licensed, all render against the same vector MBTiles:

- **Positron** — minimal, white, designed as a backdrop for *other* content. Beautiful but wrong for an "offline map replacement" use case where the map *is* the content.
- **OSM Bright** — what I shipped with. Coloured roads, green parks, blue water, motorway shields, full POI labels. Reads like Apple Maps in light mode.
- **Dark Matter** — dark-mode equivalent of Positron. Future option for a night-mode toggle.
- **Voyager** — worth knowing it isn't OpenMapTiles'. It's CARTO's, and there is no `openmaptiles/voyager-gl-style` repo, so the URL you'll find alongside the other three 404s. Fetch it from CARTO's CDN instead; its source-layers are plain OpenMapTiles schema, but its source is named `carto`, so rewrite the layer references as well as the source. It renders far fewer POI labels than OSM Bright by design — good under your own markers, thin as a standalone basemap.

The aesthetic decision changes which file you ship to users; it doesn't change anything upstream. Vector MBTiles → re-render → upload. Hours, not days.

## Wrapping up

If you're building any kind of outdoor, overland, or regional travel app and your users care about offline coverage, this pipeline is repeatable. The tools are mature, the licensing is permissive (OSM is ODbL, the OpenMapTiles styles are BSD-3, planetiler is Apache-2, tileserver-gl is BSD-2), the storage is cheap, and the aesthetic is finally something you can put in a shipping app without an apology.

If you're heading to Australia or New Zealand and want to see the pipeline in production, [grab CamperMate on iOS](https://apps.apple.com/app/campermate/id578975305) or [Android](https://play.google.com/store/apps/details?id=nz.co.campermate.app) — free, no account required, offline maps under the "Downloads" tab. Your offline maps don't have to look like 2013 anymore.

---

*Header photo by [Marek Piwnicki](https://unsplash.com/@marekpiwnicki) on [Unsplash](https://unsplash.com).*
