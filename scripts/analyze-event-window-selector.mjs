import { readFileSync } from "node:fs";

const args = new Map(process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    return separator < 0
        ? [argument.replace(/^--/, ""), "1"]
        : [argument.slice(0, separator).replace(/^--/, ""), argument.slice(separator + 1)];
}));

const markerJson = (path, marker) => {
    const text = readFileSync(path, "utf8");
    const start = text.indexOf(marker);
    if (start < 0) throw new Error(`Missing marker ${marker} in ${path}`);
    const line = text.slice(start + marker.length).split(/\r?\n/, 1)[0];
    return JSON.parse(line);
};

const pairedPath = args.get("paired-log");
const directPath = args.get("direct-log");
if (!pairedPath || !directPath) {
    throw new Error("Use --paired-log=<path> --direct-log=<path>");
}

const pairedRows = markerJson(pairedPath, "ITRDB PAIRED BREAKPOINT ");
const directRows = markerJson(directPath, "ITRDB DIRECT TRANSITION ");
const keyFor = (row) => `${row.file}\u0000${row.target}\u0000${row.eventType}`;
const directByKey = new Map(directRows
    .filter((row) => row.caseType === "injected")
    .map((row) => [keyFor(row), row]));

const sourceNames = [
    "currentCenter",
    "currentTop",
    "direct",
    "pairDifference",
    "pairWhitened",
    "pairStandardized",
    "pairComboFull",
    "pairCombo31",
    "pairStandardHuber",
    "pairHuberCombo",
    "nominal",
    "profile",
    "scan",
    "rawPath",
    "candidate",
    "pairedSelected",
];

