---
layout: post
title: "local-llm-coding-guide — Qwen, Gemma, and llama.cpp as a coding assistant"
description: "A benchmarks-first guide to running Qwen3.6, Qwen3.5, and Gemma 4 locally as a coding assistant — llama.cpp, Ollama MLX, ExLlamaV3, and TensorRT-LLM, with real tok/s numbers."
excerpt: "A benchmarks-first guide to running local LLMs as a coding assistant — Qwen3.6, Qwen3.5, and Gemma 4 on an RTX 4070 Ti, a 3090, and an M3 Pro MacBook with real tok/s and memory numbers."
image: /images/blog/local-llm-coding-guide.jpg
image_alt: Abstract neural network illustration representing large language models
date: 2026-03-14
last_modified_at: 2026-07-03
categories: [ai, guides]
tags: [llm, llama-cpp, ollama, mlx, qwen, gemma, local-ai, coding-assistant, guides]
---

Zack Design has published [`local-llm-coding-guide`](https://github.com/isaacrowntree/local-llm-coding-guide) — a no-fluff, benchmark-driven guide to running a genuinely useful local LLM as a coding assistant on consumer hardware. It covers Qwen3.6, Qwen3.5, and Gemma 4 across llama.cpp, Ollama (with MLX), and vllm-mlx — plus ExLlamaV3 and TensorRT-LLM on NVIDIA — with real tokens-per-second numbers from three real machines.

<!-- more -->

> **Updated July 2026.** The guide has grown a lot since this post first went out. The highlights are summarised in [What's new since launch](#whats-new-since-launch) below.

## Why local

Cloud LLMs are wonderful until you are on a flight, behind a client VPN, editing code with sensitive data, or burning through a monthly token budget faster than is reasonable. The quality gap between the best frontier models and the best *local-runnable* models has narrowed dramatically — a quantised 9B Qwen model on a modest NVIDIA card is now perfectly capable of the "reformat this function, add a docstring, write a test" type of work that makes up most of a coding assistant's day. And the 35B-A3B MoE models now benchmark in Sonnet 4.5 territory.

## The benchmarks

Measured on release builds, real completions, real contexts:

| GPU | Model | Tok/s | Context | Memory |
|-----|-------|-------|---------|--------|
| RTX 4070 Ti 12GB | Nemotron 3 Nano 4B Q4_K_M | TBD | 262K | ~5GB |
| RTX 4070 Ti 12GB | Qwen3.5-9B Q4_K_M | ~65 | 131K | 7.8GB |
| RTX 3060 12GB | Qwen3.5-9B Q4_K_M | ~43 | 128K | ~7.8GB |
| RTX 3090 24GB | Qwen3.5-27B Q4_K_M | ~30 | 262K | ~18GB |
| M3 Pro 36GB | **Qwen3.6-35B-A3B Q4_K_M** | **TBD (≈3.5)** | 262K | **~22GB** |
| M3 Pro 36GB | Qwen3.5-35B-A3B Q4_K_M | ~29 | 131K | ~22GB |
| M3 Pro 36GB | Qwen3.5-9B Q4_K_M | ~20 | 131K | ~7GB |
| M3 Pro 36GB | Qwen3.5-27B Q4_K_M | ~9\* | 131K | ~18GB |
| M3 Pro 36GB | **Gemma 4 26B-A4B Q4_K_M (Ollama MLX)** | **~31** | 256K | **~17GB** |
| M3 Pro 36GB | Gemma 4 31B Q4_K_M (Ollama MLX + MTP) | ~2× baseline | 256K | ~18GB |

\*The dense 27B is slower than the 35B-A3B MoE on 36 GB machines — see "Why MoE?" in the repo for the full story.

## What's new since launch

The guide has been updated continuously since March. The big additions:

- **Qwen 3.6 35B-A3B** (April 2026) is now the recommended model for Apple Silicon with 32 GB+. Same MoE shape as the 3.5 — 35B total, 3B active per token, ~22 GB at Q4_K_M — but a drop-in upgrade with materially better coding scores: **73.4% SWE-bench Verified**, 51.5% Terminal-Bench 2.0, 37.0% MCPMark, and native 262K context extensible to ~1M with YaRN. That puts a local model on a 36 GB MacBook in Sonnet 4.5+ territory for coding.
- **Multi-token prediction (MTP)** — speculative decoding with an official drafter head, giving 1.5–3× throughput with bit-identical output. The easiest path is Ollama's pre-built `gemma4:31b-coding-mtp` models, which make the dense Gemma 4 31B viable on 36 GB. llama.cpp support is in beta.
- **A proper CUDA engine shootout.** llama.cpp is still the reliable default, but **ExLlamaV3 + TabbyAPI** hits ~100–130 tok/s on the same 9B model where llama.cpp does ~65, and **TensorRT-LLM** sits between them with the best batched/long-context story. The guide covers setup for all three.
- **Ollama (MLX) is now the recommendation on macOS** — llama.cpp has an open bug where Gemma 4 emits only thinking tokens, and Ollama's MLX backend handles them correctly. **vLLM Metal** (the official vLLM Apple Silicon plugin, via Docker Model Runner) is covered as well.
- **TurboQuant tracking** — Google's 3-bit KV-cache compression is landing in llama.cpp piece by piece; the guide tracks which PRs have merged and what they'll unlock (262K context on 12 GB cards, higher-quality quants at the same VRAM budget).

## Why MoE wins on Apple Silicon

Apple's unified memory is generous but its memory *bandwidth* is not as high as a discrete NVIDIA card's. A dense 27B model saturates that bandwidth on every token. A mixture-of-experts model like Qwen3.6-35B-A3B only activates 3B parameters per token, which means each token reads a fraction of the weights — and the model runs faster *and* smarter than the dense option it replaces. The guide walks through the tradeoff properly.

## Test machines

- **Windows/WSL2:** RTX 4070 Ti (12 GB), Intel Core Ultra 9 285K, 48 GB DDR5
- **macOS:** M3 MacBook Pro, 36 GB unified memory

## Quick start

The guide walks through llama.cpp from source (with `-DGGML_CUDA=ON` or `-DGGML_METAL=ON`), the `llama-server` binary, and wiring the result into your editor: Claude Code as a local endpoint, Cline for full agent mode in VS Code, Continue for tab completion, and the LiteLLM workaround for Cursor. Ollama + MLX is covered as the one-command alternative for Apple Silicon, and a set of start scripts in the repo handle the local, remote-tunnel, and Cursor flows.

## Who it is for

Developers who want a serious coding assistant that runs on their own hardware, without a subscription, without a round-trip to a cloud inference endpoint, and without hand-tuning flags for six hours. Read it on [GitHub](https://github.com/isaacrowntree/local-llm-coding-guide).
