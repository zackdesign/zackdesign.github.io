---
layout: post
title: "local-llm-coding-guide — Qwen, Gemma, and llama.cpp as a coding assistant"
description: "A guide to running Qwen and Gemma locally as a coding assistant, built around a benchmark script and a Claude Code harness — because the tok/s number I had published for the 12 GB pick was 113 at empty context and 27 at 16K, and both were true."
excerpt: "A guide to running Qwen and Gemma locally as a coding assistant, built around a benchmark script and a Claude Code harness — because the tok/s number I had published for the 12 GB pick was 113 at empty context and 27 at 16K, and both were true."
image: /images/blog/local-llm-coding-guide.jpg
image_alt: Abstract neural network illustration representing large language models
date: 2026-03-14
last_modified_at: 2026-11-16
categories: [ai, guides]
tags: [llm, llama-cpp, ollama, mlx, qwen, gemma, local-ai, coding-assistant, guides]
---

Zack Design's **[local-llm-coding-guide](https://github.com/isaacrowntree/local-llm-coding-guide)** is a guide to running the open-weight Qwen and Gemma models as a coding assistant on your own hardware: an RTX 4070 Ti graphics card with 12 GB of memory, and an M3 Pro MacBook with 36 GB. It is built around a **benchmark script** and a **Claude Code harness**, because the speed it once published for the 12 GB pick was 113 tokens per second at an empty conversation and 27 with 16,000 tokens loaded, and both were true. So it now gives **rules rather than model names**, with every number regenerated on your own machine.

<div class="hero-cta-row" style="margin: 1.5rem 0;">
  <a href="https://github.com/isaacrowntree/local-llm-coding-guide" target="_blank" rel="noopener" class="btn btn-primary btn-lg">Source on GitHub</a>
</div>

This post covers:

- why run a model locally at all;
- the three rules, and the measured tables from both machines;
- why a mixture-of-experts model (one that uses only a fraction of its weights for each token) is faster on a Mac;
- the Claude Code harness that scores a model on whether it finishes a task rather than how fast it types: the incumbent mixture-of-experts model passed four tasks out of four, and both August releases that beat it on published benchmarks passed none;
- the `--bare` flag that cuts what Claude Code sends with every request from 20,240 tokens to 663, and the reasoning setting that never reaches a local model;
- what changed since March, and how to run the benchmarks yourself.

<!-- more -->

