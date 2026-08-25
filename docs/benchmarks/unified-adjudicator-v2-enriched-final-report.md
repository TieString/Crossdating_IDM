# Unified adjudicator v2 enriched evidence final report

## Outcome

The enriched evidence generator materially improves the operation and location
proposal ceiling, but it does not satisfy the requested cross-file generalization
contract on the second independent holdout. It is not approved for shadow or
production integration.

## Frozen architecture

The experiment keeps one immutable operation identity and one 13-year location
window. It adds the following truth-blind evidence to the shared yearly table:

- raw and COFECHA-style full-interval lag transitions;
- cumulative CUSUM and contrast profiles;
- piecewise objectives;
- per-reference change-point and lag-transition consensus;
- per-reference counterfactual gains;
- partial-move boundary and local residual profiles.

The operation head cannot change location. The location head cannot change the
operation or shift. The tested workflow package retains the production main
suggestion and offers one user-invoked enriched review interpretation; it does not
automatically replace the main suggestion.

## Split progression

| Split | Files | A | B | C | D | Overall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development OOF | 18 | 98.15% | 96.02% | 97.53% | 96.47% | 96.83% |
| Replacement calibration | 12 | 100% | 95.91% | 95.37% | 96.07% | 96.21% |
| First holdout, frozen operation-specific policy | 17 | 96.08% | 95.79% | 95.42% | **94.98%** | 95.49% |
| Second independent holdout, frozen classifier policy | 15 | 96.67% | 95.36% | **92.96%** | **93.56%** | 94.27% |

The first holdout missed D by one event. The classifier-only candidate happened to
pass all four families on those files, but selecting it after viewing the holdout
would be post-hoc. A second holdout was therefore frozen from 15 new whole RWL
files with zero overlap against tracked historical IDs and 34 explicitly known
early files.

## Second holdout

The final second-holdout result contains 873 event opportunities from 15 files and
90 frozen target series.

| Family | Correct / events | Workflow accuracy | One-sided 95% file-cluster lower | Strict package accuracy |
| --- | ---: | ---: | ---: | ---: |
| A | 87/90 | **96.67%** | **93.33%** | 94.44% |
| B | 267/280 | **95.36%** | **92.34%** | 93.21% |
| C | 251/270 | **92.96%** | **90.74%** | 71.48% |
| D | 218/233 | **93.56%** | **89.03%** | 92.70% |
| Overall | 823/873 | **94.27%** | **92.71%** | 86.48% |

The requirement fails for C and D observed accuracy, and D also fails the 90%
one-sided lower bound.

The untouched production baseline on the same run has 773/873 = 88.55%
human-assisted full-event workflow accuracy. The enriched package adds 50 complete
recoveries without changing the production main suggestion.

## Failure attribution

There are 100 production failures in the second holdout. The enriched operation
head selects the correct workflow operation for 75; the location head completes 50.

| Family | Product failures | Correct operation Top1 | Complete correction | Remaining operation loss | Correct-operation location loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 6 | 4 | 3 | 2 | 1 |
| B | 36 | 27 | 23 | 9 | 4 |
| C | 32 | 29 | 13 | 3 | **16** |
| D | 26 | 15 | 11 | **11** | 4 |

C is primarily a cross-file location-distribution failure. D is primarily an
operation-identity failure in mixed-event states. Another downstream gate cannot
recover events that the selected operation or selected location already misses.

## Safety and reproducibility

- Second-holdout Clean false positives: 1/90 in the unchanged production baseline.
- Added Clean false positives: 0; the review package is not an automatic response.
- Automatic positive whole-series moves: 0.
- Window width: 13 years; no illegal widths.
- Save/reopen stability: 100%.
- Source files unchanged and benchmark errors: 0.
- The first holdout was repeated with audit persistence; 1,078 normalized step
  decisions were byte-equivalent by content, SHA-256
  `01e84d0b940bf5d75e190f4dd8cdfe9d37ebc6160d10349a42316868ec023ed6`.

## Decision

Keep commits and external artifacts as a negative-result research branch. Do not
replace the production adjudicator and do not claim that A/B/C/D all meet 95%.
Future work must improve the C location generator and D operation generator on new
development files, followed by a newly frozen evaluation; no further tuning is
permitted on either opened holdout.

External artifacts are under:

- `D:\软件测试\itrdb-unified-model-v2\models`
- `D:\软件测试\itrdb-unified-model-v2\runs`
- `D:\软件测试\itrdb-unified-model-v2\second-holdout`
