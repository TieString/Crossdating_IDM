import fs from "node:fs";

const paths = process.argv.slice(2);
const requestedFamily = process.env.MODE_FAMILY ?? "aggregate";
const requestedRule = process.env.MODE_RULE_SCOPE;
const includeRows = process.env.MODE_INCLUDE_ROWS === "1";
const requireCoarseHit = process.env.MODE_REQUIRE_COARSE_HIT !== "0";
const requireZeroDevelopmentLoss =
    process.env.MODE_REQUIRE_ZERO_DEVELOPMENT_LOSS === "1";
const searchScope = process.env.MODE_SEARCH_SCOPE ?? "coarse";
if (paths.length === 0) {
    throw new Error("pass one or more locator audit JSON paths");
}

const FAMILY_PROFILES = {
    cumulative: [
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeReferenceMean",
        "cumulativeReferenceMedian",
        "cumulativeReferenceVote",
    ],
    transition: [
        "piecewiseCombinedObjective",
        "transitionSplitGain",
    ],
    pair: [
        "pairDifferenceWeighted",
        "pairWhitenedMean",
        "pairPeakKernel5",
        "pairPeakKernel9",
    ],
    localSide: [
        "localSideOlderAdvantage11",
        "localSideNewerAdvantage11",
        "localSideStepScore11",
        "localSideOlderAdvantage21",
        "localSideNewerAdvantage21",
        "localSideStepScore21",
        "localSideOlderAdvantage31",
        "localSideNewerAdvantage31",
        "localSideStepScore31",
    ],
    reference: [
        "reference:rankMean",
        "reference:rankMedian",
        "reference:weightedRankMean",
        "reference:peakKernel5",
        "reference:peakKernel9",
        "reference:peakKernel13",
        "reference:windowVote25",
        "reference:weightedWindowVote25",
    ],
};
const requestedProfiles = (process.env.MODE_PROFILES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
if (requestedProfiles.length > 0) {
    FAMILY_PROFILES.custom = requestedProfiles;
}

const datasetName = (path) => {
    const name = path.toLowerCase();
    if (name.includes("current-train31")) return "train31";
    if (name.includes("current-train47")) return "train47";
    if (name.includes("current-calibration31")) return "cal31";
    if (name.includes("current-calibration47")) return "cal47";
    if (name.includes("train-offset31")) return "train31";
    if (name.includes("train-offset47")) return "train47";
    if (name.includes("calibration-offset31")) return "cal31";
    if (name.includes("calibration-offset47")) return "cal47";
    if (name.includes("holdout-v2")) return "holdout2";
    if (name.includes("holdout-v3")) return "holdout3";
    if (name.includes("holdout-v4")) return "holdout4";
    if (name.includes("holdout-v5")) return "holdout5";
    if (name.includes("holdout-v6")) return "holdout6";
    if (name.includes("holdout-v7")) return "holdout7";
    if (name.includes("holdout-v9")) return "holdout9";
    if (name.includes("holdout-v10")) return "holdout10";
    if (name.includes("train0")) return "train0";
    if (name.includes("train8")) return "train8";
    if (name.includes("cal0")) return "cal0";
    if (name.includes("cal1")) return "cal1";
    if (name.includes("reserved")) return "reserved";
    if (name.includes("validation")) return "validation";
    return name;
};

const normalize = (values) => {
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const span = maximum - minimum;
    if (span <= 1e-12) return values.map(() => 0);
    return values.map((value) => (value - minimum) / span);
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0)
    / Math.max(1, values.length);

const median = (values) => {
    const sorted = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const contains = (window, year) => (
    year >= window.startYear && year <= window.endYear
);

const prepare = (row, dataset) => {
    const starts = [];
    const searchWindow = searchScope === "series"
        ? {
                startYear: row.years[0],
                endYear: row.years[row.years.length - 1],
            }
        : row.coarseWindow;
    for (
        let start = searchWindow.startYear;
        start <= searchWindow.endYear - 12;
        start += 1
    ) starts.push(start);
    if (starts.length === 0) return null;
    const indexByYear = new Map(row.years.map((year, index) => [year, index]));
    const familyCurves = Object.entries(FAMILY_PROFILES).flatMap(([
        family,
        profileNames,
    ]) => {
        const curves = profileNames.flatMap((profileName) => {
            const profile = row.ranks[profileName];
            if (!profile) return [];
            const masses = starts.map((start) => {
                let total = 0;
                for (let year = start; year < start + 13; year += 1) {
                    total += profile[indexByYear.get(year)] ?? 0;
                }
                return total;
            });
            return [normalize(masses)];
        });
        if (curves.length === 0) return [];
        return [{
            family,
            values: starts.map((_, index) => mean(
                curves.map((curve) => curve[index]),
            )),
            memberBestIndexes: curves.map((curve) => (
                curve.reduce((best, value, index) => (
                    value > curve[best] ? index : best
                ), 0)
            )),
        }];
    });
    if (familyCurves.length < 3) return null;
    const aggregate = starts.map((_, index) => median(
        familyCurves.map((curve) => curve.values[index]),
    ));
    const selectedFamily = familyCurves.find((curve) => (
        curve.family === requestedFamily
    ));
    const selectedCurve = selectedFamily?.values ?? aggregate;
    const selectedIndex = selectedCurve.reduce((best, value, index) => (
        value > selectedCurve[best] ? index : best
    ), 0);
    const modeStart = row.modeWindow.startYear;
    const currentIndex = starts.reduce((best, start, index) => (
        Math.abs(start - modeStart) < Math.abs(starts[best] - modeStart)
            ? index
            : best
    ), 0);
    const familyBestIndexes = selectedFamily?.memberBestIndexes
        ?? familyCurves.map((curve) => (
            curve.values.reduce((best, value, index) => (
                value > curve.values[best] ? index : best
            ), 0)
        ));
    const selectedStart = starts[selectedIndex];
    const selectedCenter = selectedStart + 6;
    const currentCenter = starts[currentIndex] + 6;
    const currentPrimaryYear = row.currentPrimaryYear;
    const selectedWindow = {
        startYear: selectedStart,
        endYear: selectedStart + 12,
    };
    const oldHit = contains(row.modeWindow, row.truthYear);
    const newHit = contains(selectedWindow, row.truthYear);
    return {
        dataset,
        method: requestedFamily,
        eventType: row.eventType,
        file: row.context.file,
        truthYear: row.truthYear,
        oldWindow: row.modeWindow,
        selectedWindow,
        oldHit,
        newHit,
        distance: Math.abs(selectedStart - modeStart),
        gain: selectedCurve[selectedIndex] - selectedCurve[currentIndex],
        votes: familyBestIndexes.filter((index) => (
            Math.abs(starts[index] - selectedStart) <= 2
        )).length,
        spread: Math.max(...familyBestIndexes.map((index) => starts[index]))
            - Math.min(...familyBestIndexes.map((index) => starts[index])),
        currentAnchorAdvantage: currentPrimaryYear === undefined
            ? Number.NEGATIVE_INFINITY
            : Math.abs(currentCenter - currentPrimaryYear)
                - Math.abs(selectedCenter - currentPrimaryYear),
    };
};

const cases = paths.flatMap((path) => {
    const payload = JSON.parse(fs.readFileSync(path, "utf8"));
    const dataset = datasetName(path);
    return payload.counterfactualLocatorCases
        .filter((row) => (
            !row.context.baselineFlagged
            && row.finalWindow
            && (!requireCoarseHit || contains(row.coarseWindow, row.truthYear))
            && (row.eventType === "missingRing" || row.eventType === "falseRing")
            && (!requestedRule || row.windowCenteringRule === requestedRule)
        ))
        .flatMap((row) => prepare(row, dataset) ?? []);
});

const metrics = (rows, gate) => {
    let oldHits = 0;
    let newHits = 0;
    let gains = 0;
    let losses = 0;
    let changes = 0;
    for (const row of rows) {
        const use = row.distance >= gate.minimumDistance
            && row.gain >= gate.minimumGain
            && row.votes >= gate.minimumVotes
            && row.spread <= gate.maximumSpread
            && row.currentAnchorAdvantage
                >= gate.minimumCurrentAnchorAdvantage;
        const hit = use ? row.newHit : row.oldHit;
        oldHits += Number(row.oldHit);
        newHits += Number(hit);
        gains += Number(use && row.newHit && !row.oldHit);
        losses += Number(use && row.oldHit && !row.newHit);
        changes += Number(use);
    }
    return { cases: rows.length, oldHits, newHits, gains, losses, changes };
};

const reports = [];
for (const eventType of ["missingRing", "falseRing"]) {
    const typed = cases.filter((row) => row.eventType === eventType);
    const developmentNames = (
        process.env.MODE_DEVELOPMENT_DATASETS
            ?.split(",")
            .map((name) => name.trim())
            .filter(Boolean)
        ?? ["train0", "train8", "cal0", "cal1"]
    );
    const evaluationNames = (
        process.env.MODE_EVALUATION_DATASETS
            ?.split(",")
            .map((name) => name.trim())
            .filter(Boolean)
        ?? ["validation", "reserved"]
    );
    const candidates = [];
    for (const minimumDistance of [1, 2, 3, 4, 5, 7, 9]) {
        for (const minimumGain of [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3]) {
            for (const minimumVotes of [1, 2, 3, 4]) {
                for (const maximumSpread of [4, 8, 12, 20, 40, Infinity]) {
                    for (const minimumCurrentAnchorAdvantage of [
                        Number.NEGATIVE_INFINITY,
                        -2,
                        0,
                        1,
                        2,
                    ]) {
                    const gate = {
                        minimumDistance,
                        minimumGain,
                        minimumVotes,
                        maximumSpread,
                        minimumCurrentAnchorAdvantage,
                    };
                    const byDevelopment = developmentNames.map((name) => (
                        metrics(typed.filter((row) => row.dataset === name), gate)
                    ));
                    if (byDevelopment.some((result) => (
                        result.newHits < result.oldHits
                        || (
                            requireZeroDevelopmentLoss
                            && result.losses > 0
                        )
                    ))) continue;
                    const development = metrics(typed.filter((row) => (
                        developmentNames.includes(row.dataset)
                    )), gate);
                    if (development.gains === 0) continue;
                    candidates.push({ gate, development, byDevelopment });
                    }
                }
            }
        }
    }
    candidates.sort((left, right) => (
        (right.development.newHits - right.development.oldHits)
        - (left.development.newHits - left.development.oldHits)
        || left.development.losses - right.development.losses
        || left.development.changes - right.development.changes
    ));
    const selected = candidates[0];
    reports.push({
        eventType,
        method: requestedFamily,
        selected,
        candidatePreview: candidates.slice(0, 20).map((candidate) => ({
            ...candidate,
            evaluation: Object.fromEntries(evaluationNames.map((name) => [
                name,
                metrics(
                    typed.filter((row) => row.dataset === name),
                    candidate.gate,
                ),
            ])),
        })),
        probes: [
            {
                minimumDistance: 2,
                minimumGain: 0,
                minimumVotes: 1,
                maximumSpread: 8,
                minimumCurrentAnchorAdvantage: -2,
            },
            {
                minimumDistance: 5,
                minimumGain: 0.10,
                minimumVotes: 4,
                maximumSpread: 3,
                minimumCurrentAnchorAdvantage: Number.NEGATIVE_INFINITY,
            },
            {
                minimumDistance: 4,
                minimumGain: 0.15,
                minimumVotes: 3,
                maximumSpread: 6,
                minimumCurrentAnchorAdvantage: Number.NEGATIVE_INFINITY,
            },
        ].map((gate) => ({
            gate,
            datasets: Object.fromEntries([
                ...developmentNames,
                ...evaluationNames,
            ].map((name) => [
                name,
                metrics(typed.filter((row) => row.dataset === name), gate),
            ])),
        })),
        datasets: Object.fromEntries([
            ...developmentNames,
            ...evaluationNames,
        ].map((name) => [
            name,
            selected
                ? metrics(
                    typed.filter((row) => row.dataset === name),
                    selected.gate,
                )
                : null,
        ])),
        changes: includeRows && selected ? typed.filter((row) => (
            row.distance >= selected.gate.minimumDistance
            && row.gain >= selected.gate.minimumGain
            && row.votes >= selected.gate.minimumVotes
            && row.spread <= selected.gate.maximumSpread
            && row.currentAnchorAdvantage
                >= selected.gate.minimumCurrentAnchorAdvantage
        )) : [],
        allRows: includeRows ? typed : [],
        currentModeMisses: includeRows
            ? typed.filter((row) => !row.oldHit)
            : [],
    });
}

const payload = { reports };
if (process.env.MODE_OUTPUT) {
    fs.writeFileSync(process.env.MODE_OUTPUT, JSON.stringify(payload, null, 2));
    console.log(JSON.stringify({
        output: process.env.MODE_OUTPUT,
        selected: reports.map((report) => ({
            eventType: report.eventType,
            method: report.method,
            selected: report.selected,
            datasets: report.datasets,
        })),
    }, null, 2));
} else {
    console.log(JSON.stringify(payload, null, 2));
}
