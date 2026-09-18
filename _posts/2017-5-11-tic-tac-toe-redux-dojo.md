---
layout: post
title: "Tic-Tac-Toe Redux Dojo — teaching state management"
description: "An open-source Redux coding dojo built around a tic-tac-toe reducer — every step is a commit, and the payoff is replaying a whole game backwards in the devtools."
excerpt: "A Redux coding dojo built around tic-tac-toe — every step is a commit, reducer first, and the time-travel devtools as the payoff."
image: /images/blog/tic-tac-toe-redux-dojo.jpg
image_alt: Chess pieces arranged on a board — strategic state, one move at a time
date: 2017-05-11
last_modified_at: 2017-05-11
categories: [open-source]
tags: [redux, react, javascript, coding-dojo, open-source, teaching]
---

Teaching Redux with a todo list produces blank faces: nobody can feel why a todo needs a reducer. Redux is a JavaScript library that keeps an application's whole state in one object and changes it only by running one function, the reducer, over a log of actions. Tic-tac-toe is nine cells, two players, one rule for "has someone won" and an obvious history, and it fits on a whiteboard. [tic-tac-toe-redux-dojo](https://github.com/isaacrowntree/tic-tac-toe-redux-dojo) is a workshop built on that game, where every step is a git commit and the finale is watching a finished game replay itself backwards, one move at a time.

This post covers how the one-commit-per-step format runs in a room, the four stages the code moves through, and the moment where Redux stops feeling like ceremony.

<!-- more -->

## Every step of the workshop is a git commit

Each stage of the workshop is a commit. Participants clone the repository, reset their working copy to the first commit (`git reset --hard` to step zero), and move forward through the commits at their own pace. The facilitator's notes and hints live in the commit messages, so the same repo works as a live session or as homework.

1. A React component with the board state hard-coded inside it. It renders a board and nothing else.
2. Actions and a reducer. The component shrinks, because the rules of the game move out of it and into the reducer.
3. A store and `connect()`, the Redux helper that hands state to a React component. This is the step with the most boilerplate, and the step where the group talks about why the boilerplate exists.
4. The [Redux DevTools browser extension](https://github.com/reduxjs/redux-devtools). Play a game, then drag the extension's history slider back to the empty board.

## The step where it clicks

Step four is the point of the exercise. Reducers with no side effects, updates that never modify existing state, and a log of every action are abstractions until you watch the board un-play itself. The game gives every one of those ideas a visible consequence: "did I win?" is a function of the current state, the history is the action log, and undo comes for free because no reducer ever modified anything in place.

## Run it

If you are planning a Redux onboarding session, [fork it](https://github.com/isaacrowntree/tic-tac-toe-redux-dojo) — pull requests welcome.
