# Crossdating IDM: an auditable desktop workbench for tree-ring crossdating and COFECHA-informed diagnosis

**Article type:** Technical Note

**Author information and affiliations:** To be supplied by the submitting authors.

**Corresponding author:** To be supplied by the submitting authors.

**Version:** Draft prepared from the Crossdating IDM codebase on 26 June 2026.

## Abstract

Reliable crossdating depends on preserving the original measurement record while making potential dating problems visible, inspectable, and reversible. Crossdating IDM is a desktop application for working with tree-ring width (RWL) data in a single auditable workspace. The software imports and detects several RWL representations, maintains a raw baseline alongside editable working data, and provides a year-by-width grid, multi-series chart, text editing, undo/redo, and an operation log. It distinguishes a manual visual reference chronology from a COFECHA-pass dynamic reference. The latter is derived only from series without COFECHA PART 6 A flags and is formed through spline detrending, ring-width indexing, autoregressive prewhitening, transformation, yearly aggregation, and final standardization. An internal diagnostic engine combines global sliding comparison, segmented correlation and lag inspection, constrained local edit alignment, and ranked candidate evaluation to suggest missing-ring, false-ring, whole-series shift, or partial-range shift checks. Suggestions are never applied automatically: users must accept one constrained edit at a time, after which the software invalidates prior suggestions and reruns the diagnosis. COFECHA is executed as a sidecar process against the current working RWL, and its VERYCOF.OUT output is retained for review and can be mirrored next to the source file. Repository validation on eight paired raw/crossdated sample sites, synthetic edit scenarios, dynamic-reference checks, and workspace-window smoke tests completed successfully. Crossdating IDM is intended as decision-support software; final crossdating remains a specialist judgement supported by external COFECHA verification and independent inspection.

**Keywords:** dendrochronology; crossdating; tree-ring widths; RWL; COFECHA; quality control; audit trail; desktop software

## 1. Introduction

Crossdating assigns each ring in a measured series to its calendar year by comparing the year-to-year pattern of ring widths with other series or an established chronology. Classical computer-assisted approaches slide one series across another and assess correlation or related statistics across valid overlap positions (Baillie and Pilcher, 1973). Subsequent tools added segmented quality control, making it easier to find local regions that require inspection (Holmes, 1983; Grissino-Mayer, 2001). Yet a high-scoring offset is not itself a crossdating decision: missing rings, false rings, local measurement issues, and low common signal can all complicate interpretation.

Many software workflows separate file preparation, visual inspection, data editing, automated screening, and COFECHA validation. That separation can make the reason for a correction difficult to reconstruct, and it can leave a later analyst unsure whether a result came from the original measurements or from a modified working copy. Crossdating IDM was developed as a desktop workbench that keeps those activities connected while retaining the original data, the edit history, and the external COFECHA output.

The program does not introduce an unconstrained automatic dating procedure. Instead, it combines several established computational ideas into an auditable review workflow: sliding comparison, segment-level lag inspection, constrained edit alignment, and relative candidate ranking (Baillie and Pilcher, 1973; Van Deusen, 1990; Wenk, 2003; Hassan et al., 2019). Its purpose is to focus expert attention on plausible locations and limited, interpretable corrections.

## 2. Software architecture and RWL workflow

Crossdating IDM is a Tauri 2 desktop application with a React 18 and TypeScript front end. Tauri provides native file-dialog, file-system, process, and window capabilities; the Rust layer registers the small set of commands that must run outside the WebView. The application state and user workflow are orchestrated in `src/pages/Home.tsx` and `src/pages/home/useHomeWorkspace.ts`. Domain functions are separated into RWL parsing and editing, reference chronology construction, diagnostic analysis, COFECHA output formatting, and service modules.

Opening an RWL file begins with text I/O in `src/services/fs/io.ts`. `src/features/rwl/index.ts` detects the likely representation and dispatches to a registered parser for Tucson, Compact, CSV, Heidelberg, or TRiDaS input. The parser returns a map of series identifiers to year/value maps plus format metadata. The current unified formatter is registered for Tucson output. For Tucson files, the read options preserve the short/long identifier layout, so a read-edit-save cycle does not silently truncate long identifiers or collapse the original form.

The parsed data are loaded into `RwlEditor` (`src/features/rwl/edit.ts`), which holds a raw baseline, mutable working data, history snapshots, deletion markers, and an operation log. The visible width grid (`src/components/WidthContainer`) does not edit a detached copy of the data. It requests operations from the workspace, which applies them through the editor and records their before/after state. The same path is used by text edits, manual grid edits, and accepted diagnostic suggestions. A reset operation restores the raw baseline directly rather than trying to infer a reverse sequence of edits.

