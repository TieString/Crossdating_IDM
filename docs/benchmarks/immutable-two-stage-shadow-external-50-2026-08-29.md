# Immutable Two-Stage Shadow: Frozen External 50-File Audit

## Scope

This audit evaluates the immutable two-stage adjudicator introduced in
`4b1f4669`, using the frozen model and the previously frozen 50-file external
set. Candidate generation, window widths, and evidence extraction were not
changed. Target scoring performed no fitting and no truth-aware runtime switch.

The adjudicator contract is:

1. an operation/shift head selects `operationType + shiftYears`;
2. a same-identity location head selects one existing 5/7/9/13-year package;
3. a safety projection may retain the complete baseline package when the
   challenger does not exceed its file-OOF calibrated margin.

## Frozen Inputs

- Model SHA-256: `ea2d1277eaec9c6c79410ef4f9f997b62178236c4fa9154dd82d60e1ead62bec`
- Operation table SHA-256: `8999f8d448a44be3f710504070463a8f1abdadc124bddec51db756d2dbcf9648`
- Candidate package SHA-256: `ffd4f320eeedff0690a798b1e134e32c1fa0f1cfc59e063cf6c1bb0504e9d83a`
- Frozen proposal SHA-256: `398408d9065eb77220057208af35dd394ed6d3167801705f005d9973ee6026cf`
- Target training calls: `0`
- Truth-aware runtime switches: `0`

## Development OOF

The 17-file development OOF result was 950/967 (98.24%), with a file-clustered
one-sided 95% lower bound of 97.43%. It retained 943/943 previously correct
packages, corrected seven failures, produced no Clean false positive, and left
the base candidate Oracle unchanged at 966/967 (99.90%).

## Frozen External Result

| Group | Correct / events | Workflow accuracy | Operation accuracy | Response | One-sided 95% lower |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 455 / 500 | 91.00% | 93.80% | 99.80% | 88.60% |
| B | 1,091 / 1,206 | 90.46% | 94.28% | 99.75% | 88.57% |
| C | 1,069 / 1,206 | 88.64% | 95.19% | 99.75% | 86.47% |
| D | 961 / 1,206 | 79.68% | 83.17% | 99.34% | 76.49% |
| Overall | 3,576 / 4,118 | 86.84% | 91.23% | 99.64% | 84.96% |

Clean false positives were 0/500. The candidate Oracle remained 4,057/4,118
(98.52%). Relative to the frozen production package, the shadow corrected 15
events and regressed three, for a net gain of 12 events. It therefore fails the
required 95% accuracy and zero-regression gates and must remain shadow-only.

## Correlation Stratification

| File intercorrelation | Correct / events | Workflow accuracy | Candidate Oracle | Ranking losses | One-sided 95% lower |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.50-0.60 | 123 / 143 | 86.01% | 97.20% | 16 | 83.56% |
| 0.60-0.70 | 921 / 1,123 | 82.01% | 98.22% | 183 | 79.40% |
| 0.70-0.80 | 1,668 / 1,922 | 86.78% | 98.65% | 228 | 83.65% |
| >=0.80 | 864 / 930 | 92.90% | 98.82% | 56 | 91.37% |

| Target/master correlation | Correct / events | Workflow accuracy | Candidate Oracle | Ranking losses | One-sided 95% lower |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.60-0.70 | 1,130 / 1,394 | 81.06% | 97.99% | 236 | 78.44% |
| 0.70-0.80 | 1,464 / 1,663 | 88.03% | 98.62% | 177 | 85.74% |
| >=0.80 | 982 / 1,061 | 92.55% | 99.06% | 70 | 89.78% |

The high Oracle in every correlation band confirms that the dominant loss is
adjudication, not missing candidate evidence. The 17-file OOF score materially
overestimates generalization to lower-correlation and mixed-event files.

## Head Audit

The listwise operation head reaches 3,772/4,118 (91.60%) before safety
projection. Its family accuracy is A 93.40%, B 94.69%, C 96.35%, and D 83.00%.
The pairwise operation head is weaker overall at 90.87% and does not repair the
D-family shift.

For frozen compact location proposals, the listwise head reaches 3,129/3,539
(88.41%) and the pairwise head reaches 3,132/3,539 (88.50%). D remains weakest
at 83.60-83.83%.

This audit exposed an implementation defect in the current safety projection:
although a dense same-identity location head is trained, the compact proposal
is always preferred whenever it exists. As a result, much of the dense location
head cannot influence the final package on the external set. Correcting that
contract mismatch does not require a new candidate, a wider window, or a new
location rule.

## Remaining Failures

| Failure class | Events |
| --- | ---: |
| Operation or exact shift | 291 |
| Same-identity window ranking | 143 |
| Candidate Oracle miss | 59 |
| Frozen frontier selection | 36 |
| Refusal | 13 |

The largest wrong-operation confusions are `partialMove -> wholeSeriesMove`
(58), `falseRing -> partialMove` (50), `wholeSeriesMove -> partialMove` (34),
and `partialMove -> falseRing` (31). D contributes 147 of the 291
operation/shift failures.

The external run improves the former ranking-loss count from 495 to 483, and
operation/shift failures from 305 to 291, but window failures rise from 139 to
143. This is a real but insufficient gain.

## Decision

Do not replace the production adjudicator with this model. Preserve the result
as a negative external validation. The next admissible work is limited to the
two adjudication heads and their immutable projection contract: jointly rank
the already frozen dense and compact packages inside the selected identity,
expand file-isolated training coverage, and validate the resulting frozen model
on a new untouched file split. Candidate generation and window calibration stay
frozen.

