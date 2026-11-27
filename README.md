# png-squeeze-01

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/indra260/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/indra260/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG compressor written from scratch for the make.fun competition
[png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127).
It squeezes 1280×720 RGBA screenshots into the smallest equivalent PNG it can
find — every pixel's red, green, blue and alpha, including the colour under
fully transparent pixels, decodes exactly as it was.

## How it works

Each instance goes through five stages:

1. **Strict decode** — the stored PNG is read chunk by chunk (CRC-checked,
   unknown chunks rejected) and expanded to full RGBA, handling all five
   colour types and all three `tRNS` forms.
2. **Analysis and colour-type reduction** — one pass records whether the
   picture is opaque, grey, and how many distinct colours it holds (up to
   256). Flat pictures try palette forms in two entry orders (by frequency,
   by luminance, transparent entries first); flat grey pictures also try the
   plain grey form; rich pictures try grey/grey+alpha or RGB/RGBA, with a
   transparent-key `tRNS` form where one exists.
3. **Per-row filter choice** — fixed None plus adaptive minimum signed-sum
   and fewest-distinct-adjacent-pairs per row, and brute-force trial
   compression with zlib level 4 and a 32 KiB dictionary of preceding
   filtered bytes, run only on the best cheap-screened form (two-phase
   screening).
4. **Screening** — candidates are ranked by zlib level 6 size plus chunk
   overhead; the best few finalists are compressed for real and the
   smallest finished PNG wins. Trailing finalists (screened more than
   500 bytes behind the best) are skipped: their zlib-9 can never beat
   the winner's custom DEFLATE.
5. **Final compression** — zlib level 9, plus a hand-written optimal-parse
   DEFLATE encoder: two lazy-matching passes, then optimal-parse passes
   (seed chain 1024 when an all-candidates pass follows, else 4096),
   a plus-8 candidate set on the last pass of small streams, or an extra
   all-candidates optimal pass per stream size (chain 256/512/1024 by
   screened size and colour type, capped to one 1024 stream per run),
   a fifth parse pass for the largest stream, and greedy-merge plus
   entropy-ranked block splits whose block costs are computed exactly
   from prefix symbol frequencies. The smallest stream wins.

## Results on the practice set

| instance | theme | bytes | points |
|----------|-------|------:|-------:|
| i001 | flat  | 11,835 | 750.9 |
| i002 | rich  | 46,838 | 766.2 |
| i003 | alpha | 96,661 | 736.1 |
| i004 | grey  | 97,902 | 742.8 |
| i005 | flat  | 15,843 | 767.6 |
| i006 | rich  | 164,903 | 740.0 |
| i007 | alpha | 58,522 | 726.4 |
| i008 | grey  | 23,493 | 749.1 |

**Total: 747,387 / 1,000,000** (house baseline fixed-paeth: 420,399;
live top-50 cutoff 746.5).
All eight instances exact, byte-identical across two runs, total runtime
~56 s of the 60 s budget.

## Running it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22 standard library only — no dependencies, no network, no clock.
The program reads `MAKEFUN_INPUT_DIR` (default `/input`) and writes one
`image.png` per instance under `MAKEFUN_OUTPUT_DIR` (default `/output`).
Work is a fixed amount per instance, never cut off by the clock, so two runs
on the same set produce byte-identical output.

## Layout

- `main.ts` — the whole compressor (decode, analysis, filters, DEFLATE).
- `LICENSE` — MIT.

## About

Built for make.fun by [@naakent](https://make.fun) /
[indra260](https://github.com/indra260) as an entry for the
[png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty: squeeze screenshots into the smallest PNG, losslessly.