The chart layer uses Chart.js with crosshair and zoom plugins. `TreeChartManager` controls selection and reference interaction, and `MultiLineChart` displays raw series, sample depth, reference curves, and faint bands for segments flagged by the current internal diagnosis. An independent operation-log or COFECHA window is synchronized through a labelled window bridge, so stale close events from an earlier window do not overwrite the current main-window state.

## 3. Reference chronologies

The software deliberately keeps two types of reference chronology separate.

First, a manual visual reference is created when the user selects reliable series in the chart. At each year, the application calculates the arithmetic mean of the selected raw ring widths and suppresses years below a configured minimum sample depth. This line remains in raw-width units and is intended for visual comparison during editing. It is not stored as another RWL series and is not used as a substitute for a standardized chronology.

Second, a COFECHA-pass dynamic reference is generated after a COFECHA run. The program parses PART 6 of VERYCOF.OUT and classifies series with no A-flagged segment as `anchor_pass`; series with an A flag are retained as `candidate_flagged` inspection targets. Only `anchor_pass` series contribute to the dynamic reference. Each contributing series undergoes a 32-year, 50%-frequency-response cubic smoothing-spline detrending step, is converted to a ring-width index by dividing the raw value by the fitted spline, and is then prewhitened using an autoregressive model. The default processing includes a log transform; first differencing is configurable. Transformed values are averaged by calendar year and the resulting master is standardized to mean zero and standard deviation one. Zero values representing absent rings are excluded by default.

This processing follows the practical distinction between an immediately interpretable raw-width comparison line and a standardized residual chronology appropriate for algorithmic comparison (Cook and Peters, 1981; Grissino-Mayer, 2001). The dynamic reference is associated with the COFECHA run and RWL hash from which it was produced. Any subsequent RWL edit marks it stale until COFECHA is rerun.

## 4. Internal diagnosis and controlled corrections

The diagnostic engine (`src/features/crossdating/diagnosis`) is a rapid, internal screening tool. It does not run COFECHA and it does not modify an RWL file. Its work is dispatched from `useHomeWorkspace.ts` to a Web Worker so that chart and grid interaction remain responsive.

For each target series, the engine constructs an eligible scoring reference that excludes the target. If an up-to-date COFECHA-pass dynamic reference is available, its residual chronology is used directly. The engine combines four complementary forms of evidence:

- Global sliding comparison searches a bounded range of whole-series lags, following the general logic of correlation-based crossdating.
- Segmented diagnosis examines correlations and lag behavior through the series, identifies problem segments, and detects patterns consistent with a local propagation of offset.
- Constrained local edit alignment evaluates limited missing-ring and false-ring alternatives near an evidence-supported location, rather than applying unrestricted dynamic time warping.
- Candidate evaluation compares pre- and post-edit segment and whole-series metrics, uses optional COFECHA segment-lag hints, and ranks surviving candidates with a relative-confidence score.

The output is restricted to three executable edit families: insertion of a missing year, deletion of a false year, and batch movement of years. Batch movement can apply to a whole series or to a bounded selected range; partial-range moves retain both the selected and inferred missing-range evidence and are not rewritten as an arbitrary run of zero widths. Each candidate retains its algorithm source, evidence, candidate year or range, metrics before and after the proposed operation, rank, a probability-like relative score, and a confidence label. The probability-like value ranks internal alternatives; it is not a Bayesian posterior probability.

Users must explicitly accept an individual candidate. The accepted operation is logged as `auto-suggested`, but it uses the same `RwlEditor` method as a manual operation. The program then marks all earlier candidates stale and reruns the diagnosis against the revised working data. This one-at-a-time rule prevents a chain of automated modifications from being applied without review.

## 5. COFECHA integration and result retention

COFECHA remains the external quality-control step. When a user saves or explicitly runs COFECHA, the application exports the current working RWL rather than an obsolete input copy. `src/services/cofecha/runner.ts` clears the application-data `cofecha-work` directory, writes an input RWL, starts the selected COFECHA sidecar, and reads VERYCOF.OUT. The application currently provides sidecar selection for COFECHA, COFECHA12K, and COFECHA Win variants that share the expected input/output protocol.

The runner handles a practical interoperability issue: non-ASCII input file names are replaced with an ASCII working name for the sidecar and restored in the displayed output where possible. The output text is parsed by `src/features/cofecha/formatter.ts`, persisted by source-file path with the current workspace, and made available to the chart, operation-log view, and diagnostic engine. A Rust command, `write_out_next_to_rwl`, additionally writes an OUT copy beside the source RWL when that location is writable. Keeping the OUT text and the working-state log together makes later review possible without treating the internal diagnosis as equivalent to COFECHA.

## 6. Software verification

