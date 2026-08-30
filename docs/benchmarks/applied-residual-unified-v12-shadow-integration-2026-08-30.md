# Applied-residual unified v12 shadow integration

## Decision

Further evidence tuning stopped after v12. The operation residual v6 head and
the compact per-reference location residual v12 head are frozen as one
deployable Python shadow pack. The pack is checked in at
`models/shadow/applied-residual-unified-v12` and is scored through a pure
inference entry point that never fits a model.

The existing TypeScript adjudicator remains the production decision. v12 is
connected as an auditable model artifact and offline shadow runner because its
strict file-OOF result still contains correct-to-wrong regressions.

## Architecture

```text
immutable Top4 operation packages
  + base selection/meta/pair scores
  + post-correction residual evidence
    -> operation/shift pairwise head
    -> one immutable operation identity
    -> same-identity location candidates only
  + base listwise/pairwise/anchor scores
  + compact per-reference post-correction evidence
    -> location pairwise head
    -> one operation/shift/window package
```

The location head cannot cross the selected operation identity. Missing/false
ring/partial suggestions must have one 5/7/9/13-year window; a local operation
without a same-identity location is refused. Positive automatic partial and
whole shifts are absent from the frozen candidate protocol.

## Frozen OOF result

The result below is the strict full-RWL file-OOF evaluation used to choose v12.
It is not recomputed from the final all-file deployment fit.

| Class | Correct | Accuracy | File-cluster one-sided 95% lower |
| --- | ---: | ---: | ---: |
| A | 477/500 | 95.40% | 93.80% |
| B | 1125/1206 | 93.28% | 91.52% |
| C | 1067/1206 | 88.47% | 86.37% |
| D | 1047/1206 | 86.82% | 84.43% |
| Overall | 3716/4118 | 90.24% | 88.75% |

Response rate was 99.76% and Clean false positives were 1/500. Relative to the
previous frozen location result, v12 repaired 182 suggestions and regressed 43.
Remaining failures were 57 candidate-Oracle misses, 110 operation/frontier
errors, 10 refusals, and 225 window errors.

## Runtime artifact

- Model version: `applied-residual-unified-v12`
- Model SHA-256:
  `59407d3a26a11baf3212385272029d301c839e89e5416e03015c98aa8abe0fe7`
- Model size: 916,807 bytes
- Operation features: 1,312
- Location features: 2,808
- Operation shortlist: 4 immutable identities
- Location shortlist: 16 candidates within the selected identity

The final model file is fit on all available external-50 training rows after
the OOF protocol was frozen. Those files therefore remain the source of the
reported OOF estimate but are no longer a future holdout for this deployment
artifact.

## Replay verification

Two separate inference-only runs produced byte-identical `shadow-top.csv`
files:

- Output SHA-256:
  `3641b22b730c81efb191ab12f7bd00e21f54b8fba0a57d7cdfee19c2ca34267a`
- Attempts: 4,618 including Clean
- Selected responses: 4,049
- Runtime training calls: 0
- Truth-aware runtime switches: 0
- Selected local events without a window: 0
- Invalid window widths: 0
- Positive automatic partial/whole suggestions: 0

The model head is small; the current offline residual evidence table is the
expensive part. This integration therefore remains an experiment/shadow runner
until the same evidence contract is available from a bounded live TypeScript
cache and a fresh independent file holdout clears the production gates.