const noteNumber = (notes, prefix) => {
    const note = notes.find((value) => value.startsWith(prefix));
    if (!note) return null;
    const value = Number(note.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

const buildCase = (paired) => {
    const direct = directByKey.get(keyFor(paired));
    if (!direct || paired.truthYear === null || !paired.current) return null;
    const locations = [];
    const candidates = new Map();
    const add = (year, source, score = 0, margin = 0) => {
        if (!Number.isFinite(year)) return;
        const rounded = Math.round(year);
        locations.push({ year: rounded, source });
        const candidate = candidates.get(rounded) ?? {
            year: rounded,
            sources: new Set(),
            scores: new Map(),
            margins: new Map(),
        };
        candidate.sources.add(source);
        candidate.scores.set(source, Number.isFinite(score) ? score : 0);
        candidate.margins.set(source, Number.isFinite(margin) ? margin : 0);
        candidates.set(rounded, candidate);
    };

    const currentCenter = Math.round((paired.current.range[0] + paired.current.range[1]) / 2);
    add(currentCenter, "currentCenter", paired.current.score, paired.current.margin);
    add(paired.current.topYear, "currentTop", paired.current.score, paired.current.margin);
    add(direct.direct?.topYear, "direct", direct.direct?.gain, direct.direct?.margin);
    add(
        paired.tops.differenceFull?.year,
        "pairDifference",
        paired.tops.differenceFull?.score,
        paired.tops.differenceFull?.remoteMargin,
    );
    add(
        paired.tops.whitenedFull?.year,
        "pairWhitened",
        paired.tops.whitenedFull?.score,
        paired.tops.whitenedFull?.remoteMargin,
    );
    add(
        paired.tops.standardizedFull?.year,
        "pairStandardized",
        paired.tops.standardizedFull?.score,
        paired.tops.standardizedFull?.remoteMargin,
    );
    add(
        paired.tops.comboFull?.year,
        "pairComboFull",
        paired.tops.comboFull?.score,
        paired.tops.comboFull?.remoteMargin,
    );
    add(
        paired.tops.combo31?.year,
        "pairCombo31",
        paired.tops.combo31?.score,
        paired.tops.combo31?.remoteMargin,
    );
    add(
        paired.tops.standardizedHuberFull?.year,
        "pairStandardHuber",
        paired.tops.standardizedHuberFull?.score,
        paired.tops.standardizedHuberFull?.remoteMargin,
    );
    add(
        paired.tops.huberComboFull?.year,
        "pairHuberCombo",
        paired.tops.huberComboFull?.score,
        paired.tops.huberComboFull?.remoteMargin,
    );
    const notes = paired.current.notes ?? [];
    add(noteNumber(notes, "nominal_boundary_year="), "nominal");
    add(noteNumber(notes, "profile_boundary_year="), "profile");
    add(noteNumber(notes, "scan_top_year="), "scan");
    add(noteNumber(notes, "raw_path_top_year="), "rawPath");
    add(noteNumber(notes, "candidate_top_year="), "candidate");
    add(noteNumber(notes, "paired_core_selected_year="), "pairedSelected");

    const allYears = locations.map((row) => row.year).sort((a, b) => a - b);
    const medianYear = allYears[Math.floor((allYears.length - 1) / 2)] ?? currentCenter;
    const directYear = direct.direct?.topYear ?? currentCenter;
    const confidence = paired.current.confidence;
    const currentSourceFlags = [
        "reference_core_voting",
        "paired_core_counterfactual_year",
        "candidate_ranking",
        "joint_event_counterfactual",
    ].map((source) => paired.current.sources.includes(source) ? 1 : 0);

    const rows = [...candidates.values()].map((candidate) => {
        const support = (radius) => locations.filter((row) => (
            Math.abs(row.year - candidate.year) <= radius
        )).length / Math.max(1, locations.length);
        const sourceFeatures = sourceNames.map((source) => candidate.sources.has(source) ? 1 : 0);
        const sourceScore = (source, scale = 1) => (
            (candidate.scores.get(source) ?? 0) / scale
        );
        const sourceMargin = (source, scale = 1) => (
            (candidate.margins.get(source) ?? 0) / scale
        );
        const isCurrent = Number(candidate.sources.has("currentCenter") || candidate.sources.has("currentTop"));
        const isPaired = Number([...candidate.sources].some((source) => source.startsWith("pair")));
        return {
            year: candidate.year,
            features: [
                ...sourceFeatures,
                support(0),
                support(1),
                support(3),
                support(5),
                -Math.abs(candidate.year - currentCenter) / 20,
                (candidate.year - currentCenter) / 20,
                -Math.abs(candidate.year - directYear) / 20,
                -Math.abs(candidate.year - medianYear) / 20,
                isCurrent * paired.current.score / 20,
                isCurrent * paired.current.margin / 5,
                isCurrent * Number(confidence === "high"),
                isCurrent * Number(confidence === "medium"),
                isCurrent * Number(confidence === "low"),
                ...currentSourceFlags.map((value) => value * isCurrent),
                sourceScore("direct", 20),
                sourceMargin("direct"),
                sourceScore("pairDifference"),
                sourceMargin("pairDifference"),
                sourceScore("pairWhitened"),
                sourceMargin("pairWhitened"),
                sourceScore("pairStandardized"),
                sourceMargin("pairStandardized"),
                sourceScore("pairComboFull"),
                sourceMargin("pairComboFull"),
                sourceScore("pairCombo31"),
                sourceMargin("pairCombo31"),
                sourceScore("pairStandardHuber"),
                sourceMargin("pairStandardHuber"),
                sourceScore("pairHuberCombo"),
                sourceMargin("pairHuberCombo"),
                isPaired * paired.referenceCount / 4,
            ],
        };
    });
    return {
        file: paired.file,
        target: paired.target,
        eventType: paired.eventType,
        truthYear: paired.truthYear,
        currentCenter,
        rows,
    };
};

const cases = pairedRows
    .filter((row) => row.caseType === "injected")
    .map(buildCase)
    .filter(Boolean);
const featureCount = cases[0]?.rows[0]?.features.length ?? 0;
const dot = (features, weights) => features.reduce(
    (sum, value, index) => sum + value * weights[index],
    0,
);
const foldFor = (file) => {
    let hash = 2166136261;
    for (const character of file) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash) % 5;
};

const fit = (training, regularization, learningRate) => {
    const weights = new Array(featureCount).fill(0);
    for (let iteration = 0; iteration < 1200; iteration += 1) {
        const gradient = weights.map((weight) => regularization * weight / Math.max(1, training.length));
        training.forEach((rankCase) => {
            const distances = rankCase.rows.map((row) => Math.abs(row.year - rankCase.truthYear));
            const eligible = distances.map((distance) => distance <= 3 ? Math.exp(-distance) : 0);
            const targetTotal = eligible.reduce((sum, value) => sum + value, 0);
            if (targetTotal <= 0) return;
            const logits = rankCase.rows.map((row) => dot(row.features, weights));
            const maximum = Math.max(...logits);
            const exponentials = logits.map((value) => Math.exp(value - maximum));
            const total = exponentials.reduce((sum, value) => sum + value, 0);
            rankCase.rows.forEach((row, rowIndex) => {
                const error = exponentials[rowIndex] / total - eligible[rowIndex] / targetTotal;
                row.features.forEach((value, featureIndex) => {
                    gradient[featureIndex] += error * value / training.length;
                });
            });
        });
        weights.forEach((weight, index) => {
            weights[index] = weight - learningRate * gradient[index];
        });
    }
    return weights;
};

const evaluate = (evaluationCases, weights, gate) => {
    let hits = 0;
    let exact = 0;
    let withinOne = 0;
    let switched = 0;
    let gained = 0;
    let lost = 0;
    evaluationCases.forEach((rankCase) => {
        const ranked = rankCase.rows
            .map((row) => ({ ...row, score: dot(row.features, weights) }))
            .sort((a, b) => b.score - a.score || b.year - a.year);
        const proposed = ranked[0];
        const margin = proposed.score - (ranked[1]?.score ?? proposed.score);
        const useProposed = proposed.year !== rankCase.currentCenter
            && margin >= gate.minMargin
            && Math.abs(proposed.year - rankCase.currentCenter) <= gate.maxDistance;
        const selectedYear = useProposed ? proposed.year : rankCase.currentCenter;
        if (useProposed) switched += 1;
        const baselineHit = Math.abs(rankCase.currentCenter - rankCase.truthYear) <= 3;
        const selectedHit = Math.abs(selectedYear - rankCase.truthYear) <= 3;
        if (selectedHit) hits += 1;
        if (selectedYear === rankCase.truthYear) exact += 1;
        if (Math.abs(selectedYear - rankCase.truthYear) <= 1) withinOne += 1;
        if (!baselineHit && selectedHit) gained += 1;
        if (baselineHit && !selectedHit) lost += 1;
    });
    return { cases: evaluationCases.length, hits, exact, withinOne, switched, gained, lost };
};

const regularizations = [0.03, 0.1, 0.3, 1, 3, 10];
const learningRates = [0.01, 0.03, 0.08];
const gates = [0, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5].flatMap((minMargin) => (
    [4, 6, 10, 15, 25, 50, Infinity].map((maxDistance) => ({ minMargin, maxDistance }))
));

const runType = (eventType) => {
    const typed = cases.filter((rankCase) => rankCase.eventType === eventType);
    const baseline = evaluate(typed, new Array(featureCount).fill(0), {
        minMargin: Infinity,
        maxDistance: 0,
    });
    const configurations = [];
    regularizations.forEach((regularization) => {
        learningRates.forEach((learningRate) => {
            const foldPredictions = [];
            for (let fold = 0; fold < 5; fold += 1) {
                const training = typed.filter((rankCase) => foldFor(rankCase.file) !== fold);
                const validation = typed.filter((rankCase) => foldFor(rankCase.file) === fold);
                const weights = fit(training, regularization, learningRate);
                foldPredictions.push({ validation, weights });
            }
            gates.forEach((gate) => {
                const aggregate = { cases: 0, hits: 0, exact: 0, withinOne: 0, switched: 0, gained: 0, lost: 0 };
                foldPredictions.forEach(({ validation, weights }) => {
                    const metrics = evaluate(validation, weights, gate);
                    Object.keys(aggregate).forEach((key) => { aggregate[key] += metrics[key]; });
                });
                configurations.push({ regularization, learningRate, ...gate, ...aggregate });
            });
        });
    });
    configurations.sort((a, b) => (
        b.hits - a.hits
        || b.exact - a.exact
        || b.withinOne - a.withinOne
        || a.lost - b.lost
        || a.switched - b.switched
        || b.regularization - a.regularization
    ));
    const selected = configurations[0];
    const weights = fit(typed, selected.regularization, selected.learningRate);
    return {
        eventType,
        baseline,
        selected,
        alternatives: configurations.slice(0, 20),
        fitted: evaluate(typed, weights, selected),
        weights,
    };
};

const report = {
    featureCount,
    sourceNames,
    missingRing: runType("missingRing"),
    falseRing: runType("falseRing"),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
