---
layout: post
title: "Which pin did you tap? Building a test rig that reads the screen, because three map SDKs would not tell us"
description: "CamperMate's map markers selected the wrong pin from day one, on iOS, Android and the web, and every SDK's documentation described a tap without describing what it tested. The way out was a test rig on each platform that puts real fingers on real pins and reads the pixels back. It disproved our best theory in an afternoon, found the real bug, caught three upstream defects, measured a 30× cut in Android tap latency, and on the web caught our own port getting draw order wrong."
excerpt: "Tap a pin in a dense pack on iOS and you get its neighbour. On Android you get the one underneath. On the website you get whichever pin's rectangle your finger fell in. We had followed every SDK's documentation to the letter. The documentation was not describing what the SDK did."
image: /images/blog/marker-hit-regions.jpg
image_alt: Three map pins side by side — the silhouette the user sees, the rectangular frame MapKit hit-tests, and the offset region Google Maps hit-tests above the bitmap
date: 2026-09-18
last_modified_at: 2026-11-16
categories: [engineering]
tags: [react-native, react-native-maps, mapkit, google-maps, mapbox, fabric, hit-testing, testing, xctest, robolectric, playwright, campermate]
consulting: true
---

[CamperMate](https://campermate.com) is a map. Its users look for a campsite in a pack of forty pins around Queenstown, and the whole product is the tap that opens the right one. From the first React Native build, that tap was wrong in a way we could describe but not explain. On iOS, in a dense pack, you got the pin next to the one you touched. On Android you got the one underneath. On the website, a finger in the empty corner beside one pin's pointer opened a different pin whose head was under that corner. We had followed the documentation for `react-native-maps`, MapKit, the Google Maps SDK and Mapbox GL. None of it was wrong, exactly. None of it said what the SDK hit-tests.

We lived with it for a year. What changed was that we started using Claude Fable 5.1 on the codebase. We had it read the SDK sources instead of the docs, and then build something we had never had: a test rig on each platform that puts real fingers on real pins and reads the pixels back. That rig is the story. Our own theories about the bug were wrong twice, and it was the rig, not the reasoning, that said so.

This post covers:

- the question the SDKs do not answer, and a tap rule in JavaScript that decides against the pin as drawn and in the order it is painted;
- why the first version made it worse;
- the test rig, and what the screen showed in dense packs with real data;
- three bugs in `react-native-maps` on the new architecture, and an Android tap that now reaches the app in 22 ms instead of 649 ms;
- the website's Mapbox map, where the same rule, once ported, came with a warning that our port had got draw order wrong while every test passed;
- whether this would have been easier without React Native, and what we would tell someone starting this.

<!-- more -->

## The question the SDKs do not answer

The app's map is `react-native-maps` 1.29 on Fabric, React Native's newer rendering layer. On iOS the map is MapKit. Every pin is a live React Native view inside an `MKAnnotationView`, MapKit's container for a pin. On Android the map is Google Maps, and every pin is a bitmap drawn natively from the same geometry, so the two look identical. The website uses `mapbox-gl` (3.29 at the time). Mapbox draws the pins itself from a list of points: a symbol layer over a GeoJSON source.

When a finger lands on a cluster, the app needs one answer: which pin did the user touch? Each SDK answers a different question.

- **MapKit** tests the whole rectangle the pin is drawn in. A pin is a circle on a pointer, so most of that rectangle is empty space beside the pointer. Tap the empty corner beside pin A's pointer and MapKit reports A, even when your finger is visibly on the head of pin B behind it.
- **Google Maps** tests a zone that does not line up with the pin at all. For custom marker images the zone is bigger than the image and shifted upward. It is a long-standing SDK defect, and worse on real phones than on the emulator. We later measured it on a Samsung A13 with real touches. A finger dead-centre on pin *b* was reported as the pin beside it. A tap on empty map well above a pin counted as a tap on that pin.
- **Mapbox GL** tests its "collision box", the rectangle it uses to stop labels overlapping. For our pins that is the whole image, including the transparent margin reserved for badges. So the clickable area is half as wide again as the pin you can see.

![Three panels. MapKit: a finger on pin B's head, inside pin A's rectangular frame, selects A. Google Maps: a finger dead-centre on pin b is named c, because c's hit region is offset upward over b. Mapbox: a finger in the empty corner of pin A's collision rectangle, over pin B's head, selects A.](/images/blog/marker-hit-three-failures.svg)

Three SDKs, three rectangles. The `react-native-maps` documentation says a marker has an `onPress`. MapKit's says an annotation view is selected on tap. Google's says `onMarkerClick` fires for the marker that was clicked. Mapbox's says `queryRenderedFeatures` returns the features at a point. All true. All silent on the shape being tested. That silence was the whole bug.

## Deciding it ourselves

The fix is the same on every platform. Stop asking the SDK which pin. Ask it where the finger was, project the nearby pins to the screen, and decide against the shape we actually draw, in the order we actually paint.

That needs two things the SDKs do not hand over by default: the finger position and an agreed shape.

**The finger position.** On Android, the library's marker-click event reports the marker's position, not the tap's. The patch reports the tap location instead. The touch handler already captures it, and presses on polygons and lines already use it. On iOS it took two small patches, both upstream bugs on the Fabric path:

- `RNMapsMarkerView.mm` built the press position by reading `x` and `y` out of a dictionary that only holds latitude and longitude. So every marker press on the new architecture reported its position as zero, zero: the top-left corner of the screen.
- `AIRMapMarker.m` measured the finger relative to the pin's callout view. With no callout open, that view does not exist, which also gives zero, zero. It now measures the finger relative to the map (`[recognizer locationInView:marker.map]`).

On the web the position is free, because the click event has it. Mapbox is only asked for the pins drawn in a box around the click. The box is a little bigger than a pin, so a pin whose edge is near the click is included. The decision is made from there.

**The shape.** One small file describes the pin as a circle sitting on a pointer. Every measurement is taken from the tip, the point that sits on the map coordinate:

```json
{
  "circleCenterAboveTip": 26,
  "circleRadius": 15,
  "pointerTopAboveTip": 17,
  "pointerHalfWidth": 12,
  "containerWidth": 40,
  "containerHeight": 45
}
```

Everything reads it. The JavaScript hit test uses it. The Android code that draws the pin is tested against it pixel by pixel, and so is the iOS view, rendered into a bitmap. The website's `pinGeometry.json` carries it verbatim. A browser test (Playwright) draws the web pin on a real canvas and checks every pixel's transparency against the same shape rule.

The file exists because the first hit test shipped with a hand-copied rectangle. It described a pin the app no longer drew: the renderer had moved the circle two pixels, and nothing tied the two together. Now they cannot disagree without a test failing.

The silhouette test is small:

```ts
export function isInsideMarker(dx: number, dy: number, g = MARKER_PIN_GEOMETRY): boolean {
  const fromCentreY = dy + g.circleCenterAboveTip
  if (dx * dx + fromCentreY * fromCentreY <= g.circleRadius * g.circleRadius) {
    return true
  }
  if (dy <= 0 && dy >= -g.pointerTopAboveTip) {
    const taper = -dy / g.pointerTopAboveTip // 1 at the top edge, 0 at the tip
    return Math.abs(dx) <= g.pointerHalfWidth * taper
  }
  return false
}
```

It is a circle plus a tapering pointer, not a rectangle drawn around the whole thing. A rectangle is exactly how you get "the touch target is wider than the marker".

The other half of the rule is which pin wins when outlines overlap. The original code picked the nearest tip, which is structurally wrong. A pin's circle sits about 26 pixels above its own tip. So when you tap the circle you can see, you lose to whichever pin has its tip under your finger. That pin's circle is usually hidden behind the one you aimed at. That was Android's "selects the one underneath" in its entirety.

The rule now is: among pins whose outline contains the tap, the one painted on top wins, because that is the one the user can see. Search decides what "on top" means. Every place comes back from search with a relevance score, and the more relevant place is drawn over the less relevant one. The tap rule reads the same number that sets the drawing order. If those two ever disagreed, the user would tap the pin they can see and get the one behind it.

![Two overlapping pins. The finger is on the visible head of the front pin, but the back pin's tip lies under the finger. Nearest-tip picks the back pin, whose head is hidden. Painted-on-top picks the front pin, the one the user touched.](/images/blog/marker-paint-order-rule.svg) If the finger misses every pin outline, the nearest pin within about twelve pixels wins. That allowance exists because a fingertip is about 7 mm wide, while the pointer is only three pixels wide near its tip. A tap that is clearly at a pin often lands just outside its outline.

## The first version made it worse

The first build with the new rule went out to a phone and came back with one line: *"categorically worse behaviour."* On Android, pins with nothing near them opened a different pin. On iOS, some pins stopped responding at all. The rule was right. Four things it depended on were not.

| What the user saw | What was actually happening | What fixed it |
|---|---|---|
| Android: a lone pin opens a different place | Two places sat at the same coordinate. We assumed Google draws them in the order we sent them; Google's documentation says the order is arbitrary, and it was. Our rule picked the one we thought was on top, Google had drawn the other one on top. | Every pin gets its own stacking number, built from its search relevance with a tiebreak, and both the drawing and the tap rule use that same number. |
| iOS: the same, in dense packs | Our stacking numbers had a fraction in them to keep them unique. iOS stores that number as a whole number, so the fraction was silently thrown away and pins tied again. | Whole numbers only. |
| iOS: a pin lights up and immediately goes dark | iOS reported each tap twice, once from the pin and once from the map. The second report deselected what the first had selected. | The first report of a tap wins; any repeat at the same spot within half a second is ignored. |
| iOS: some pins ignore taps | A finger just outside a pin's outline used to be handled by MapKit's rectangle. We had replaced that with nothing. | The nearest pin within about twelve pixels wins, which is also how a fingertip 7 mm wide actually lands. |

The tiebreak was first the pin's position in the result list. In October it became a hash of the place's own id. Ranking by list position renumbered every pin after a dropped one on each pan, and on Android that re-sent every pin's stacking number to the map.

None of these showed up in the unit tests, because the unit tests encoded the same assumptions we had. Every test we could write would agree with us. We needed a judge that could not: the pixels on the screen, and real touches, on the real app.

## The test rig: trust nothing but the screen

The ask was explicit: *"set up a test harness against native code and JS code together without needing a sim."* The requirement underneath it is the one that matters. Every layer between our code and the screen had an opinion about what a tap meant, and every one of them had been wrong at some point. So the rig had to run the real app, use the real SDK and put a real finger down. It had to take its answer from the one place none of those layers could edit: the screenshot.

It ended up as four layers of tests, each catching something the one below could not.

**1. Draw the Android pin on a laptop and check every pixel.** No phone, no emulator. The code that draws the Android pin runs on an ordinary computer under Robolectric, a tool that lets Android code run outside a phone. The result is compared pixel by pixel with the shape file, at the screen densities of our test phones. A second test saves the drawn pins as images and runs the tap rule over them. That checks the code that draws and the code that decides against each other, in one place.

**2. Run Apple's real map code inside the real app.** Apple's map classes, and the layer of `react-native-maps` on top of them, cannot be tested on their own. They only compile as part of the app. So the iOS tests live in a separate project that loads the actual CamperMate build and drives its map objects directly: create a pin, remove it, reuse it, tap it, ask where its frame is. Three more tests mount a second, test-only screen inside the running app's own React Native instance, then read back what JavaScript received. Every patch we made to the SDK is checked by undoing it and confirming that exactly one test fails.

**3. Put real fingers on real pins, where the test says they are.** On iOS, a test places three pins on the live map, writes their screen positions to a file, and waits. A script reads the file and uses Maestro, a tool that taps a phone's screen from a script. It taps the map above pin *a*, the centre of pin *b*, and the empty corner beside pin *c*. The test then checks what JavaScript was told. One lesson: touches never reach a test window unless it has a root view controller, the iOS object that owns what a window shows.

**4. Real fingers on Android, inside the running app, judged by a screenshot.** An Android test mounts the same test-only screen inside the app. It works out where each pin's image is from Google's projection and the pin's anchor, and injects real touches there. Android has no way to ask which pin it drew on top, so the test reads the screen. It takes a screenshot, looks at the pixel at the centre of the selected pin, and checks that it is the brand yellow before and after the tap. Three lessons from this one:

- the standard automation click never reaches this window;
- the app has no keyboard focus for about ten seconds after the screen mounts;
- two touches on one spot within 0.7 s count as a double-tap zoom.

At the end of that day, someone asked whether all this was "a sad indictment" of the developer experience. The summary we wrote down was this. Three layers of software never agreed on what a tap meant, and the only description of the truth was the pixels on the screen.

## What the screen showed

The rig disproved our best theory and found the real bug. That is the reason this post exists, so here is exactly how it happened.

The report was vivid: *"I'm literally clicking one POI a very long way away and an iOS marker on the other side of a mountain range turns on."* Our theory was view recycling. Fabric reuses the native view behind a pin for a different pin. If the old pin's annotation was still on the map, a tap on it would be reported under the new pin's name. We patched the recycling hook, `prepareForRecycle`, to disconnect the old annotation and take it off the map.

It was plausible. Reverting it made a test fail. And it was wrong. A test that creates and destroys pins twelve times over through the real renderer, with the patch reverted, left no stale annotations behind. The patch stays in as a precaution.

The test that checks where each pin's frame sits found the actual bug. **On Apple Maps the `anchor` prop does nothing.** The docs do say so, in one line we had never read: "iOS: Google Maps only. For Apple Maps, see the `centerOffset` prop." We had passed `anchor` on both platforms for a year, and nothing at runtime warned us.

We had asked for the pin to hang from its bottom centre (`anchor {0.5, 1}`). The Fabric marker in `react-native-maps` ignores that and reads only `centerOffset`, which was zero. So every pin, 40 points wide and 45 tall, sat centred on its coordinate, with its tip drawn 22.5 points too low. The JavaScript hit test assumed the tip was on the coordinate. The shape it checked therefore floated 22.5 points above the pin the user could see. Empty map above a pin selected it. A tap on the drawn circle mostly missed and fell through to the nearest-pin fallback. Even the info window's iOS lift had been "tuned on device" against those low-drawn pins.

The fix is one constant, `{0, -containerHeight / 2}`: shift the view up by half its own height. Every iOS pin moved up to where its coordinate is, in line with Android.

![Before: the iOS pin is drawn centred on its coordinate, so its tip is 22.5 points too low, while the invisible shape the hit test checks has its tip on the coordinate and floats above the drawn pin. After: the two coincide.](/images/blog/marker-anchor-drift.svg)

Other findings, in the order the screen gave them up:

- **Every pin blinked on every selection (iOS).** A frame-difference filter over a cluster far from the tapped pin showed every other pin blanked for two frames. Fabric treats a change to a pin's stacking number (`zIndex`) as a reorder of siblings. It does that by removing and re-inserting the view, and MapKit lays out every annotation again on any add or remove. Raising the selected pin by 1,000 instead of 999,999 flashed just the same. A separate overlay marker mounted on top did not. So base pins never change props when selected now; the highlight is its own marker on both platforms.
- **The peek took forever to disappear.** JavaScript dismissed it within 50 ms of the map reporting a press. The wait came before that. On both platforms, the single-tap recogniser waits to see whether a second tap follows before it reports the first. The peek now hides the instant a finger touches the map, and the selection clears once the tap is confirmed.
- **The invisible strip under the card.** The info window's tappable area included an invisible strip, the full width of the card, between the card and the pin. Tapping the gap opened the place on both platforms. The tappable area is now the card itself.
- **On Android, showing an info window overrides the stacking order.** `react-native-maps` calls `showInfoWindow` on every tapped marker when `moveOnMarkerPress` is off. Google draws the marker whose window is showing above every other marker, whatever its stacking number, and an empty window still counts. That is why the selection overlay had been rendering perfectly, and invisibly, underneath. The patch shows a window only for a marker that has one. The proof was the pixel at the circle centre.
- **A tap on empty sea opened a random place (Android).** The finger missed every pin outline, and no pin was within the twelve-pixel allowance. The code still selected whichever marker Google had named. Android's finger position is exact now, so a miss there is a background tap. iOS keeps its fallback, because MapKit's frame is at least the pin's own box.
- **An invisible dev-only control.** A 96-by-72-pixel button for triggering end-to-end tests rendered in every dev build. It was transparent, sat in the left-middle of the map, and ate taps. "This popup broke marker clicks" was true, and the popup was innocent.

## Dense packs, with real data

Three pins on a test screen is not what users see. Around every popular tourist town, CamperMate shows a dense pack of pins all the time: Queenstown, Wellington, Byron Bay. That is where the wrong-pin bug lived. So the tests use real data. A script pulled up to 250 of the nearest places around each of six such towns, 1,266 in all, straight from the production search index.

A test lays each scene out on a phone screen at four zoom levels, from whole town down to a single block, in the app's paint order. Then it simulates a tap every three pixels across the whole pack: tens of thousands of taps per scene. It checks four things:

- the hit test returns the pin painted at every pixel;
- the geographic pre-filter, which picks the nearby pins worth checking, never drops that pin;
- every pin with any visible ink can be tapped;
- one tap over the densest pack takes under 2 ms.

It found a real flaw on its first run. The nearest-pin fallback kept a running best, and let near-ties drift along a chain: B to C to A, each within the tie band of the last. It could end up answering a pin farther away than the nearest, or one beyond the twelve-pixel allowance entirely. Ties are now measured from the minimum distance, and the allowance is a hard limit on the answer.

On device, we tested 160 real Wellington places at suburb zoom with four real touches. iOS got four of four, and Android four of four. Each was checked against the pin the operating system actually painted on top. On iOS that is decided by each layer's stacking position. The system's own hit-testing walks the view tree in a different order, so it cannot be the answer key.

## Then Android was correct and slow

With both platforms finding the right pin, the next report was about feel: *"on Android it's nowhere near as fast as iOS when switching between info windows. Noticeably bad. There's a huge lag."*

Every Android tap was waiting on Google. When a finger lifts, the Google Maps SDK holds the event for 300 ms, to see whether a second tap follows, because two taps mean zoom. Only then does it run its own marker hit test and call the app. iOS pins have their own tap recogniser and never waited. We measured on the arm64 emulator, from the finger touching the screen to the app's JavaScript hearing about it:

| tap | before | after |
|---|---|---|
| empty map | 295 ms | 21 ms |
| centre of pin *b* | 649 ms | 22 ms |
| dead corner of pin *c* | 709 ms | 22 ms |

The patch listens for the finger lifting, on the gesture detector that already sees every touch before Google does. It tells the app right then, with the finger position. Google's own callbacks for that same lift are then ignored. A flag is set when the fast path fires and cleared when the next finger comes down. A long press or a drag that Google consumed is never also a tap. And the tap's screen position is converted to a map position once and reused. Before, it crossed between native code and JavaScript three times in a row.

The same change made Android pins fade in over 250 ms once their bitmap lands. That also hides Google's red default pin while a cold bitmap decodes. The old native app had the same entrance.

Code review caught two things the harness had not. A pin whose image failed to load could be left fully transparent: invisible, but still tappable. Both failure paths now fall back to Google's default pin. And in the location picker, Google's My Location button became a map press, dropping the pin under the button. The screen has its own button, so Google's is off.

One behaviour change was accepted. A double-tap to zoom with a peek open now closes the peek on the first tap. That is the same as iOS, and new on Android.

![Two timelines of an Android tap. Before: finger down, finger up, Google waits 300 ms to rule out a double tap and runs its own hit test, and the app hears about the tap 649 ms after the finger went down. After: the app is told 22 ms after the finger lifts, and Google's own callbacks for the same tap are ignored.](/images/blog/marker-tap-timeline.svg)

## The website had the same bug, and two of its own

The website's map had the identical complaint, and the ask was direct: *"look at how we did marker hit box and cleanup fixes for 5.6.1 in campermate-react-native. we are struggling with the same tap targets on mapbox in mobile / desktop views on campermate.com."* Three minutes later came: *"clicking on different markers shows the infowindow photo for the previous marker."*

Reading the `mapbox-gl` source rather than its docs turned up the same class of defect. Mapbox resolves a click on a symbol layer against the icon's collision rectangle: the whole padded canvas, transparent badge margins included. So a tap in the dead corner of one pin's box, over the visible head of a lower pin, selected the wrong pin.

Worse, two handlers answered every click. The layer's handler set the selection. Then a map-level handler re-queried one pixel and cleared the selection if the query disagreed. A finger 5 px off a 36 px head counted as a background click and closed the panel. The stale photo was simpler. The panel's image element had no React `key`, so React reused the same element and only changed its address. The browser kept painting the previous place's photo until the new one downloaded.

The port was almost verbatim. `lib/Maps/markerHitTest.ts` on the web is the app's hit test. `pinGeometry.json` started as a model of the app's geometry. A day later it became a copy of it, with the app's Android drawing constants alongside, so the web pin matches the app's pin to the pixel.

One click handler now owns the click. Mapbox lists the pins drawn in a box around the click, and each is converted to a screen position. Then the same rule decides. The pin whose outline holds the click wins, topmost first. Failing that, the nearest pin within about twelve pixels wins. Otherwise the click was on the background, exactly as on Android, because a mouse pointer is exact.

The dense-pack sweep was ported with its six towns. A Playwright test bundles the real renderer, draws the pin on a real canvas and checks every pixel's transparency against the shape rule. It is the web's counterpart of the Android laptop test. Another drives the real desktop map with a mouse. On the Queenstown pack there are 44 points where Mapbox's rectangle names the wrong pin and the silhouette names the right one.

Then the web had two surprises the apps did not.

**Mapbox's query order is not its paint order.** The first version took the order `queryRenderedFeatures` returns as the draw order. The PR description said so: "verified in the 3.29 source". That holds only for layers Mapbox sorts by screen position, top to bottom. Our pin layer sets a sort key instead, so that search relevance decides what draws on top, as in the app. With a sort key set, `mapbox-gl` never records its draw order at all. It returns results in the reverse of the order the data arrived, unrelated to what it drew.

So the wrong pin could still win whenever results arrived most-relevant first, which is the common case. The test's answer key shared the same assumption, which is why everything passed. Paint order now comes from each feature's own sort key, with the query position as the tiebreak for equal keys. The test's answer key applies that rule independently. The pointer cursor uses the same resolver too. Until then, the cursor promised a click on the rectangle's corners that the silhouette then read as background.

**`map.project` returns one world copy.** Take a pin drawn on a wrapped copy of the world: any low zoom with copies rendered, or a Chatham Islands viewport. It projected a world away from the click and read as background. Each candidate is now projected three times: at its own longitude, and one full world width east and west. The copy nearest the click is kept. The info window's placement had the same seam bug, fixed by reusing the helper.

The port also exposed a regression nobody had noticed. The info window's tail, the small triangle pointing at the pin, had disappeared in April. That was when the card stopped being part of a DOM marker and became an absolutely positioned element, lifted a flat 18 px, over the head of its own pin. Tapping pins had been unreliable enough that nobody saw where the card landed. The tail is back, and the lift comes from the shared geometry. The placement rule is the app's: above, below when there is no room, beside at the edges, tail always on the pin.

One thing did not port. In Mapbox, `icon-size` is set per layer, not per pin, so the app's iOS sprout animation is not available on a symbol layer. Opacity is per pin, so the web pins fade in instead, Android's entrance, over 150 ms.

## Would this have been easier without React Native in the way?

It is a fair question. The six upstream issues below are all `react-native-maps` bugs, and it would be easy to read this post as "React Native made maps hard". The honest split is about one third to two thirds.

**The part the SDKs own, which native would have hit just the same.** The CamperMate apps before React Native used the Google Maps SDK on both platforms. Both took the SDK's answer as the answer. The iOS app's `didTapMarker:` and the Android app's `OnMarkerClickListener` each opened whichever marker Google named, with no hit test of their own. So Google's oversized, upward-shifted hit zone was in those apps for years. So was Google's 300 ms wait before reporting a single tap, since the native apps waited on the same callback.

The rest is SDK too: arbitrary draw order for two markers at one coordinate, `showInfoWindow` pulling a marker above every stacking number, and no SDK telling you which marker it painted on top. A native app that wanted the right pin would have needed the same silhouette, the same paint-order rule, the same finger-up dispatch, and a screenshot to check its work.

**The part React Native added.** Every bug in the "finger position" half of the fix was the bridge. A press position read out of a dictionary that only holds latitude and longitude. A finger measured against a callout view that did not exist. Android reporting the marker's position instead of the finger's. A native app gets the touch point from the gesture recogniser or the motion event and never has this problem.

`anchor` doing nothing on Apple Maps is a leak in an abstraction; the old iOS app set `groundAnchor` itself, in one line. Whole-number stacking numbers, the blink when one pin's `zIndex` changes, and the tap reported twice are all artefacts of the layer in the middle. And most of the days went on the rig. With three layers between the finger and the SDK, the only way to test was to mount a screen inside the running app and inject touches from outside it. Natively, that is an ordinary XCTest or Espresso test with the views in hand.

One caveat cuts the other way. Native would have made it easier not to notice. The native apps tolerated the hit-test defect for years, because no framework amplified it into "a marker on the other side of a mountain range turns on". React Native made it bad enough to force the fix. The fix itself, silhouette plus paint order plus finger position, is the same on every platform, and would have been worth doing natively too.

## What we would tell someone starting this

- **Build the rig before the theory.** Every explanation we reasoned our way to was wrong, including one we had already patched and mutation-tested. The test that took a screenshot and looked at a pixel was right every time. The one web test that shared our assumption, instead of checking the screen, passed for a day while being wrong. When the layers below you disagree with each other, the screen is the only witness they cannot argue with.
- **No map SDK answers "which pin did I tap".** MapKit tests a frame, Google tests an offset region, Mapbox tests a collision rectangle. Their documentation describes the event, not the shape. Read the source. Then decide it yourself, from the finger position, against the shape you draw, in the order you paint.
- **Put the pin's geometry in one file** and test every renderer against it, pixel by pixel. Our first hit box described a pin nobody drew any more.
- **Paint order is part of the hit test.** Make it unique, make it an integer, and read it from the same field on both sides. Never take a query's result order as the draw order without checking which sort the layer uses.
- **On Apple Maps, `anchor` does nothing and `centerOffset` is the whole story.** The docs say it in one line; nothing at runtime does. Changing `zIndex` remounts the annotation and lays out every other one again, so highlight with a separate marker.
- **Mutation-test the patches.** A hunk that stays green when reverted is decoration. One of ours was.

The `react-native-maps` changes that are general, rather than CamperMate-specific, are filed upstream with their diffs:

- the Fabric press position and the nil callout view ([#6002](https://github.com/react-native-maps/react-native-maps/issues/6002));
- the callout z-position boost that never applied ([#6003](https://github.com/react-native-maps/react-native-maps/issues/6003));
- the blink when one pin's `zIndex` changes ([#6004](https://github.com/react-native-maps/react-native-maps/issues/6004));
- Android reporting the marker's position instead of the finger's ([#6005](https://github.com/react-native-maps/react-native-maps/issues/6005));
- `showInfoWindow` raising pins above every `zIndex` ([#6006](https://github.com/react-native-maps/react-native-maps/issues/6006));
- the finger-up dispatch, with its latency table ([#6007](https://github.com/react-native-maps/react-native-maps/issues/6007)).

The Mapbox finding went onto the existing report of query order ignoring `symbol-sort-key` ([mapbox-gl-js #10800](https://github.com/mapbox/mapbox-gl-js/issues/10800#issuecomment-5722789154)).

Everything else here is the shape of the work: a year of following the docs, then a few days of reading what the SDKs actually do, and building something that could tell us when we were wrong.
