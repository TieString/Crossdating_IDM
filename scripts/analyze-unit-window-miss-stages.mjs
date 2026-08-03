import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    throw new Error("Pass one or more counterfactual locator audit paths");
}

const contains = (window, year) => Boolean(
    window && window.startYear <= year && year <= window.endYear,
);

const width = (window) => window
    ? window.endYear - window.startYear + 1
    : 0;

const datasetName = (path) => {
    const name = path.toLowerCase();
    const patterns = [
        ["train31", "train-offset31"],
        ["train47", "train-offset47"],
        ["calibration31", "calibration-offset31"],
        ["calibration47", "calibration-offset47"],
        ["validation", "validation"],
        ["reserved", "reserved"],
        ["holdout-v3", "holdout-v3"],
        ["holdout-v4", "holdout-v4"],
        ["holdout-v5", "holdout-v5"],
    ];
    for (const [label, pattern] of patterns) {
        if (name.includes(pattern)) return label;
    }
    return name;
};

const stageWindows = (row) => ({
    coarse: row.coarseWindow,
    prePoint: row.prePointModeWindow,
    preFalseAnchor: row.preFalseCurrentAnchorModeWindow,
    preDirect: row.preDirectModeWindow,
    mode: row.modeWindow,
    final: row.finalWindow,
});

const rows = paths.flatMap((path) => {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    const result = (payload.counterfactualLocatorCases ?? [])
        .filter((row) => (
            row.context?.baselineFlagged === false
            && (row.eventType === "missingRing" || row.eventType === "falseRing")
            && row.correctionYears === row.truthCorrectionYears
            && row.finalWindow
        ))
        .map((row) => ({
            dataset: datasetName(path),
            eventType: row.eventType,
            truthYear: row.truthYear,
            context: {
                file: row.context.file,
                target: row.context.target,
                positionStratum: row.context.positionStratum,
                signalStrength: row.context.signalStrength,
            },
            candidates: (row.candidates ?? []).map((candidate) => ({
                startYear: candidate.startYear,
                endYear: candidate.endYear,
                source: candidate.source,
            })),
            coarseWindow: row.coarseWindow,
            prePointModeWindow: row.prePointModeWindow,
            preFalseCurrentAnchorModeWindow:
                row.preFalseCurrentAnchorModeWindow,
            preDirectModeWindow: row.preDirectModeWindow,
            modeWindow: row.modeWindow,
            finalWindow: row.finalWindow,
            currentPrimaryYear: row.currentPrimaryYear,
            selectedOperation: row.selectedOperation,
            windowCenteringRule: row.windowCenteringRule,
            widthSelectionRule: row.widthSelectionRule,
        }));
    return result;
});

const report = {};
for (const dataset of [...new Set(rows.map((row) => row.dataset))]) {
    report[dataset] = {};
    for (const eventType of ["missingRing", "falseRing"]) {
        const selected = rows.filter((row) => (
            row.dataset === dataset && row.eventType === eventType
        ));
        const stageNames = Object.keys(stageWindows(selected[0] ?? {}));
        const stageHits = Object.fromEntries(stageNames.map((stage) => [
            stage,
            selected.filter((row) => (
                contains(stageWindows(row)[stage], row.truthYear)
            )).length,
        ]));
        const misses = selected
            .filter((row) => !contains(row.finalWindow, row.truthYear))
            .map((row) => {
                const stages = stageWindows(row);
                const containingCandidateSources = (row.candidates ?? [])
                    .filter((candidate) => contains(candidate, row.truthYear))
                    .map((candidate) => candidate.source);
                return {
                    file: row.context.file,
                    target: row.context.target,
                    truthYear: row.truthYear,
                    position: row.context.positionStratum,
                    signalStrength: row.context.signalStrength,
                    windows: Object.fromEntries(Object.entries(stages).map(([
                        stage,
                        window,
                    ]) => [stage, {
                        window,
                        width: width(window),
                        hit: contains(window, row.truthYear),
                    }])),
                    currentPrimaryYear: row.currentPrimaryYear,
                    operationBestYear: row.selectedOperation?.bestYear,
                    sideStepBestYear: row.selectedOperation?.sideStepBestYear,
                    windowCenteringRule: row.windowCenteringRule,
                    widthSelectionRule: row.widthSelectionRule,
                    containingCandidateSources,
                };
            });
        report[dataset][eventType] = {
            cases: selected.length,
            stageHits,
            stageCoverage: Object.fromEntries(Object.entries(stageHits).map(([
                stage,
                hits,
            ]) => [stage, selected.length > 0 ? hits / selected.length : 0])),
            misses,
        };
    }
}

console.log(JSON.stringify({ report }, null, 2));
