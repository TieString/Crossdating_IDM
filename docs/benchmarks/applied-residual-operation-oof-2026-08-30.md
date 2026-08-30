# Applied-residual operation OOF

This shadow experiment virtually applies the frozen operation head's top two
immutable identities. Local identities use the existing location package's
truth-blind Top1 year; whole-series and no-event identities have no local
location. The operation, shift, and local package are never rewritten.

## Frozen inputs

- External run: `frozen-external-e59203fc`
- Shortlist: 9,236 proposals from 4,618 attempts
- Operations: 4,863 partial, 1,802 false-ring, 1,346 missing-ring,
  692 whole-series, and 533 no-event proposals
- Residual evidence SHA-256:
  `200a6cc2098d69faa51f7be26fac8d9b1eacd4d5805b58a200d15a45066e990c`
- OOF summary SHA-256:
  `8d98009b4222ba6fa10c5d54e85de1f72ad0cf70e5ecd9c60c6afd09b8b64aeb`

## Result

| Metric | Frozen operation head | Residual shadow head | Change |
| --- | ---: | ---: | ---: |
| Workflow-equivalent correct | 3,917 / 4,118 | 3,926 / 4,118 | +9 |
| Workflow accuracy | 95.12% | 95.34% | +0.22 pp |
| Strict operation correct | 3,935 / 4,118 | 3,943 / 4,118 | +8 |
| Strict operation accuracy | 95.56% | 95.75% | +0.19 pp |
| A workflow | 97.00% | 97.40% | +0.40 pp |
| B workflow | 97.18% | 97.35% | +0.17 pp |
| C workflow | 97.26% | 97.68% | +0.42 pp |
| D workflow | 90.13% | 90.13% | unchanged |
| Response rate | 99.76% | 99.73% | -0.02 pp |
| Clean false positives | 0 / 500 | 0 / 500 | unchanged |

The shadow operation head repairs 18 suggestions and regresses 9. The net gain
demonstrates independent operation/shift signal in post-correction residuals,
but it remains analysis-only because the zero correct-to-wrong gate is not met.

## Decision

Retain the residual operation head as a shadow experiment. The next evidence
revision should distinguish boundary-local disturbance from unresolved newer
transitions and add reference-wise before/after stability. Production remains
on the frozen operation head.
