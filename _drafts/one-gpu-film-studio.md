---
layout: post
published: false
title: "Kingdom: directing a music video with AI agents on one 12 GB graphics card"
description: "I'm making a music video for Devin Townsend's Kingdom on a gaming PC under my desk. Claude agents do the work of a small film crew: they study reference videos by measuring them, write a storyboard in which every shot has to earn its place, keep two invented characters' faces consistent, design motion that lands on the drums, and check every frame before I watch anything. Open-source models do the pixels, on an RTX 4070 Ti, for a few dollars of electricity a day."
excerpt: "Making one good four-second AI clip is easy now. Making a hundred and nine that tell one story, keep the same two faces and hit the drums of a five-and-a-half-minute song is a directing problem. This is how a crew of agents on one consumer GPU is doing it for a Devin Townsend song, and the same process now runs every film I make."
# image: /images/blog/kingdom.jpg
# image_alt: TODO — a frame from the Kingdom draft (the citadel under the black sun)
date: 2026-10-11
categories: [engineering]
tags: [ai, generative-video, music-video, comfyui, wan, blender, lora, agents, claude-code, gpu-scheduling]
---

<!-- DRAFT: not for publishing yet. Before publishing:
  - hero image: a frame from the finished Kingdom cut; 2–3 inline figures (a storyboard row, a drum-hit/flash plot, the LoRA face sheet)
  - no lyrics anywhere; link the song, don't quote it
-->

*Kingdom* is a Devin Townsend song about an apology: a man who chose building something over staying with the person
he loved. I wanted a music video for it that felt like a nightmare, a journey into a hellscape. There's no crew, no
set and no budget, just a spare gaming PC with an RTX 4070 Ti under my desk.

The models that make the pixels are open source and run on that card: Wan 2.2 for video, Z-Image for stills,
RIFE and FlashVSR to finish. But the models were never the hard part. A good four-second clip is easy now. A music
video is a hundred of them that tell one story, keep the same two faces and land on the drums. That's directing, so
I built a crew of Claude agents that direct, and gave them a method they have to follow.

<!-- more -->

## Watch the references, then measure them

I named a few artists I wanted it to feel like. The agents don't just read about them: they download the videos for
private study and measure them. Cuts per minute, how often a cut lands on a beat, how many of the flashes are full
white rather than a pulse of light, the brightness and colour of every section.

The numbers overturned the obvious approach. The professional videos hardly cut on the beat at all. Their sync is
inside the frame: light pulses, things slamming, flashes that peak about two frames before the drum. Each video
also changes its world once, somewhere between half and three-quarters of the way through, right after its densest
cutting. Those measurements became targets.

The look came the same way. I wanted "Harkonnen meets *Alien*", so the agents measured the official *Dune* and
*Alien* trailers instead of guessing. The result is a near-black-and-white world: deep shadows that still hold
detail, hard light from things you can see in the scene, real-looking materials, grain. Colour is kept for meaning.
Everything in the citadel is cold. Warm light belongs to her alone.

## A story where every shot earns its place

The video follows the song's arc as an Orpheus story. A man crosses a black desert to a living, biomechanical
citadel: the thing he built instead of staying. Its corridors have grown out of their old home: a teacup in the
wall, a table for two, her coat. On the throne is a king who turns out to be him. Deep inside, under the throne,
the citadel's heart is running on her warmth. He apologises, tears his old self out of the throne, and the kingdom
dies. They end up together in the ruin, under a black sun, with the only warm light between them.

Before anything is rendered, a director agent turns that into a storyboard of 109 shots. Every row has to say what
the viewer learns from that shot, or what changes, and why it comes after the one before it. A shot that only
exists to fill a beat in the music is cut. A shot can only come back as a callback whose meaning has changed, like
her scarf: a gift, then drained grey on the king, then binding their hands at the end. The fast cutting before the
world changes is new coverage of one action (the throne seizing him) from thirteen angles, never recycled footage.

The storyboard arrives as a page of panels I can read on my phone. It's one of only two things I approve. The other
is the watched draft.

## The same two faces in every shot

Invented characters are where AI film usually falls apart: a written description gives you a different person
every time. So each character starts as one approved still, which is animated to get frames from every angle. From
those, the agents train a small character model (a LoRA) in about an hour and a quarter on the same card. Measured
against the approved still, face similarity more than doubled for both leads, and at the strength chosen, the sets
around them survive. Nobody real is underneath, so there's no one's likeness to borrow.

## Motion that lands on the drums

A video model mostly re-animates the still you give it. Hand it a sleeping figure and you get a sleeping figure,
however you tune the sampler. So motion is designed into each storyboard row, along with where it comes from:

- **When the citadel acts** (pistons slamming, the heart pumping, a gate of ribs opening), Blender animates it on
  the depth of the shot's own keyframe. The drum track is separated out and every big hit becomes a keyframe, so the
  machinery slams on the beat. Then the shot is repainted in the house look.
- **When a body does something hard**, like the climb or the fall, the timing and weight come from a real performer
  in online footage.
- **Wide shots** get real parallax from a depth-displaced copy of the still, with drifting ash.
- **Everything else** is written action-first (the verb, what causes it, how fast, where it ends) and rendered in
  several takes. The ones that move most go on to frame-by-frame review.

On top of the story go the accents: 42 full white flashes on the biggest unison hits and about a hundred partial
light pulses, all peaking two frames early. They're capped at three full flashes in any second, the
photosensitivity limit.

## My notes become checks

The expensive part of this isn't GPU time. It's me watching a draft, writing notes and waiting for the next one. So
every note I give becomes an automatic check that the next draft has to pass before I see it:

- **Sync:** what share of the big drum hits has something happening in the frame, and is it on time or early?
- **Flashes:** is every planned flash there, and is the cut inside the safety limit?
- **Progression:** do the cut rate and colour build to one world change at the right point?
- **Colour:** does each section sit inside its colour band, with warm pixels only in her shots?
- **Story:** does every shot have a written purpose, and is any shot a near-duplicate of another without being a
  callback? This one runs on the storyboard, before a single frame is rendered.
- **Finish:** do textures stay steady or boil, are highlights clipped, how much does the grade drift between
  shots, and does the subject actually move?

An agent also makes contact sheets of every clip and counts the hard artefacts (extra hands, faces changing,
figures vanishing) before re-rolling them. Each draft arrives with notes that list what still isn't good enough.

## One card, many agents

Several agents work at once: one finding the right settings, a director, one producing keyframes and clips, one in
Blender, and one writing the checks. They share one GPU through a small queue. It's fair, because the oldest job
goes next. It's model-aware: it prefers another job of the kind that just ran, because swapping a 9 GB video model
for a stills model costs more than the job itself. Long jobs like training a character model run as one block when
the card would otherwise be idle. A `pause` command holds the card through a reboot without losing anyone's place.

Drafts are rendered at 480p. Only after I've watched one do the chosen shots go to 720p, get interpolated to 24 fps
and upscaled to a 1440p master. Under sustained load the card sits around 77 °C and the machine draws 350–400 W:
about three or four Australian dollars for a full day of rendering.

## Where it stands

Faces still drift on long holds, so the reliable unit is three to five seconds. Hands touching things are the
weakest shots, and lip sync isn't there yet. But the process is what matters. Kingdom is the music video, and the
same steps now run everything else I'm making: a novel chapter, a dozen short Bible scenes and the opening of *The
Silmarillion*:
1. measure the references;
2. write a story where every shot earns its place;
3. lock the faces;
4. design the motion;
5. let the checks watch every frame first.
