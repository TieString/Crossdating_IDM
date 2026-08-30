# Applied-residual location OOF

This shadow experiment scores what remains after virtually applying each
truth-blind shortlisted local-event proposal. Candidate operation, shift,
window, and width remain immutable. The pairwise location head is trained and
evaluated with complete RWL files isolated by `GroupKFold`.

## Frozen inputs

- External run: `frozen-external-e59203fc`
- Location score SHA-256:
  `ea614c1470f1c6a07f45657bd05e0d2af8008a830210370611abcb0c3f5eab04`
- Shortlist: top 2 listwise union top 2 pairwise candidates per attempt
- Shortlist size: 10,333 proposals from 3,674 attempts
- Residual evidence SHA-256:
  `068bbdc0e49364a759244f83c50975791cef389ee02997d90edec6ba5753014c`

## Result

| Metric | Frozen location head | Residual shadow head | Change |
| --- | ---: | ---: | ---: |
| Correct suggestions | 3,669 / 4,118 | 3,688 / 4,118 | +19 |
| Workflow accuracy | 89.10% | 89.56% | +0.46 pp |
| A | 93.60% | 93.80% | +0.20 pp |
| B | 92.29% | 92.37% | +0.08 pp |
| C | 87.89% | 88.47% | +0.58 pp |
| D | 85.24% | 86.07% | +0.83 pp |
| Response rate | 99.76% | 99.76% | unchanged |
| Clean false positives | 0 / 500 | 0 / 500 | unchanged |

The shadow head repairs 45 suggestions and regresses 26, for a net gain of 19.
Failure analysis changes window errors from 201 to 180 and frontier errors from
64 to 66; operation/shift errors (118), refusals (8), and candidate-Oracle misses
(58) are unchanged.

## Decision

Post-correction newer-side residual evidence has independent location signal,
especially for C and D. It remains shadow-only because the 26 regressions violate
the zero correct-to-wrong production gate. The next experiment should add
fixed-side segment residuals and operation-specific residual evidence rather
than alter adjudication weights or expand candidate windows.