The repository contains executable validation scripts rather than a claim of a completed field-performance study. On 26 June 2026, the aggregate command `npm run validate` completed successfully. It ran four checks.

First, `validate:samples` processed eight paired raw/crossdated sample sites (EBD, EBM, EBU, RDD, RDM, RDU, ZSD, and ZSL). Across these files, the internal issue-segment count decreased from 778 for the raw versions to 52 for the supplied crossdated versions; the number of generated candidates decreased from 529 to 14. These counts describe the behavior of the internal screening metric on the repository samples only. They are not sensitivity, specificity, or an independent estimate of crossdating accuracy.

Second, `validate:auto-crossdating` checked synthetic scenarios for a clean target, a missing ring, a false ring, a global shift, a whole-series move, and two partial-range moves. The scripted checks verified, among other properties, recognition of a missing-ring candidate at 1990, a false-ring candidate at 1965, a global lag of -10, a whole-series shift of -4, and selected partial movements of -5 and -16 years. It also verified that accepting a candidate marks prior alternatives stale.

Third, `validate:cofecha-reference` checked the PART 6 classification and dynamic-reference workflow in a synthetic case, producing five `anchor_pass` series, two `candidate_flagged` series, and 57 reference points. The test verifies the intended classification and final standardization path. Finally, `validate:workspace-windows` completed a server-side rendering smoke check of the independent workspace windows and their bridge constants.

These checks establish regression coverage for parsing, state transfer, constrained edit behavior, reference construction, and key user-interface boundaries. A future evaluation should use independently crossdated material from multiple taxa, regions, and signal strengths; report candidate precision and recall by error type; compare accepted edits against blinded expert assessments; and evaluate behavior on incomplete, low-replication, and non-Tucson input data.

## 7. Availability, requirements, and limitations

The current software version is 1.0.0. The source tree includes the application, validation scripts, sample material, and Windows-targeted COFECHA sidecars. Development requires Node.js and npm; Tauri development also requires the standard Rust/Tauri toolchain. Core commands are `npm run tauri`, `npm run build`, and `npm run validate`. The source repository URL, release tag, licence statement, archival DOI, and author contact information should be added by the submitting authors before journal submission.

Several limitations are intentional. The diagnostic engine is advisory and cannot establish a final date. A candidate's relative confidence is a ranking aid, not a calibrated probability. The COFECHA-pass reference depends on the most recent compatible COFECHA run and is deliberately invalidated by later data edits. Although multiple input parsers are available, full transparent export is currently registered for Tucson format, so workflows using another imported representation should confirm the export path before replacing an original file. Finally, no unconstrained dynamic time-warping method is used as the primary correction mechanism, because its flexibility would weaken the auditability of proposed edits.

## 8. Conclusions

Crossdating IDM provides a focused desktop environment for RWL handling, visual comparison, audit-preserving editing, COFECHA execution, and constrained crossdating diagnosis. Its central design choice is to keep original data, derived references, diagnostic evidence, accepted edits, and external quality-control output distinct but connected. The software is most useful when it shortens the path from a suspicious segment to an expert reviewable hypothesis, while leaving final crossdating decisions and external validation in the hands of the dendrochronologist.

## Declarations

**Funding:** To be completed by the submitting authors.

**Conflicts of interest:** To be completed by the submitting authors.

**Data availability:** The repository validation data are distributed within the project tree. Any restrictions on redistribution, and a persistent software archive, should be stated by the submitting authors.

**Code availability:** The source repository URL, release identifier, and licence should be supplied by the submitting authors.

## References

Baillie, M.G.L., Pilcher, J.R., 1973. A simple crossdating program for tree-ring research. Tree-Ring Bulletin 33, 7-14.

Cook, E.R., Peters, K., 1981. The smoothing spline: a new approach to standardizing forest interior tree-ring width series for dendroclimatic studies. Tree-Ring Bulletin 41, 45-53.

Grissino-Mayer, H.D., 2001. Evaluating crossdating accuracy: a manual and tutorial for the computer program COFECHA. Tree-Ring Research 57, 205-221.

Hassan, M.M., Jones, E., Buck, C.E., 2019. A simple Bayesian approach to tree-ring dating. Archaeometry. https://doi.org/10.1111/arcm.12466.

Holmes, R.L., 1983. Computer-assisted quality control in tree-ring dating and measurement. Tree-Ring Bulletin 43, 69-78.

Van Deusen, P.C., 1990. A dynamic program for cross-dating tree rings. Canadian Journal of Forest Research 20, 200-205.

Wenk, C., 2003. Applying an edit distance to the matching of tree ring sequences in dendrochronology. Journal of Discrete Algorithms 1, 367-385. https://doi.org/10.1016/S1570-8667(03)00028-5.
