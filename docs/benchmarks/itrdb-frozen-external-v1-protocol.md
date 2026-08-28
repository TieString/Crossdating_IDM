# Frozen external ITRDB test v1

## Scope

This is an analysis-only external test of the frozen standalone v34 diagnosis model. No external result may be used to train, calibrate, change a threshold, replace a case, or select a different model. The production adjudicator remains unchanged.

The frozen test contains 50 complete RWL files and 10 targets per file. Every target contributes one Clean, A, B, C, and D scenario, for 500 scenarios per family and 2,500 scenarios in total. Each scenario starts from the clean source and modifies only its target series.

## Leakage controls

- Historical file IDs are collected from all tracked configs, manifests, splits, RWL paths in source/tests/docs, and prior external artifacts.
- The frozen 50 files have zero overlap with 1,607 historical IDs; `co612` is explicitly absent.
- All 50 source SHA-256 values match the manifest.
- The model evidence commit, runtime model manifest hash, scenario generator hash, COFECHA hash, config, manifest, file list, and all random seeds were frozen before diagnosis.
- File and target selection use only source structure and clean COFECHA output. Diagnosis output and injected truth are not selection inputs.

## Quality gates

- File possible problem segments: exactly zero.
- Target PART 7 problem segments: exactly zero.
- Target length: at least 100 years.
- Target-to-master correlation: at least 0.60.
- Natural zero count: zero for every selected target.
- At least 10 eligible targets per selected file.

The requested file-intercorrelation allocation was approximately one quarter per band. Among all 3,000 structurally screened new candidates, only two files in the 0.50-0.60 band also passed every zero-problem and ten-zero-free-target gate. The frozen allocation therefore records the shortfall without relaxing any gate:

| File intercorrelation | Files |
| --- | ---: |
| 0.50-0.60 | 2 |
| 0.60-0.70 | 13 |
| 0.70-0.80 | 23 |
| >=0.80 | 12 |

Target-to-master correlation is distributed as follows:

| Target correlation | Targets |
| --- | ---: |
| 0.60-0.70 | 164 |
| 0.70-0.80 | 202 |
| >=0.80 | 134 |

## Length and scenario capacity

Files are selected jointly with targets under fixed correlation-band counts. The selector first minimizes global length imbalance, then performs deterministic same-band swaps. The resulting target counts are:

| Target length | Targets |
| --- | ---: |
| 100-199 years | 246 |
| 200-299 years | 167 |
| >=300 years | 87 |

The 87 long targets are the exact capacity upper bound among the 186 files that passed all quality gates while preserving the frozen file-correlation counts. No diagnosis result participated in this optimization.

Scenario generator v6 determines feasibility before diagnosis:

- A uses one event.
- A 100-199-year target uses two events in B/C/D.
- A 200-299-year target uses two or three events.
- A target of at least 300 years uses three or four events.
- Local chains preserve at least 45 years of older-side context and 15 years of newer-side context.
- Local frontiers are allocated marginally across middle (`>=70` years from newest), newer (`35-69`), and bark-near (`15-34`) positions.
- Automated whole-series shifts are frozen to `-4/-11/-20/-50`; positive automatic whole moves are absent.

## Frozen artifacts

- `itrdb-frozen-external-v1-config.json`
- `itrdb-frozen-external-v1-manifest.json`
- `itrdb-frozen-external-v1-lock.json`
- External selection audit: `D:\软件测试\itrdb-unified-model-v2\external-v1\protocol\selection-audit.json`
- Disk cleanup audit: `D:\软件测试\itrdb-unified-model-v2\artifact-archive-2026-08-28\cleanup-manifest.json`

After the test starts, these artifacts are immutable. Final reporting will include overall and A/B/C/D workflow accuracy, strict accuracy, response/refusal, Clean false positives, file-clustered one-sided 95% lower bounds, direct serial recovery, human-rescue full-event accuracy, and stratification by both correlation layers, length, frontier position, event count, and reference depth.
