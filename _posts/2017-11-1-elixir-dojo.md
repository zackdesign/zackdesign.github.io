---
layout: post
title: "Elixir Dojo — functional programming, zero local setup"
description: "A Dockerised wrapper around Eric Meadows-Jönsson's Elixir workshop: one image, one shared folder, and nothing Erlang-related is ever installed on the laptop."
excerpt: "A Dockerised wrapper around Eric Meadows-Jönsson's Elixir workshop — Erlang, Elixir and the test runner live in the container; the editor and the code stay on the laptop."
image: /images/blog/elixir-dojo.jpg
image_alt: Instructor writing an equation on a whiteboard during a coding dojo
date: 2017-11-01
last_modified_at: 2017-11-01
categories: [open-source]
tags: [elixir, functional-programming, docker, coding-dojo, open-source, teaching]
---

A half-day Elixir workshop loses its first forty minutes to "does everyone have Erlang installed?". Elixir is a language that runs on the Erlang virtual machine (the BEAM), so a working setup means installing Erlang, then Elixir, then `mix` (Elixir's build and test tool), at versions that agree with each other and with whatever is already on the laptop. Across a room of Macs, Windows laptops and Ubuntu virtual machines, that is forty minutes of fighting package managers before anyone writes a line of Elixir. [elixir-dojo](https://github.com/isaacrowntree/elixir-dojo) removes that step: it wraps Eric Meadows-Jönsson's [Elixir workshop](https://github.com/ericmj/workshop) in a Docker image, a packaged Linux environment that runs the same way on any machine, so the only thing a participant installs is Docker.

This post covers where the line sits between what runs in the container and what stays on the laptop, the one shared folder that lets participants keep their own editor, and the command sequence a facilitator hands out at the door.

<!-- more -->

## The toolchain runs in the container; the code stays on your laptop

The trick is not the container. It is where the boundary sits. Erlang, Elixir, `mix` and the test runner are installed inside the image. The workshop source stays on the laptop, and that one folder is shared into the container, where it appears as `/code`. Participants keep their own editor, their own keybindings and their own git configuration. The container only ever sees files.

![The laptop keeps the editor, git configuration and Docker; the container holds the Erlang virtual machine, Elixir and mix; one shared folder straddles the line, called workshop on the laptop and /code inside the container.](/images/blog/elixir-dojo-boundary.svg)

```bash
git clone git@github.com:isaacrowntree/elixir-dojo.git
cd elixir-dojo
git clone git@github.com:ericmj/workshop.git
docker build . -t elixir_dojo
docker run -it --rm -v $(PWD):/code elixir_dojo bash
cd workshop && cd labX && mix test
```

The `--rm` flag throws the container away on exit, so a participant who breaks their environment recovers by running `docker run` again. Because the folder is shared rather than copied, an edit saved in VS Code, vim or IntelliJ on the laptop is what `mix test` runs against inside the container the next time it is invoked. There is no copy step.

## Why a hands-on workshop and not a talk

A coding dojo is a workshop where everyone writes code, usually in pairs, on small exercises. Eric's material is a series of labs, each a set of failing tests to make pass. That format suits Elixir: pattern matching, data that is never modified in place, and supervisor processes that restart the processes under them are ideas that read as obvious in a textbook and only become real when a red test turns green because you matched on the right shape of data. Small labs, a partner to pair with and a fast `mix test` loop teach more than an hour of slides.

## Run your own

Fork [the repo](https://github.com/isaacrowntree/elixir-dojo), build the image once on your own network before the session, and hand out the command block above. Huge thanks to Eric for the original workshop material that this dojo wraps around.
