# Diagnosis Oracle Experiment

## Purpose

This experiment tests whether the current diagnosis ceiling comes from missing evidence or from
rule-based projection and adjudication. It does not modify the production diagnosis pipeline.

## Design

- Production commit: `f1f5a525`
- Frozen protocol: `itrdb-operation-capability-v4-1000`
- Files: 25
- Sample: four frozen cases per file and family
- Selection uses frozen case index only and is independent of diagnosis outcomes.
- Cases: 500 (`100 × Clean/A/B/C/D`)
- Event opportunities after human-rescue continuation: 931
- Hidden truth is used only by this offline evaluator.
- Cluster bootstrap: 10,000 resamples by whole RWL file.

The strict Oracle accepts a hypothesis only when operation, exact partial/whole shift, and the
unique window all match the current hidden frontier. A relaxed Oracle additionally accepts a
negative `partialMove` covering a true missing ring, matching the product's physical-evidence
review workflow.

## Results

| Family | Product | Strict Oracle | Oracle gain | Gain one-sided 95% lower |
|---|---:|---:|---:|---:|
| A | 96.00% | 100.00% | +4.00 pp | +1.00 pp |
| B | 93.52% | 98.98% | +5.46 pp | +3.37 pp |
| C | 91.19% | 97.63% | +6.44 pp | +3.81 pp |
| D | 93.00% | 97.53% | +4.53 pp | +2.78 pp |

Overall product accuracy was 92.91%. The strict Oracle was 98.28%, and the relaxed Oracle was
99.14%. Every family's clustered Oracle gain had a positive one-sided 95% lower bound.

The sample is 0.92 percentage points easier than the complete 5000-case full-event result
(91.99%). Oracle accuracy is an upper bound on available evidence, not a claim that a learned
adjudicator will attain it.

### Failure attribution

There were 66 failed event opportunities:

| Failure layer | Count | Share of failures |
|---|---:|---:|
| Correct raw grid evidence was not promoted | 32 | 48.48% |
| Correct joint hypothesis lost selection | 12 | 18.18% |
| Correct earlier event was rewritten downstream | 3 | 4.55% |
| Correct `finalEvents` event was not shown | 3 | 4.55% |
| No complete hypothesis | 11 | 16.67% |
| Correct operation but no covering location | 4 | 6.06% |
| Covering location but no correct operation | 1 | 1.52% |

Thus 50/66 failures (75.76%) already had a strict correct answer somewhere in the internal
operation/path grid. Only 18/66 (27.27%) had reached a complete production-stage hypothesis.
The main loss is evidence promotion and joint assembly, not only the last UI selector.

### Operation-specific ceiling

| Truth | Product | Strict Oracle |
|---|---:|---:|
| Missing ring | 93.88% | 97.67% |
| False ring | 93.06% | 98.42% |
| Partial move | 88.04% | 98.91% |
| Whole-series move | 98.85% | 98.85% |

`partialMove` has the largest adjudication gap. Its evidence generator is substantially stronger
than its current final selection rate.

### Why the highest raw score is insufficient

Among 441 opportunities where the exhaustive counterfactual table contained a strict answer,
the correct answer ranked first by the current raw score 367 times (83.22%), in the top three
374 times (84.81%), and in the top five 378 times (85.71%). For B specifically, it ranked first
only 99/159 times. A unified adjudicator needs operation, path-state, source agreement, and
location features; replacing the current rules with `max(score)` would regress many cases.

### Clean controls

- Product false positives: 1/100
- Complete stage hypotheses: 18/100
- Joint hypotheses: 18/100
- Any raw grid hypothesis: 100/100

The raw grid deliberately proposes hypotheses on clean data. Oracle recall therefore cannot be
obtained by exposing every internal candidate. A calibrated reject option remains mandatory.

## Conclusion

The case-by-case rule patching method is near its practical ceiling, but the underlying lag,
counterfactual, and multi-reference evidence is not. The next implementation should build one
immutable hypothesis table and train or calibrate one file-held-out adjudicator over that table.
It should replace promotion and rewrite rules, not add another downstream rule layer.

The 25 files used here must now be treated as development data for that adjudicator. Final
generalization must use entirely new RWL files.

## Reproduction

Generate the frozen sample indices:

```powershell
node scripts/select-diagnosis-oracle-sample.mjs `
  --resolved-cases="D:/软件测试/itrdb-operation-capability/results/human-rescue-v2-abcd-1000-final-generalized-20260822/resolved-cases.json" `
  --per-file-family=4 `
  --indices-only
```

Run the capability benchmark with `--keep-diagnosis-audits`, then analyze it:

```powershell
node scripts/analyze-diagnosis-oracle.mjs `
  --run-dir="D:/软件测试/itrdb-operation-capability/experiments/oracle-stratified-500-20260823"
```

Generated results:

- `oracle-analysis/summary.json`
- `oracle-analysis/attempts.csv`
- `oracle-analysis/clean-attempts.csv`
- `oracle-analysis/report.md`
