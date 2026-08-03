import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("Pass locator audit paths");

const datasetName = (path) => {
    const name = path.toLowerCase();
    const patterns = [
        ["train31", ["current-train31", "train-offset31"]],
        ["train47", ["current-train47", "train-offset47"]],
        ["cal31", ["current-calibration31", "calibration-offset31"]],
        ["cal47", ["current-calibration47", "calibration-offset47"]],
        ["validation", ["validation"]],
        ["reserved", ["reserved"]],
        ["holdout3", ["holdout-v3"]],
        ["holdout4", ["holdout-v4"]],
    ];
    return patterns.find(([, values]) => values.some((value) => (
        name.includes(value)
    )))?.[0] ?? name;
};

const contains = (window, year) => (
    window.startYear <= year && year <= window.endYear
);

const median = (values) => {
    const ordered = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
        ? ordered[middle]
        : (ordered[middle - 1] + ordered[middle]) / 2;
};

const cases = paths.flatMap((path) => {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    return (payload.counterfactualLocatorCases ?? []).flatMap((row) => {
        if (
            row.context?.baselineFlagged !== false
            || row.eventType !== "missingRing"
            || row.correctionYears !== row.truthCorrectionYears
            || !row.finalWindow
            || !row.modeWindow
        ) return [];
        return [{
            dataset: datasetName(path),
            file: row.context.file,
            truthYear: row.truthYear,
            finalWindow: row.finalWindow,
            modeWindow: row.modeWindow,
            anchors: [
                row.currentPrimaryYear,
                row.selectedOperation?.bestYear,
                row.selectedOperation?.sideStepBestYear,
            ].filter(Number.isFinite),
            operationMargin:
                row.selectedOperation?.remoteDifferenceMargin ?? -Infinity,
            sideMargin:
                row.selectedOperation?.sideStepRemoteMargin ?? -Infinity,
        }];
    });
});

const recenter = (row, gate) => {
    const width = row.finalWindow.endYear - row.finalWindow.startYear + 1;
    if (!gate.widths.includes(width) || row.anchors.length < gate.minimumAnchors) {
        return row.finalWindow;
    }
    const center = (row.finalWindow.startYear + row.finalWindow.endYear) / 2;
    const target = median(row.anchors);
    const direction = Math.sign(target - center);
    const directionalVotes = row.anchors.filter((year) => (
        Math.sign(year - center) === direction
    )).length;
    if (
        direction === 0
        || directionalVotes < gate.minimumDirectionalVotes
        || Math.max(...row.anchors) - Math.min(...row.anchors) > gate.maximumSpread
        || row.operationMargin < gate.minimumOperationMargin
        || row.sideMargin < gate.minimumSideMargin
    ) return row.finalWindow;
    const shift = direction * Math.min(
        gate.maximumShift,
        Math.max(1, Math.round(Math.abs(target - center))),
    );
    let startYear = row.finalWindow.startYear + shift;
    startYear = Math.max(
        row.modeWindow.startYear,
        Math.min(startYear, row.modeWindow.endYear - width + 1),
    );
    return { startYear, endYear: startYear + width - 1 };
};

const metrics = (rows, gate) => {
    let oldHits = 0;
    let newHits = 0;
    let gains = 0;
    let losses = 0;
    let changes = 0;
    for (const row of rows) {
        const next = recenter(row, gate);
        const oldHit = contains(row.finalWindow, row.truthYear);
        const newHit = contains(next, row.truthYear);
        oldHits += Number(oldHit);
        newHits += Number(newHit);
        gains += Number(newHit && !oldHit);
        losses += Number(oldHit && !newHit);
        changes += Number(next.startYear !== row.finalWindow.startYear);
    }
    return { cases: rows.length, oldHits, newHits, gains, losses, changes };
};

const datasets = [...new Set(cases.map((row) => row.dataset))];
const candidates = [];
for (const widths of [[9], [5, 7, 9]]) {
    for (const maximumShift of [1, 2, 3]) {
        for (const minimumAnchors of [2, 3]) {
            for (const minimumDirectionalVotes of [1, 2, 3]) {
                for (const maximumSpread of [2, 4, 6, 10, Infinity]) {
                    for (const minimumOperationMargin of [-Infinity, 0, 0.05, 0.1]) {
                        for (const minimumSideMargin of [-Infinity, 0, 0.05, 0.1]) {
                            const gate = {
                                widths,
                                maximumShift,
                                minimumAnchors,
                                minimumDirectionalVotes,
                                maximumSpread,
                                minimumOperationMargin,
                                minimumSideMargin,
                            };
                            const byDataset = Object.fromEntries(datasets.map((name) => [
                                name,
                                metrics(cases.filter((row) => row.dataset === name), gate),
                            ]));
                            const total = metrics(cases, gate);
                            if (total.gains === 0) continue;
                            const datasetDeltas = Object.values(byDataset).map((result) => (
                                result.newHits - result.oldHits
                            ));
                            candidates.push({
                                gate,
                                total,
                                minimumDatasetDelta: Math.min(...datasetDeltas),
                                byDataset,
                            });
                        }
                    }
                }
            }
        }
    }
}

candidates.sort((left, right) => (
    right.minimumDatasetDelta - left.minimumDatasetDelta
    || (right.total.newHits - right.total.oldHits)
        - (left.total.newHits - left.total.oldHits)
    || left.total.losses - right.total.losses
    || left.total.changes - right.total.changes
));

console.log(JSON.stringify({
    cases: cases.length,
    datasets,
    selected: candidates.find((candidate) => (
        candidate.minimumDatasetDelta >= 0
    )) ?? null,
    preview: candidates.slice(0, 20),
}, null, 2));
