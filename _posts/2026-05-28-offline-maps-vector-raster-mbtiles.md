---
layout: post
title: "Offline maps that look like 2026, not 2013 — a vector→raster MBTiles pipeline"
description: "CamperMate's nine offline basemaps for Australia and New Zealand are 3.7 GB of WebP tiles built from OpenStreetMap with planetiler and tileserver-gl and served from Cloudflare R2. The first tier was a zoom level coarser than every filename claimed, and nothing in the build log said so. This is the pipeline, what tileserver-gl actually does versus what its route names imply, and what the archives measure now."
excerpt: "tileserver-gl draws its 256-pixel tiles from the tile one zoom level up. Every archive in the first tier was one level coarser than its filename, 752 tiles in Tasmania were blank, and Victoria drew opaque nothing over New South Wales. None of it was visible in a build log. This is the pipeline from OpenStreetMap data to a WebP tile archive on Cloudflare R2, with the numbers."
image: /images/blog/offline-maps-pipeline.jpg
image_alt: A small campervan on a rural road at twilight beneath a perfectly conical mountain — the kind of place cell coverage runs out and offline maps start mattering
date: 2026-05-28
last_modified_at: 2026-11-16
categories: [engineering]
tags: [offline-maps, mbtiles, openmaptiles, openstreetmap, planetiler, tileserver-gl, maplibre, cloudflare-r2, react-native, campermate]
consulting: true
---

