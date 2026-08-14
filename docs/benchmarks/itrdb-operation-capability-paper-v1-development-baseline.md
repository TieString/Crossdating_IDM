# ITRDB A/B/C/D development baseline

Frozen protocol commit: `0a3ae4c8`

Run directory:
`D:/软件测试/itrdb-operation-capability/results/paper-v4-development-baseline-0a3ae4c8-2026-08-15`

This run evaluated 640 cases and 1,221 injected truth events across all 128 eligible target series
from nine development RWL files. Each case reloaded its clean source, modified one target series,
and reran COFECHA and the production diagnosis path. There were no execution errors or source hash
changes. Runtime was 1,178.6 seconds with 16 workers.

## Results

| Family | Cases | Strict prompted local window | Workflow-equivalent window | Response | Serial recovery | Complete cases | Top1 among recovered local events |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 128 | 86/96 (89.58%) | 86/96 (89.58%) | 98.44% | 90.63% | 90.63% | 27.91% |
| B | 128 | 204/274 (74.45%) | 206/274 (75.18%) | 99.27% | 54.35% | 46.88% | 34.95% |
| C | 128 | 101/228 (44.30%) | 148/228 (64.91%) | 96.05% | 38.44% | 37.50% | 32.43% |
| D | 128 | 200/227 (88.11%) | 200/227 (88.11%) | 99.32% | 79.03% | 71.88% | 36.50% |

Clean controls produced 2/128 review false positives (1.56%). All accepted local windows used an
allowed width; median and P90 width were both 13 years.

The file-clustered macro strict-window estimates were 84.84% (A), 69.90% (B), 47.94% (C), and
86.48% (D). Their one-sided 95% lower bounds were 75.58%, 62.28%, 40.07%, and 81.77%, respectively.
These development results do not satisfy the inferential 90% criterion.

## Failure structure

Across all families, terminal case outcomes included 55 out-of-order frontiers, 46 window misses,
80 wrong operations, and 15 refusals. The dominant common mechanisms were:

- B repeatedly selected a real but older member of a distant same-operation chain. The stable
  complete lag path knew the newest transition, but its location-priority fallback could replace it
  with an older, more concentrated transition.
- C missing chains were often compressed into `partialMove -N`. This explains most of the gap
  between strict and workflow-equivalent coverage. Positive false-ring chains were frequently
  reversed to `missingRing`, so they do not have an equivalent partial interpretation.
- A failures were sparse but included five large missing-ring location jumps, two unsupported
  `partialMove` aliases for whole-series movement, two refusals, and three direction errors.
- D was near the observed threshold. Most remaining losses were operation competition and local
  window displacement rather than refusal.

The first development change should therefore make a stable complete same-operation path expose
its newest transition unconditionally. This is a shared frontier rule, not a file or year exception.