An earlier version of the guide listed Qwen3.6-35B-A3B at "about 30 to 38 tokens per second" on the 4070 Ti (a token is roughly three-quarters of a word). The repo's own `benchmark.sh` measured 113 on an empty conversation and about 27 at 16,000 tokens. The guide had published one without saying which. It covers five engines: llama.cpp, Ollama's MLX backend (MLX is Apple's machine-learning framework), mlx-lm, ExLlamaV3 and TensorRT-LLM.

## Why run a model locally at all

Sometimes a cloud model isn't available: on a flight, behind a client VPN, on code you can't send anywhere, or past a monthly token budget. A 9-billion-parameter model, with its weights compressed to 4 bits, fits a 12 GB card and handles "reformat this, add a docstring, write a test".

The bigger option is a **mixture-of-experts** model. It stores many sets of weights but uses only a few for each token: Qwen3.6-35B-A3B has 35 billion in total and uses 3 billion at a time. Its published scores sit in Sonnet 4.5 territory: 73.4% on SWE-bench Verified and 37.0% on MCPMark. It holds 262,000 tokens of context natively. Those scores are for the full-precision model; the 12 GB card runs a 2-bit version, and the guide says so.

## Three rules instead of a model name

Model names go stale in weeks. So the guide's advice is three rules, and a dated "Current picks" block names what satisfies them today.

1. **Budget.** On NVIDIA, it's the graphics card's memory. On Apple Silicon, it's the unified memory minus about 8 GB for the operating system.
2. **Goal.**
   - For quality: the mixture-of-experts model with the most total parameters that fits at 2-bit compression or better, with a usable amount of context.
   - For speed: a mixture-of-experts model with few active parameters, at 4-bit.
   - For long context: the model whose conversation memory (the KV cache) fits beside the weights at your context length, with that cache compressed to 4 bits. Writing speed is limited by memory bandwidth, so smaller weights buy you more context.
3. **Engine.** It follows from the platform:

| Platform | Default | Fastest for one user | Serving many users |
|---|---|---|---|
| NVIDIA | llama.cpp | ExLlamaV3 with TabbyAPI | TensorRT-LLM |
| Apple | Ollama (MLX) | mlx-lm | vllm-mlx, which speaks the Anthropic API natively |

Then run `./benchmark.sh`, and don't trust the tables below.

## What the two machines measured

**RTX 4070 Ti, 12 GB.** llama.cpp build `0893f50f2`, with flags `-ngl 99 -fa 1 -ctk q4_0 -ctv q4_0`. That means every layer on the GPU, flash attention on, and the conversation cache compressed to 4 bits. The figures are medians over 7 runs, because WSL2 (Linux inside Windows) varies a lot as the Windows desktop grabs the GPU. "Prefill" is how fast the model reads the prompt; "decode" is how fast it writes the answer.

| Model (GGUF file) | Prefill, tokens per second | Decode, empty conversation | Decode at 16,000 tokens | Peak GPU memory |
|---|---:|---:|---:|---:|
| Qwen3.6-35B-A3B UD-IQ2_M | 3,392 | 113 | about 27 | 11.9 GB |
| Gemma 4 E4B Q4_K_M | 7,049 | 93 | about 78 | 4.2 GB |
| DeepSeek-R1-Qwen3-8B Q4_K_M | 5,246 | 76 | — | 5.6 GB |
| Qwen3.5-9B Q4_K_M | 4,531 | 67 | — | 6.2 GB |
| Qwen3-14B Q4_K_M | 2,910 | 53 | — | 9.4 GB |
| Devstral-Small-2 24B IQ2_M | 1,646 | 46 | — | 8.6 GB |

A peak of 11.9 GB means the 35B-A3B fits a 12 GB card with almost nothing to spare. It loads and answers one tiny prompt. Then it runs out of memory on Claude Code's system prompt, or during a CUDA graph capture, and `llama_memory_breakdown` shows `free = 0`.

The fix is `--n-cpu-moe`. It keeps some of the experts in ordinary system memory instead of on the card:

| Experts kept on the CPU (`-ncmoe`) | GPU memory at 128,000 tokens of context | Decode, tokens per second |
|---|---:|---:|
| 16 | about 8.8 GB | about 40 |
| 8 | about 10.6 GB | about 77 |

Fewer experts on the CPU is faster but uses more GPU memory. The trade is cheap for a mixture-of-experts model, because only about 3 billion parameters are active per token.

Context length turned out to cost speed, not just memory. With `-ncmoe 8`, the card wrote about 100 tokens per second at 40,000 or 64,000 tokens of context. At 96,000 it dropped to 48. So the native Windows scripts now default to 64K.

**M3 Pro, 36 GB**, measured 24 July 2026:

| Model | Tokens per second | Memory |
|---|---:|---:|
| Qwen3.6-35B-A3B Q4_K_M (Ollama MLX) | about 35 | about 22 GB |
| Qwen3.6-35B-A3B 4bit (mlx-lm) | about 48 | about 20 GB |
| Gemma 4 26B-A4B Q4_K_M (Ollama MLX) | about 33 | about 17 GB |
| Qwen3.5-9B Q4_K_M | about 20 | about 7 GB |
| Qwen3.5-27B Q4_K_M (dense) | about 9 | about 18 GB |
| Gemma 4 31B Q4_K_M (dense, Ollama MLX) | about 6 | about 18 GB |

Raw mlx-lm writes about 30% faster than Ollama's MLX backend on the same weights. Ollama spends that on its compressed conversation cache and serving convenience, and it reads prompts much faster.

On unified memory, running out of room doesn't crash; it swaps. The dense 31B, at about 18 GB of weights, thrashes the swap file on a 36 GB machine. The 5-bit build of the 35B-A3B (26.5 GB) loaded only by pushing out the file cache and background apps. So the Mac's ceiling for a model running alone is the 4-bit build, at 22.1 GB.

## Why a mixture-of-experts model is faster on a Mac

![Left: a dense 27-billion-parameter model drawn as 27 blocks, all lit, because every one is read from memory for every token. Right: a 35-billion-parameter mixture-of-experts model drawn as 35 blocks with only 3 lit, because only 3 billion parameters are read per token, though all 35 must be stored.](/images/blog/llm-moe-vs-dense.svg)

A dense 27B model reads all 27 billion weights from memory for every token. That saturates the Mac's memory bandwidth.

Qwen3.5-35B-A3B reads 3 billion active parameters per token from a pool of 35 billion. So it is faster than the 9B dense model, at 29 against 20 tokens per second, and smarter than the 27B. The cost is disk and memory: 22 GB at 4-bit, against 16 GB for the dense 27B, because every expert is stored even though only a few run.

## Speed is not the number that matters; finishing the task is

`bench-claude-code.sh` drives Claude Code itself against a local model, through Ollama's built-in Anthropic-compatible endpoint. It scores four tasks. Each one passes or fails by an external check the model never sees:

- **Fix a bug.** The tests are checksummed, so "fix the test instead" fails.
- **Rename across several files**, with the tests still passing.
- **Add a `--json` flag** while keeping the existing output byte-identical.
- **Find a value** hidden in a 30-file codebase.

M3 Pro with 36 GB, 25 August 2026:

```
Model                              01-fix-bug      02-refactor     03-add-feature  04-codebase     Pass  Eff tok/s
gemma4:26b-a4b-it-q4_K_M           PASS 89s        PASS 118s       PASS 195s       PASS 96s         4/4       13.0
muse-glimmer:30b-q4_K_M-dflash     FAIL 232s       FAIL 247s       FAIL 316s       (abandoned)      0/3        1.5
qwen3.8:27b-mtp-q4_K_M             TIMEOUT 905s    (not run)       (not run)       (not run)        0/1          -
```

The incumbent won, and it wasn't close. Qwen 3.8 27B is dense. `llama-server`'s own timing logs show it lost on both counts:

| | Qwen 3.8 27B (dense) | Gemma 4 26B-A4B (mixture of experts) |
|---|---:|---:|
| Reading the prompt, tokens per second | about 82 | about 720 to 830 |
| Time to read Claude Code's 21,000-token opening prompt | about 262 s | not measured separately |
| Writing the answer, tokens per second | about 5 | about 25 |
| First task | timed out at 900 s | finished in 89 s and 6 turns |

Its 4-bit build with multi-token prediction fits in 18 GB, so memory wasn't the problem. Multi-token prediction speeds up writing. This workload is limited first by reading the prompt, and second by a five-times gap in writing speed.

Muse Glimmer didn't fail slowly; it failed inertly. It took one or two turns and made no tool calls. To the fix-the-tests prompt it replied "Hi! How can I help you today?". That looks like a problem with Ollama's chat template for that model, not a verdict on the model.

I first blamed prompt caching, and the server logs disproved it. Turn one logged `created context checkpoint 1 of 32 (n_tokens = 21316, 233 MiB)`. Turn two logged `cached n_tokens = 21824`. The 262 seconds is paid once per session.

The same harness later ran on the 4070 Ti, against llama-server directly. Qwen3.6-35B-A3B at 2-bit passed all four tasks, in about four minutes in total.

## Two things Claude Code implies that are not true with a local model

**The context is mostly tools.** `claude --bare` cuts the input for a trivial prompt from 20,240 tokens to 663. Capturing the HTTP request shows why. It carries a 6,646-character system prompt and 28 tool definitions. Every MCP server you install (a plugin that gives Claude Code more tools) adds more.

Asked to check email, a 26B model instead announced "Security Audit of Codebase", called a mobile-automation tool, and finally recited its own tool list. That is what a small model does when the menu outweighs the request. `--bare` keeps the file and shell tools: it created a file correctly in 3 turns, at 2,218 input tokens. Skills still resolve by name. `--disallowedTools` and `--mcp-config` are the finer controls.

Every harness result above ran with the full 21,000-token opening. A `--bare` run would cut Qwen 3.8's cold start to about 27 seconds, so the verdict on dense models is provisional until it is re-run that way.

**Reasoning effort doesn't arrive.** Claude Code shows "medium effort" and sends `"thinking": {"type": "adaptive"}` on every request. Ollama reports Gemma 4 26B-A4B as able to reason before answering. Yet it returned `thinking_tokens: 0` in all seven runs, including a 17-turn refactor. Ollama's Anthropic-compatibility layer doesn't map that field onto its own think mode. Turn reasoning on at the Ollama layer instead.

Two more integration facts:

- **Claude Code speaks only the Anthropic API.** Ollama and vllm-mlx speak it directly. Since January 2026, so does llama-server, at `/v1/messages`, as long as it runs with `--jinja` for tool calls. TabbyAPI and TensorRT-LLM still need a LiteLLM proxy in between to translate.
- **Disable the web tools.** Claude Code offers `WebSearch` and `WebFetch` as server-side tools whose type is not `function`. llama-server rejects them with a 400 error until you turn them off with `--disallowedTools`.

## What changed since March

The repo started as a llama.cpp walkthrough. Since then it has added:

- **Qwen 3.6** in April, the first Sonnet-class model to fit 12 GB, through 2-bit compression.
- **Gemma 4 through Ollama MLX**, after llama.cpp bug #21321 left it writing only `<unused25>` thinking tokens. That bug has since been fixed upstream.
- **vLLM on Metal**, through Docker Model Runner.
- **The benchmark runs** on the RTX 4070 Ti and the M3 Pro, and the Claude Code harness.
- **A native Windows path** with PowerShell scripts: llama-server straight into Claude Code, with no WSL and no proxy.
- **Remote access restricted to the local network**, with per-user API keys, instead of a public tunnel.
- **A distributed setup** that splits one model across both machines over llama.cpp's RPC backend, for a model larger than either. A 6-bit build split across both leaves the Mac more free memory than a 5-bit build alone.

TurboQuant, a 3-bit compression for the conversation cache, is tracked. The Hadamard rotation step it needs has been merged upstream, and the 3-bit types work on CUDA through forks. Compressing keys and values equally hurts Qwen, so the guide suggests keeping the keys at 8 bits. One fork measured its 4-bit cache at a 0.23% increase in perplexity over an 8-bit baseline. Perplexity is the standard measure of how well a model predicts text; lower is better.

## Running the benchmarks yourself

`benchmark.sh` runs `llama-bench` over the GGUF files you have, with the same flags the guide recommends. It writes a dated table to `benchmarks/RESULTS-<host>.md`.

```bash
git clone https://github.com/isaacrowntree/local-llm-coding-guide && cd local-llm-coding-guide
./benchmark.sh                                  # every *.gguf in ~/models (MODELS_DIR to override)
DEPTH=16384 ./benchmark.sh ~/models/<model>.gguf   # decode speed with 16K tokens loaded

./bench-claude-code.sh --list                   # candidate models and tasks, no downloads
./bench-claude-code.sh --models "gemma4:26b-a4b-it-q4_K_M" --tasks "01 04"
```

The harness expects Ollama on a Mac by default; `--base-url` points it at any other Anthropic-compatible server. On Windows, `windows\claude-local.ps1` starts llama-server if needed and opens Claude Code against it.

## What was learned

A tokens-per-second figure without its context depth is half a number. A benchmark table copied from someone else's graphics card is not a measurement.

Prompt-reading speed decides whether an agent loop is usable at all. Writing speed decides whether it is pleasant. On the same machine, a mixture-of-experts model with 4 billion active parameters beat a 27B dense model by about ten times on the first and five times on the second. And a local model's worst enemy is the tool list the client sends it.

Everything here regenerates from `benchmark.sh` and `bench-claude-code.sh`. Per-run JSON, error output and verifier output land in `bench/results/`. Read it on [GitHub](https://github.com/isaacrowntree/local-llm-coding-guide).