[CamperMate](https://campermate.com), the free-camping and campground app made at Triptech, ships nine offline base-map archives for Australia and New Zealand, 3.7 GB in total. They are built from OpenStreetMap with planetiler, which turns raw map data into tiles, and tileserver-gl, which draws them. They are served from Cloudflare R2, Cloudflare's file storage. The first tier, published in May 2026, was one zoom level coarser than every filename claimed. It had 752 blank tiles in Tasmania alone. Wherever Victoria was installed on top of New South Wales, it drew an opaque blank rectangle over it. The build log for every one of those archives said `done`.

This is the pipeline as it runs now. This post covers:

- why the standard OpenStreetMap tile server draws a map from 2013, and splitting the map data from the drawing;
- the build as it runs, and the one line in tileserver-gl that makes its 256-pixel tiles come from the zoom level above (and the labels that shrink to half size when you fix that);
- a warm-up probe that never reached the server instance it was warming, and per-state map extracts that stop at a state line the archive's box crosses;
- a continent-scale tile no clipping margin can fix, and how deep to draw;
- storing each identical tile once and WebP at quality 80, measured on WebP rather than remembered from PNG, and what the tier costs now;
- shipping it in React Native, where the hole Apple's tile renderer leaves on every pinch was closed by porting MapLibre's tile pyramid, plus style picks and what I would check first next time.

<!-- more -->

## The standard recipe draws a map from 2013

The pipeline was built for [CamperMate](https://campermate.com), the free-camping and campground app across Australia and New Zealand, made at [Triptech](https://triptech.com). It is on [iOS](https://apps.apple.com/app/campermate-australia-nz/id465040067) and [Android](https://play.google.com/store/apps/details?id=nz.co.campermate), with 1M+ downloads. Its users are in Fiordland, Kakadu and the Pilbara, where the map has to work without bars. The output is an MBTiles file: a single SQLite database holding every tile, which any client can read. The React Native side is at the end.

Every "offline OpenStreetMap tiles" guide starts with [`overv/openstreetmap-tile-server`](https://hub.docker.com/r/overv/openstreetmap-tile-server/). It loads the map data into a PostGIS database, and Mapnik draws it in the same style as `openstreetmap.org`. I tried it. It works, and the output looks like 2013: olive land use, mustard buildings, brick motorways. It is also one stage, so a different look means editing the style language and re-drawing everything from the database. That was the whole evaluation; I moved on.

## Split the data from the drawing

![The build has two stages. Stage one, run once per region: an OpenStreetMap extract goes through planetiler and becomes a vector tile archive, the single source of truth. Stage two, run once per map style: tileserver-gl draws that vector archive into a picture tile archive, which is what the app loads and can be redrawn in any style without touching stage one.](/images/blog/offline-maps-two-stages.svg)

There are two stages. The vector archive holds the map as shapes and labels in the OpenMapTiles layout, with no styling. The picture archive is what the app loads. It can be redrawn in any MapLibre GL style without touching the data stage. The renderer is [MapLibre GL Native](https://github.com/maplibre/maplibre-native), the same engine behind MapLibre GL JS. That is why the tiles look like a modern web map: they are one, drawn offline.

| Tool | Job | License |
|---|---|---|
| [Geofabrik](https://download.geofabrik.de) | OpenStreetMap source data as PBF files, plus a `.poly` outline per extract | ODbL |
| [`osmium-tool`](https://osmcode.org/osmium-tool/) | Cut a national map extract down to a region's outline | GPL-3 |
| [`planetiler`](https://github.com/onthegomap/planetiler) | Turn a map extract into a vector tile archive (OpenMapTiles layout) | Apache-2 |
| [`tileserver-gl`](https://github.com/maptiler/tileserver-gl) | Draw vector tiles in a chosen style into PNG pictures, using MapLibre GL Native | BSD-2 |
| [`cwebp`](https://developers.google.com/speed/webp) (libwebp) | Encode pictures as WebP at quality 80; the packer now calls the same library in-process through Pillow at the same settings | BSD |
| [OpenMapTiles fonts](https://github.com/openmaptiles/fonts) | Pre-built font glyph files for drawing labels | OFL |
| [OpenMapTiles styles](https://github.com/openmaptiles) | Free MapLibre GL styles (Positron, OSM Bright, Dark Matter) | BSD-3 |

No API keys. The whole stack runs on a MacBook.

## The build, as it runs

`scripts/regions.json` is the source of truth. For each region it gives the source extract, bounding box, deepest zoom, style, clip outline and margin. `scripts/rebuild-from-manifest.sh` reads it and runs, per region:

```
Geofabrik national PBF
  → osmium extract   (clip to polygon + margin + EXTRACT_DELTA_DEG)
  → planetiler       (vector .mbtiles, OpenMapTiles schema, clipped to polygon + margin)
  → tileserver-gl    (render each vector tile via the /512/ route)
  → render-and-pack  (downscale 512→256, unsharp, WebP q80, dedup) → <region>.mbtiles
  → apply-lowzoom-base (overwrite z≤9 with the shared national base)
```

`build-offline-tiles-fast.sh` builds one region of that. `render-and-pack-deduped.py` is the draw, encode and pack step. Four things in there each cost a day:

- **Planetiler needs Java 21.** macOS's Java locator (`/usr/libexec/java_home -v 21`) returns the closest match rather than failing. On a machine with only Java 17, it returns the 17 path and reports success, and planetiler dies with a class-version error. So the script runs `java -version` on each candidate and checks the major version itself. It also runs the released jar, not the container. A `docker pull ghcr.io/onthegomap/planetiler` once burned 13 hours with no bytes and no error. Docker had asked the macOS keychain for a `ghcr.io` credential entry that existed but held nothing, and blocked.
- **OpenMapTiles styles point at `api.maptiler.com`** and need a key. The build uses `jq` to rewrite the style's data source to the local archive, repoint every layer at it, and set the font path to the local glyph files.
- **The font glyph files are not on the `openmaptiles/fonts` master branch**, which has only the source fonts. They are the [v2.0 release asset](https://github.com/openmaptiles/fonts/releases/tag/v2.0), about 74 MB. Without them, tileserver-gl returns a server error on every tile with a label.
- **Planetiler's `bounds` and `center` metadata upset MapLibre GL Native.** The build deletes those two rows from the archive's metadata table after planetiler runs.

Both images track `:latest` on purpose. Each build writes the resolved version into the archive: `planetiler_version` on the vector side, `tileserver_version` on the picture side. For the May archives there was no record, so working out which renderer produced them was impossible. That is why the next section took so long to place.

## tileserver-gl's 256-pixel tiles are a zoom level short

I expected a 256-pixel tile at zoom `z` (`/styles/{id}/{z}/{x}/{y}.png`) to be drawn from the vector tile at zoom `z`. It is drawn from the vector tile **one zoom level up**. The comment is in [`serve_rendered.js`](https://github.com/maptiler/tileserver-gl/blob/master/src/serve_rendered.js): *"For 512px tiles, use the actual maplibre-native zoom. For 256px tiles, use zoom - 1."* MapLibre's vector tiles are 512 pixels across. So a 256-pixel tile at zoom `z` covers exactly one quarter of the tile one level up, and that is the one it is drawn from.

![Two panels. Left: the 256-pixel tile requested at zoom z is drawn from the 512-pixel vector tile one zoom level up, of which it is one quarter, so it carries the coarser level's detail. Right: the worked Tasmanian case, where the child tile's own vector data holds seven river features but the parent's quadrant holds nothing, so the tile shipped blank.](/images/blog/offline-maps-parent-quadrant.svg)

That has two consequences. Every archive built through that route carries the detail of the level above its filename, at the same tile count and byte cost. And any tile whose quarter of the parent is empty comes out blank, even when the tile's own data has features.

The worked case is the Tasmanian tile at zoom 12, column 3705, row 1515. Its own vector tile carries seven river features: the Looker and Andrew Rivers, inside Franklin-Gordon Wild Rivers National Park. They match the style's filters, and the style would paint them as a light-blue line about one pixel wide. But the parent at zoom 11 has nothing in that quarter, so the tile shipped as flat background. There were 752 like it in Tasmania alone.

The fix is to request the 512-pixel version of each tile (`/styles/{id}/512/{z}/{x}/{y}.png`) and shrink it to the 256-pixel tile we ship. The packer's URL builder now refuses to build the bare route. This also makes the packer's duplicate detection correct. Only at the tile's own zoom is a drawing a pure function of that tile's own vector bytes.

Fixing that created the next problem. The 512-pixel canvas covers the same ground as the 256-pixel tile. Text set at 12 pixels in the style is 12 pixels on the canvas, and 6 pixels on the phone. Unreadable. Asking for the double-resolution variant (`@2x`) does not help, because it scales canvas and text together. `scripts/scale-style-sizes.py` doubles the style's pixel sizes before drawing: text size, icon size, line width, text halo width and offsets. It leaves zoom stops, opacities and font-relative offsets alone.

And shrinking a picture smears the lettering. I measured one Queenstown tile at zoom 14, counting the mid-grey pixels around each solid dark pixel of text:

| How the tile was made | Mid-grey pixels per dark pixel |
|---|---:|
| drawn directly at 256 pixels | 2.4 |
| the old 256-pixel route | 2.5 |
| 512-pixel route, plain shrink, Lanczos filter | 6.4 |
| 512-pixel route, plain shrink, Hamming filter | 7.3 |
| 512-pixel route, shrink, then sharpen (radius 1.0, 60%, threshold 3) | **2.8** |

The filter choice barely moves it; the smear is inherent to draw-then-shrink. The sharpening pass costs about 20% more bytes. Shipping 512-pixel tiles outright would cost 162% more.

## A freshly started tile server returns success

A freshly started tileserver-gl answers before its style and fonts have loaded. The tiles it returns in that window are bare background, and the packer wrote them as success.

The build runs several tileserver instances and routes each tile to one of them by a hash of its coordinates. The first warm-up probed six tiles through that same routing. So an instance could receive no probe at all, stay cold, and still let the check print `warm (0s)`. In one rebuild that baked blank tiles into six regions: 880, 20, 126, 2,905, 107 and 1,371. Every one of them then passed validation.

The warm-up now sends the eight most detailed sample tiles to *every* instance. It succeeds only when all of them draw something, and a 120 s deadline fails the build rather than warning. After that, the renderer refetches any tile that has features but comes back blank, up to four times.

"Blank" needed defining too. The old test, "near-uniform and light", counted two real things as empty. OSM Bright paints solid woodland as a very faint wash, which draws as a flat pale green (RGB 233, 236, 223). Glacier is white at 30% opacity (RGB 250, 247, 244). That misread 297 correctly drawn Tasmanian tiles, and most of the Southern Alps.

Blank now means within one step per colour channel of the style's background colour (RGB 248, 244, 240). Every script that decides it shares that definition. Twenty Tasmanian tiles still draw blank after retries, and they are correct. Their only features are national park boundaries, minor administrative boundaries and mountain peaks, none of which OSM Bright paints. The blank counter is only advisory. The gate is `validate-mbtiles-coverage.py`, which checks each tile against the vector source rather than against a solid rectangle.

## Per-state extracts blank the neighbouring state

The Australian regions first came from Geofabrik's per-state map extracts, which exist and need no cutting. But a per-state extract stops at the state line, and a region's bounding box crosses it. So the Victoria archive held tiles over New South Wales with nothing drawn on them. They were opaque, at the same stacking level, so they painted over the New South Wales archive's real map.

![Two panels. Left, at street zoom: the Victoria archive's bounding box crosses the state line into New South Wales, and the tiles it holds there were drawn from data that stops at the border, so they are opaque and empty; installed on top of the New South Wales archive they blank out its real map along the border. Right, at continent zoom: one zoom-6 tile spans most of Australia, and each region's archive draws only its own state in it and leaves the rest bare.](/images/blog/offline-maps-border-blanks.svg)

Regions now come from the national extract. Each is cut to Geofabrik's outline for the region plus a declared margin, a quarter of a degree in `regions.json`. It is then limited to the region's bounding box. The limit matters. Tasmania administers Macquarie Island, 1,500 km away, so its outline is a ten-point box reaching 161 degrees east and 56 degrees south. Adding a margin to that claims a tract of Southern Ocean. The hand-drawn rectangles this replaced overlapped by up to nine degrees of longitude between New South Wales and Victoria.

There are two cuts, and they are deliberately different widths. Planetiler emits any tile that *touches* the outline, but osmium only supplies data *inside* it. Cut both to the same shape and the edge tiles ship with a sliver of map. So the data extract is cut 0.12 degrees wider than the tiles are. `repair-sliver-tiles.py` exists because of exactly this, on the border between South Australia and Victoria. That border runs north to south, almost parallel to the tile grid.

## The wide views belong to the whole country

Cutting fixes borders at street zoom. It cannot fix them at continent zoom. At zoom 6 a single tile spans most of Australia. Every region draws that tile from its own cut-down data, so each draws its own state and leaves the rest bare (the right-hand panel above). Here is the measured agreement between neighbouring archives before the fix:

| Zoom level | Agreement between neighbours |
|---|---:|
| 6 | 0–60% |
| 8 | 17–96% |
| 10 | 73–100% |
| 12 | 83–100% |
| 14 | **100%** |

No margin helps, because the tile is larger than any sane margin. The fix is what Organic Maps does with its world file. Draw the wide zoom levels once, from the uncut national extract, and copy the identical set into every region. `apply-lowzoom-base.py` overwrites zoom 9 and below in each archive as part of the build.

Why stop at 9? Each level roughly triples the cost. On the Australian base archive, zoom 9 is 3,534 tiles and 5.8 MB, zoom 10 is 13,763 and 14.4 MB, and zoom 11 is 52,706 and 44.2 MB. The shared base file for zooms 0 to 9 is 10 MB for Australia and 1.6 MB for New Zealand.

The gate is `scripts/tests/test_region_overlap.py`. It checks six overlapping pairs of regions at zooms 6, 8, 10, 11, 12 and 14. Tiles present in both archives must draw the same picture, compared pixel by pixel, to at least 95% agreement. A tile with one state's half drawn is not blank; it is wrong. Zooms 10 and 11 are sampled on purpose. Zoom 10 is the first level each region draws for itself, so it carries the risk the shared base removes below it. If it ever fails, the base goes one level deeper. The gate now passes every pair at every zoom. One pair sat at 37% when this started.

## How deep to draw

Each zoom level quadruples the tile count, and tiles with ink on them compress worse than empty ones. Measured on the current `au-nsw.mbtiles`:

| Zoom level | Tiles | MB |
|---|---:|---:|
| 12 | 15,211 | 26.5 |
| 13 | 57,199 | 95.0 |
| 14 | 209,424 | **278.6** |

The deepest level is 64% of the archive's 433 MB of tile bytes. That is the whole argument in one table.

New Zealand is drawn down to zoom 15 and Australia to zoom 14, and the app enlarges tiles past that. That is four times fewer tiles across a continent, and New Zealand is small enough that the extra level is affordable. The deepest level is also where the 512-pixel route earns its keep. Drawn through the 256-pixel route, a zoom-15 archive carries zoom-14 detail. Drawn through the 512-pixel route and shrunk, it carries the detail its number promises, for the same tile count. One more zoom level costs roughly three times the archive. Fixing the route costs nothing.

## Storing each identical tile once, measured on WebP

The MBTiles specification allows a layout where identical tiles share one stored copy, and the packer writes it:

```sql
CREATE TABLE images (tile_id TEXT PRIMARY KEY, tile_data BLOB);
CREATE TABLE map (zoom_level, tile_column, tile_row, tile_id);
CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row);
CREATE VIEW tiles AS
  SELECT map.zoom_level, map.tile_column, map.tile_row, images.tile_data
  FROM map JOIN images ON images.tile_id = map.tile_id;
```

The tile id is a hash of the tile's bytes, so identical tiles collapse to one row in `images`. The `tiles` view hides the difference. Both native readers run one query, tile data by zoom, column and row, and it works against either layout.

The duplicate handling that really pays happens earlier, at the vector stage. Planetiler already stores each distinct tile once: byte-identical vector tiles share one data id. In Western Australia about 70% of tiles are duplicate desert. The packer groups tiles by that data id and zoom level, draws one tile per group, and points every coordinate in the group at the result. It groups by zoom as well as bytes, because the same vector bytes draw differently at different zooms. Western Australia drew in 9 minutes, against about 45 for the naive one-tile-at-a-time loop.

I remembered the shared-copy layout as a 50% saving, from the PNG era. Measured on the shipping WebP archives:

| Region | Tile positions | Distinct pictures | Flat layout (MB) | Shared-copy layout (MB) |
|---|---:|---:|---:|---:|
| nz-south | 857,288 | 241,253 | 484.1 | 362.6 |
| au-wa | 806,607 | 246,804 | 389.5 | 280.7 |
| au-nsw | 304,356 | 214,936 | 433.2 | 415.9 |

On the South Island, 72% of coordinates point at a shared picture, but the byte saving is 25%, because the tiles that share are the cheap ones. The shared layout also needs two things a flat table does not. SQLite's own storage report puts the coordinate table at 48.2 MB and the picture index at 13.7 MB. So the net saving is about 60 MB, 11% of a 542 MB file. On New South Wales, which is mostly ink, it is 4%. The layout is still worth having, but WebP took most of what it used to give.

## WebP at quality 80

PNG is what tileserver-gl emits. It is the wrong format for smoothed lines and faint land-cover washes, which do not reduce to a small palette. On 1,000 Tasmanian tiles, WebP at quality 80 came to 19.4% of the PNG bytes. The projected size of the tier fell from about 10.7 GB to about 2 GB. Both platforms decode WebP natively, iOS since version 14 and Android since API level 14. Both native readers pass the raw bytes straight through. The archive's `format` metadata says `webp`, so the specification stays honest.

The encoding happens inside the packer. The first version launched the `cwebp` program with two temporary files per tile: about 35,000 launches and 70,000 temporary writes for Tasmania alone. Pillow's encoder, at the same quality and compression effort, replaced it.

Three more changes sped up the build. SQLite runs in write-ahead-log mode during the build. Commits are batched per 200 tiles. And there are 16 client threads, because tileserver-gl keeps between 8 and 16 renderers, so 8 threads left half of them idle. Together they took Tasmania from 477 s to 259 s, with byte-identical output at either thread count. Before it ships, the archive is switched back to ordinary journal mode and compacted, so there is no log file beside it.

## What the tier costs now

The archives from before the September rebuild are still on disk beside the current ones:

| Region | Before (MB) | Now (MB) |
|---|---:|---:|
| Queensland | 442 | 693 |
| North Island | 468 | 617 |
| New South Wales | 334 | 564 |
| South Island | 426 | 542 |
| Western Australia | 312 | 426 |
| Victoria | 178 | 320 |
| South Australia | 172 | 251 |
| Northern Territory | 109 | 165 |
| Tasmania | 65 | 117 |
| **total** | **2,506** | **3,695** |

Every megabyte of the difference buys something a user can see:

- real content across state borders, where per-state extracts left blanks;
- labels at double size, to survive the shrink;
- the sharpening pass, at about 20%;
- the shared national base.

One thing I did not expect. Drawing at the tile's own zoom alone made every archive slightly *smaller*, before the label and border work took it up. New South Wales went from 334 MB to 309 MB. I have not investigated why. Dropping OSM Bright's water-pattern layer also helped: it is a repeating wave image that turns flat water into two-tone noise. Dropping it saved about 17% on a water-heavy sample, and it is dropped for every region.

R2 charges nothing when devices download from it, which is why it is R2 and not Amazon S3. The catch is on the way in. Uploads go through the S3-compatible API, because Cloudflare's own upload command stops at 300 MiB, under half our regions. And the download host serves the archives with a 30-day cache lifetime. Replace a file without purging the cache, and Cloudflare's edge hands out the old file for up to 30 days. So `publish-offline-map.sh` purges, then verifies by downloading a byte range of the new file. Checking only the headers is not enough: a headers-only request reports the new version while a plain download can still get the old cached copy.

## Shipping it in React Native

The pipeline does not care what reads it. On the web, MapLibre's [Martin](https://github.com/maplibre/martin) tile server reads MBTiles directly and serves them to MapLibre GL JS. Flutter has [`flutter_map`](https://docs.fleaflet.dev/) with MBTiles plugins. CamperMate's map is `react-native-maps`, which wraps Google Maps on Android and Apple's MapKit on iOS. Its tile layer component (`<UrlTile>`) expects a web address pattern to fetch tiles from.

There are three obvious options, all bad:

- unpack the archive into one file per tile and use the local-file tile component, losing the single-file archive;
- run a small web server inside the app, paying for startup, port management and battery;
- replace the map view with MapLibre's React Native component, and rewrite every marker, callout and gesture.

The fourth is a native patch that teaches the tile component a new address scheme. That keeps the component in `components/map/OfflineTilesRenderer.tsx` ordinary. Since November, every installed region draws through one layer. Its address lists each archive with its zoom range:

```jsx
<UrlTile
  key="mbtiles-set"
  urlTemplate={layer.urlTemplate} // mbtiles-set://{"archives":[{path, minZoom, maxNativeZ, maxZoom}, …]}
  minimumZ={layer.minimumZ}
  maximumNativeZ={layer.maximumNativeZ}
  maximumZ={layer.maximumZ}
  zIndex={1000}
  shouldReplaceMapContent={process.env.EXPO_OS === "android"}
/>
```

Until then there was one `<UrlTile>` per region, with an `mbtiles://` address. A user with every Australian state installed had eight stacked tile layers. The map asked every layer for every visible tile, each ran its own SQLite lookup, and tiles where archives overlap were drawn twice. Panning struggled, more so over satellite. Now, for each tile, the native code asks the archives in a fixed order, skipping any whose bounds don't touch the tile. The first archive that has the tile wins. Overlapping archives hold the same map, so which one answers doesn't matter, as long as it is the same one on every redraw.

Each archive's file path is worked out again from the region id on every render, not read from the app's saved state. iOS moves the app's storage folder to a new name on every upgrade, and a saved absolute path made downloaded regions vanish after an update. Replacing the base map is Android-only. On iOS, replacing it hides it everywhere, blanking everything outside the installed regions.

On Android, the patch adds an archive reader, a compositor and the archive set, and routes these addresses through Google's tile provider. Past the deepest drawn zoom, it crops and enlarges the parent tile. Below that, it stitches the four child tiles from the next zoom down into one 512-pixel tile, so Google Maps draws twice the linear detail. A 24 MB most-recently-used cache holds the stitched output. Google's tile overlay owns tile management, pyramid included, so that is all Android needs.

The readers on both platforms check the file's size and modification time on every lookup. A region deleted and re-downloaded lands at the same path. A cached file handle kept reading the deleted file until the app restarted.

iOS is where the work is, because MapKit gives you nothing. Apple's tile renderer draws only the current zoom level, and draws nothing where those tiles have not loaded. So every pinch punched a hole straight through the offline layer to Apple's base map, and left grey hairlines at tile seams. MapLibre, Google and Leaflet all keep a pyramid of loaded tiles, and stand in with the nearest loaded ancestor, scaled up.

![Two panels. Left: MapKit's own tile renderer draws only tiles at the current zoom level, so during a pinch the tiles that have not loaded yet are left as holes straight through to Apple's base map, with grey hairlines at the seams. Right: the replacement renderer keeps a pyramid of loaded tiles and fills each missing tile with its nearest loaded ancestor, scaled up, until the real tile arrives.](/images/blog/offline-maps-mapkit-hole.svg)

So the patch installs its own overlay renderer, `AIRMapMBTilesRenderer`. It always tells MapKit it can draw, and draws from a pyramid.

My first pyramid got the shape right and the details wrong. It consulted parents before children. It drew one stand-in, instead of the children it had plus a parent behind them. And it kept no record of which tiles it had already checked, so neighbouring tiles each re-walked the same chain of parents.

`AIRMapTilePyramid.swift` is now a port of MapLibre Native's tile-selection routine (`algorithm::updateRenderables`) and its tile-id types, under their BSD-2 notice. Upstream's tests came across too, so the preference order is testable. It lives in its own small Swift package, `modules/mbtiles-tiles`, with its own XCTest cases (Apple's test framework). It is separate because adding any Swift to the react-native-maps package makes the build tool generate a combined header. That header fails on the C++ in React's generated files.

Five things the simulator could not show, and a pinch on a device did:

- **Lazy decoding.** iOS decodes an image lazily, so every tile was being decoded inside MapKit's draw call. Tiles are now decoded as soon as they load.
- **One at a time.** Decoding ran on the one-at-a-time read queue, so tiles arrived one at a time.
- **Stale scale.** MapKit's "repaint this area" call only repaints while the map is still at the scale it was given. The scale was captured when the tile was requested, and was stale by the time the tile landed mid-pinch. So correct tiles sat in the cache under a blurry ancestor. Repaints are now scale-independent, and merged into one per frame.
- **Sparse archives.** The archives are sparse, so a missing row at the deepest declared zoom was punching dead patches into covered ground.
- **The shared base, drawn twice.** Every region carries the same wide-zoom base, and each had its own renderer at the same stacking level. So one region's blurry world tile landed on another's detail, by draw order. The fix was to ignore tiles outside each archive's own bounds; the single layer now does the same per archive. This is what made the North Island look broken while the South looked fine.

Retina came out of a review question: does owning the renderer cost resolution? It does not. Tile renderers pick the zoom level from screen size, and expect the provider to return a bigger image. Android does that with its stitched tile. iOS draws one level deeper instead, since four 256-pixel tiles over the same ground are the same pixels as one 512-pixel tile. It is capped at the deepest drawn zoom, because past it the deeper tiles are crops of the same parent. Until then, the offline map had drawn at half Android's detail on every iOS retina screen since May.

The geometry both platforms share is `utils/tileMath.ts`, with tests derived from the maths of the Web Mercator projection. The native test projects under `native-tests/` compile the real patched sources by reference. On Android they run under Robolectric, a tool that runs Android code on a laptop, against real SQLite archives. On iOS they are the XCTest bundle. I intend to open-source the module.

## Style picks

All styles draw from the same vector MBTiles, so the choice changes which file ships and nothing upstream:

- **Positron.** Minimal and white, designed as a backdrop for other content. Wrong when the map is the content.
- **OSM Bright.** What ships. Coloured roads, green parks, motorway shields, full POI labels.
- **Dark Matter.** Positron's dark-mode equivalent, a future night-mode option.
- **Voyager.** CARTO's, not OpenMapTiles'. There is no `openmaptiles/voyager-gl-style` repository, so the address you find beside the other three returns a 404. Fetch it from CARTO's own servers. Its layers use the plain OpenMapTiles layout, but its data source is named `carto`, which the local rewrite normalises. It also asks for Montserrat and two Chinese, Japanese and Korean typefaces the OpenMapTiles bundle lacks. tileserver-gl logs `Font not found` and falls back to Noto Sans. Labels draw fine; the noise is expected.

## What I would check first next time

- **Read the renderer's request handler** before trusting the request's name. The "zoom minus one" line was in `serve_rendered.js` the whole time.
- **Gate the build on a coverage check against the vector source.** A packer that prints `done` for 752 blank tiles will upload them.
- **Compare overlapping archives pixel for pixel across the zoom range**, not at one level. Otherwise a defect that affects every pair looks like one pair's bug.
- **Record the exact version of every tool that tracks `latest`**, in the file it produced.

The tools are mature, and the licensing is permissive: OSM is ODbL, the OpenMapTiles styles are BSD-3, planetiler is Apache-2 and tileserver-gl is BSD-2. The scripts, the fast tests and the overlap gate are in `scripts/` of the CamperMate app. If you are heading to Australia or New Zealand and want to see the tiles in production, [grab CamperMate on iOS](https://apps.apple.com/app/campermate-australia-nz/id465040067) or [Android](https://play.google.com/store/apps/details?id=nz.co.campermate). It is free, needs no account, and the offline maps are under the "Offline Maps" tab.

---

*Header photo by [Marek Piwnicki](https://unsplash.com/@marekpiwnicki) on [Unsplash](https://unsplash.com).*
