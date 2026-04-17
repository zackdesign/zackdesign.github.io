---
layout: post
title: "Tic-Tac-Toe Redux Dojo — teaching state management"
description: "An open-source introductory Redux coding dojo built around a tic-tac-toe reducer — commit-by-commit steps for state, actions, and the time-travelling devtools."
excerpt: "A Redux coding dojo built around tic-tac-toe — commit-by-commit steps, reducer-first thinking, and the time-travel devtools as the payoff."
image: /images/blog/tic-tac-toe-redux-dojo.jpg
image_alt: Chess pieces arranged on a board — strategic state, one move at a time
date: 2017-05-11
last_modified_at: 2017-05-11
categories: [open-source]
tags: [redux, react, javascript, coding-dojo, open-source, teaching]
---

Redux was still finding its feet in Australian dev teams in 2017, so Zack Design published [tic-tac-toe-redux-dojo](https://github.com/isaacrowntree/tic-tac-toe-redux-dojo) — a small, commit-driven workshop that teaches reducer-first state management by building the simplest game anyone can picture in their head.

<!-- more -->

## Why tic-tac-toe

Any state-management story needs a problem small enough to fit on a whiteboard but rich enough to justify the ceremony. Tic-tac-toe is exactly that: nine cells, two players, a clear win condition, and — critically — an undo/redo story that only really sings once Redux is in place.

## How the dojo runs

Each step of the workshop is a commit. Participants clone the repo, `git reset --hard` to step zero, and walk forward at their own pace:

1. Start with a dumb React component and hard-coded state.
2. Introduce actions and a reducer. Watch the component shrink.
3. Wire in the store and `connect()`. Feel the boilerplate, talk about why.
4. Install the [Redux DevTools extension](https://github.com/reduxjs/redux-devtools) and replay the whole game backwards — the moment it clicks for most people.

Guide notes, hints, and the full progression live in the commit history, so facilitators can run it sync or async.

## What makes it stick

Teaching Redux cold with a TodoMVC clone tends to produce blank faces. Starting with a game — with an obvious "did I win?" predicate, an obvious history, and an obvious time-machine — turns the abstract ideas (pure reducers, immutable updates, action logs) into things you can literally watch happen.

The dojo has been re-used inside Zack Design's own team and by a few friendly shops running internal learning sessions. If you are planning a Redux onboarding day, [fork it](https://github.com/isaacrowntree/tic-tac-toe-redux-dojo) — pull requests welcome.
