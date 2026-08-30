# Immutable location anchor evidence v1 (2026-08-30)

## Scope

This shadow experiment keeps the external 50-file split, selected operation
identity, candidate windows, model parameters, and production selector frozen.
It repairs evidence projection loss by taking the union of:

- the Top6 candidates from each of four frozen location views; and
- candidate years previously evaluated by a strictly file-OOF physical
  residual location head.

The previous OOF score is exposed as one diagnosis-relative rank/z/margin
evidence channel. It is never used to decide whether its own prediction was
correct. File ID, series ID, scenario family, calendar year, and truth fields do
not enter the model. Existing rich candidate rows are retained on duplicate
years so per-reference and boundary evidence is not discarded.

Artifacts:

- shortlist: `external50-selected-identity-location-anchored-union-v4-oof`;
- residual evidence: `external50-selected-identity-location-anchored-union-v2-residual`;
- OOF result: `external50-location-residual-oof-v8-anchor-oof`.

## Result

| Model | Correct | Accuracy | File-cluster one-sided 95% lower | Window failures |
|---|---:|---:|---:|---:|
| Frozen broad pairwise location head | 3694/4118 | 89.70% | 88.20% | 247 |
| Anchor-union without OOF evidence | 3693/4118 | 89.68% | 88.13% | 248 |
| Anchor-union with frozen OOF evidence | **3708/4118** | **90.04%** | **88.62%** | **233** |

The added evidence repairs 14 net windows relative to the previous broad
location best. Candidate generation remains unchanged in width and operation
semantics: the selected identity still emits one 5/7/9/13-year window.

| Family | Correct | Accuracy | One-sided 95% lower |
|---|---:|---:|---:|
| A | 475/500 | 95.00% | 93.40% |
| B | 1119/1206 | 92.79% | 91.07% |
| C | 1072/1206 | 88.89% | 86.79% |
| D | 1042/1206 | 86.40% | 84.11% |

The immutable union contains 28,634 proposals across 3,670 selected local
identities. Its same-identity location Oracle is 3,586/3,670 (97.71%); combined
with selected non-local operations, the event candidate ceiling is
4,035/4,118 (97.98%).

## Remaining failures

| Layer | Count |
|---|---:|
| Candidate Oracle missing | 57 |
| Operation or frontier identity | 110 |
| Refusal | 10 |
| Same-identity window ranking | 233 |

Directly adding every stored bottom-evidence column was negative (3692), as
was replacing the broad shortlist with anchor candidates (candidate ceiling
below 95%). These variants remain archived as ablations and are not defaults.
Production adjudication remains unchanged.
