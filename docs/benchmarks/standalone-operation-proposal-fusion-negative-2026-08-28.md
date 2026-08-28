# Standalone operation proposal fusion negative result

The equal-footing operation proposal experiment used only file-OOF evidence and
excluded file, series, family, year truth, and correctness fields from runtime
features. It was not promoted because it violated the zero-regression gate on
the 33-file development set.

| Model | Correct | Accuracy | Correct to wrong | Wrong to correct | Clean FP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Direct classifier | 3853/3957 | 97.37% | 25 | 13 | 1/414 |
| Direct ranker | 3862/3957 | 97.60% | 18 | 15 | 1/414 |
| Five-ranker ensemble | 3864/3957 | 97.65% | 16 | 15 | 1/414 |

The five-ranker model reached 575/582 operation identities on calibration, but
that target result does not override the development OOF safety failure. The
retained direction is selective pairwise operation-transition calibration,
which preserved every prior correct complete suggestion in both development
and calibration.
