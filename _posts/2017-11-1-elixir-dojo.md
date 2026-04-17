---
layout: post
title: "Elixir Dojo — functional programming, zero local setup"
description: "A Dockerised Elixir coding workshop based on Eric Meadows-Jönsson's Elixir workshop — cloneable, buildable, and ready to run in a single command."
excerpt: "A Dockerised Elixir coding dojo — one command in, one workshop out. No local Erlang install required."
image: /images/blog/elixir-dojo.jpg
image_alt: Instructor writing an equation on a whiteboard during a coding dojo
date: 2017-11-01
last_modified_at: 2017-11-01
categories: [open-source]
tags: [elixir, functional-programming, docker, coding-dojo, open-source, teaching]
---

Running a functional-programming workshop without losing the first forty minutes to "does everyone have Erlang installed?" is harder than it looks. Zack Design's [elixir-dojo](https://github.com/isaacrowntree/elixir-dojo) wraps Eric Meadows-Jönsson's well-loved [Elixir workshop](https://github.com/ericmj/workshop) in a reproducible Docker image, so a room full of developers on Macs, Windows laptops, and random Ubuntu VMs can start writing Elixir within minutes.

<!-- more -->

## The setup problem

Elixir runs on the BEAM, which means installing Erlang, then Elixir, then `mix`, then the right versions of each — and then hoping nothing conflicts with whatever your host OS already has. At a half-day workshop, that friction is the difference between "I wrote my first GenServer today" and "I fought my package manager today."

## The dojo

Clone, build, run:

```bash
git clone git@github.com:isaacrowntree/elixir-dojo.git
cd elixir-dojo
git clone git@github.com:ericmj/workshop.git
docker build . -t elixir_dojo
docker run -it --rm -v $(PWD):/code elixir_dojo bash
cd workshop && cd labX && mix test
```

The volume mount means participants edit files on their host OS using whatever editor they like — VS Code, vim, Sublime, IntelliJ — while the BEAM, `mix`, and the test runner all live safely inside the container.

## Why it matters

Elixir is, in my view, one of the most pleasant languages to pick up once you clear the tooling hurdle — pattern matching, supervision trees, and immutable data structures all feel obvious in a way they rarely do when you read a textbook. A dojo is an ideal on-ramp: small labs, clear goals, a partner to pair with, and failing tests that turn green as you start to *get it*.

If you are running an Elixir intro session with your team, [fork the repo](https://github.com/isaacrowntree/elixir-dojo) and save yourself the tooling tax. Huge thanks to Eric for the original workshop material that this dojo wraps around.
