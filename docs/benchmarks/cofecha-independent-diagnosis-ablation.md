# COFECHA-independent automatic diagnosis ablation

## Question

Can COFECHA become display-only, with its master chronology, PART 6 flags, and
report text completely excluded from automatic crossdating suggestions?

## Method

The experiment replays all 963 frozen frontier states from the 15-file second
holdout. Every strategy receives the same `state.rwl` and current frontier truth.
This is a fixed-state suggestion comparison, not a replacement for serial recovery.

The pure internal reference is rebuilt separately for every target:

1. remove the target before pairwise graph construction;
2. choose the largest stable zero-lag component;
3. build the standardized master only from that component;
4. never parse COFECHA master values or pass COFECHA text to diagnosis.

## Results

| Strategy | COFECHA master | PART 6 classification | COFECHA text passed to diagnosis | Correct / events | Workflow accuracy | Response | Clean FP |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| Production reference, no diagnosis text | Yes | Yes | No | 773/873 | **88.55%** | 99.43% | 1/90 |
| COFECHA master, all series treated as pass | Yes | No | No | 735/873 | 84.19% | 93.01% | 1/90 |
| Pairwise only, internal non-cluster flags | No | No | No | 741/873 | 84.88% | 96.91% | 7/90 |
| Pairwise only, no candidate flags | No | No | No | 651/873 | 74.57% | 82.25% | 1/90 |

Pairwise-only with COFECHA text but no COFECHA-derived classification is identical
to pairwise-only without text: 651/873. The report text itself does not restore the
lost behavior.

Family accuracy for the strongest fully internal variant is A 95.56%, B 79.29%,
C 86.30%, and D 85.84%. It corrects 31 production failures but regresses 63
production-correct attempts.

## Interpretation

Automatic diagnosis does not need the raw COFECHA report text once the COFECHA
master and PART 6-derived reference classification have already been constructed.
Removing `cofechaText` from diagnosis is therefore technically safe on this frozen
replay.

Complete removal is not yet safe. The current pairwise bootstrap master loses
cross-file accuracy, especially for repeated and mixed events. Treating every
non-cluster target as internally flagged restores response and some accuracy, but
causes an unacceptable Clean false-positive increase.

## Decision

- Do not switch production automatic diagnosis to pairwise-only.
- COFECHA may remain visually separated from suggestion UI, but its master and
  reference classification are still functional diagnosis inputs today.
- A future COFECHA-free version needs a calibrated JS master/reference classifier,
  not another downstream display gate.
- The next internal reference should estimate target compatibility with the stable
  cluster instead of automatically flagging every target excluded for leave-one-out.

No production module is changed by this experiment.

External results:

`D:\软件测试\itrdb-unified-model-v2\second-holdout\models\pairwise-only-replay-v6`

`D:\软件测试\itrdb-unified-model-v2\second-holdout\models\pairwise-only-internal-flags-v10`

`D:\软件测试\itrdb-unified-model-v2\second-holdout\models\cofecha-master-without-diagnosis-evidence-v8`

`D:\软件测试\itrdb-unified-model-v2\second-holdout\models\cofecha-reference-without-diagnosis-text-v9`
