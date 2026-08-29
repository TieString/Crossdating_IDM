# COFECHA 6.06 Exact Master Parity

Date: 2026-08-29  
Branch: `experiment`

## Acceptance contract

`buildCofecha606MasterSeries` is accepted only when all of the following match COFECHA 6.06:

- identical calendar-year set;
- identical Part 3 sample depth for every year;
- identical saved Master value after four-decimal formatting for every year;
- byte-identical normalized MAS text, including negative-zero handling.

Correlation alone is not an acceptance criterion.

## Reconstructed pipeline

1. Microsoft FORTRAN Tucson `F6.2` / `F6.3` conversion to `REAL*4`.
2. Cook-Holmes 32-year, 50% response spline using the original LUDAPB/LUELPB band solve.
3. DIVSER ratio or residual-plus-one branch.
4. Per-core variance stabilization with a second spline pass.
5. Optional COFECHA log transform using the legacy `0.1667 * mean` offset.
6. Per-core population standardization in float32.
7. Original non-positive measurements omitted from the annual mean but retained in displayed depth.
8. Float32 annual accumulator/counter and population standardization of the final Master.
9. Longest continuous covered span selected for MAS output.

AR modeling is reconstructed for checking/statistics, but is intentionally excluded from the saved chronology. COFECHA produces byte-identical `ARRAWCOF.MAS`/`PLAINCOF.MAS` and `FULLCOF.MAS`/`LOGONCOF.MAS` pairs.

The implementation also handles mixed `999`/`-9999` precision within one file, repeated same-ID segments, explicit zero years, retained negative placeholders, all-series absent years, and disconnected early spans.

## Controlled fixtures

| Fixture | Profiles | Exact years |
| --- | --- | ---: |
| varied-six | plain, log-only, AR-only, full | 200/200 each |
| impulse-center | plain | 200/200 |
| nm574 | plain, log-only, AR-only, full | 386/386 each |

## ITRDB validation

Default full-profile validation used 34 frozen files:

`az086, ca612, ca646, ca660, co021, co583, co589, co593, co604, co605, co612, co616, co617, co624, co629, co631, co632, co647, co649, co650, co651, co658, co699, mt001, nm025, nm026, nm560, nm565, nm572, nm580, or093, paki033, ut529, ut530`

| Metric | Result |
| --- | ---: |
| Files passed | 34/34 |
| Calendar years matched | 30,692/30,692 |
| Four-decimal values matched | 30,692/30,692 |
| Sample-depth mismatches | 0 |
| Byte-identical MAS files | 34/34 |

Frozen output:

`D:\软件测试\cofecha-js-parity-probe\exact-master-34-files-final-v8\summary.json`

## Verification

```text
npx vitest run ...                                  14/14 passed
node --test diagnosis-oracle + unseen split         2/2 passed
py -3.10 -m unittest ...                            13/13 passed
npm run build                                       passed
```

The exact builder is available as a shadow API. Production reference selection is not switched by this experiment commit.
