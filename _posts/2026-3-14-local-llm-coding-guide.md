---
layout: post
title: "local-llm-coding-guide — Qwen, Gemma, and llama.cpp as a coding assistant"
description: "A benchmarks-first guide to running Qwen3.5 and Gemma 4 locally as a coding assistant — on a 4070 Ti, a 3090, and an M3 Pro MacBook — with real tok/s numbers."
excerpt: "A benchmarks-first guide to running local LLMs as a coding assistant — Qwen3.5 and Gemma 4 on an RTX 4070 Ti, a 3090, and an M3 Pro MacBook with real tok/s and memory numbers."
image: /images/blog/local-llm-coding-guide.jpg
image_alt: Abstract neural network illustration representing large language models
date: 2026-03-14
last_modified_at: 2026-03-14
categories: [ai, guides]
tags: [llm, llama-cpp, ollama, qwen, gemma, local-ai, coding-assistant, guides]
---

Zack Design has published [`local-llm-coding-guide`](https://github.com/isaacrowntree/local-llm-coding-guide) — a no-fluff, benchmark-driven guide to running a genuinely useful local LLM as a coding assistant on consumer hardware. It covers Qwen3.5 and Gemma 4 across llama.cpp, Ollama (with MLX), and vllm-mlx, with real tokens-per-second numbers from three real machines.

<!-- more -->

## Why local

Cloud LLMs are wonderful until you are on a flight, behind a client VPN, editing code with sensitive data, or burning through a monthly token budget faster than is reasonable. The quality gap between the best frontier models and the best *local-runnable* models has narrowed dramatically — a quantised 9B Qwen model on a modest NVIDIA card is now perfectly capable of the "reformat this function, add a docstring, write a test" type of work that makes up most of a coding assistant's day.

## The benchmarks

Measured on release builds, real completions, real contexts:

| GPU | Model | Tok/s | Context | Memory |
|-----|-------|-------|---------|--------|
| RTX 4070 Ti 12GB | Nemotron 3 Nano 4B Q4_K_M | TBD | 262K | ~5GB |
| RTX 4070 Ti 12GB | Qwen3.5-9B Q4_K_M | ~65 | 131K | 7.8GB |
| RTX 3060 12GB | Qwen3.5-9B Q4_K_M | ~43 | 128K | ~7.8GB |
| RTX 3090 24GB | Qwen3.5-27B Q4_K_M | ~30 | 262K | ~18GB |
| M3 Pro 36GB | **Qwen3.5-35B-A3B Q4_K_M** | **~29** | 131K | **~22GB** |
| M3 Pro 36GB | Qwen3.5-9B Q4_K_M | ~20 | 131K | ~7GB |
| M3 Pro 36GB | Qwen3.5-27B Q4_K_M | ~9\* | 131K | ~18GB |
| M3 Pro 36GB | **Gemma 4 26B-A4B Q4_K_M (Ollama MLX)** | **~31** | 256K | **~17GB** |

\*The dense 27B is slower than the 35B-A3B MoE on 36 GB machines — see "Why MoE?" in the repo for the full story.

## Why MoE wins on Apple Silicon

Apple's unified memory is generous but its memory *bandwidth* is not as high as a discrete NVIDIA card's. A dense 27B model saturates that bandwidth on every token. A mixture-of-experts model like Qwen3.5-35B-A3B only activates 3B parameters per token, which means each token reads a fraction of the weights — and the model runs faster *and* smarter than the dense option it replaces. The guide walks through the tradeoff properly.

## Test machines

- **Windows/WSL2:** RTX 4070 Ti (12 GB), Intel Core Ultra 9 285K, 48 GB DDR5
- **macOS:** M3 MacBook Pro, 36 GB unified memory

## Quick start

The guide walks through llama.cpp from source (with `-DGGML_CUDA=ON` or `-DGGML_METAL=ON`), the `llama-server` binary, wiring it into VS Code via the Continue extension, and wiring it into Claude Code as a local endpoint. Ollama + MLX is covered as the one-command alternative for Apple Silicon.

## Who it is for

Developers who want a serious coding assistant that runs on their own hardware, without a subscription, without a round-trip to a cloud inference endpoint, and without hand-tuning flags for six hours. Read it on [GitHub](https://github.com/isaacrowntree/local-llm-coding-guide).
