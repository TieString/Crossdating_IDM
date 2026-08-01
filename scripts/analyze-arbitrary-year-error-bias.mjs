import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    throw new Error(
        "Usage: node scripts/analyze-arbitrary-year-error-bias.mjs <rank-data.json> [...]",
    );
}

const correctionOptions = [-2, -1, 0, 1, 2];
const rows = [];

for (const path of paths) {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (payload.sampling !== "calendar-position-stratified-signal-independent") {
        throw new Error(`${path} does not use signal-independent sampling.`);
    }
    for (const rankCase of payload.cases) {
        if (!Number.isFinite(rankCase.currentTopYear)) continue;
        const signal = Number(rankCase.context.signalStrength);
        rows.push({
            offset: payload.offset,
            eventType: rankCase.eventType,
            error: rankCase.currentTopYear - rankCase.truthYear,
            position: rankCase.context.positionStratum,
            signalTier: !Number.isFinite(signal)
                ? "unavailable"
                : signal < 0.3
                    ? "weak"
                    : signal < 0.6
                        ? "medium"
                        : "strong",
            shiftDirection: rankCase.eventType === "partialMove"
                ? Math.sign(rankCase.currentShiftYears ?? 0)
                : 0,
        });
    }
}

const metrics = (group, correction = 0) => {
    const corrected = group.map((row) => row.error + correction);
    const ordered = [...corrected].sort((left, right) => left - right);
    const histogram = Object.fromEntries(
        [...new Set(ordered)].map((error) => [
            error,
            ordered.filter((value) => value === error).length,
        ]),
    );
    return {
        cases: group.length,
        correction,
        exact: corrected.filter((error) => error === 0).length / Math.max(1, group.length),
        withinOne: corrected.filter((error) => Math.abs(error) <= 1).length
            / Math.max(1, group.length),
        meanAbsoluteError: corrected.reduce(
            (sum, error) => sum + Math.abs(error),
            0,
        ) / Math.max(1, group.length),
        medianError: ordered[Math.floor((ordered.length - 1) / 2)] ?? 0,
        histogram,
    };
};

const chooseCorrection = (group) => correctionOptions
    .map((correction) => metrics(group, correction))
    .sort((left, right) => (
        right.exact - left.exact
        || right.withinOne - left.withinOne
        || left.meanAbsoluteError - right.meanAbsoluteError
        || Math.abs(left.correction) - Math.abs(right.correction)
    ))[0];

const crossValidate = (group) => {
    const offsets = [...new Set(group.map((row) => row.offset))].sort(
        (left, right) => left - right,
    );
    const heldOutRows = [];
    const folds = offsets.map((heldOutOffset) => {
        const training = group.filter((row) => row.offset !== heldOutOffset);
        const validation = group.filter((row) => row.offset === heldOutOffset);
        const selected = chooseCorrection(training);
        heldOutRows.push(...validation.map((row) => ({
            ...row,
            error: row.error + selected.correction,
        })));
        return {
            heldOutOffset,
            trainingCases: training.length,
            validationCases: validation.length,
            correction: selected.correction,
        };
    });
    return {
        metrics: metrics(heldOutRows),
        folds,
    };
};

const summarize = (group) => ({
    baseline: metrics(group),
    bestInSample: chooseCorrection(group),
    leaveOneOffsetOut: crossValidate(group),
});

const eventTypes = ["missingRing", "falseRing", "partialMove"];
const positions = [
    "olderEdge",
    "olderInterior",
    "middle",
    "newerInterior",
    "newerEdge",
];
const signalTiers = ["weak", "medium", "strong", "unavailable"];

const report = {
    offsets: [...new Set(rows.map((row) => row.offset))].sort(
        (left, right) => left - right,
    ),
    cases: rows.length,
    byEventType: Object.fromEntries(eventTypes.map((eventType) => [
        eventType,
        summarize(rows.filter((row) => row.eventType === eventType)),
    ])),
    byEventAndPosition: Object.fromEntries(eventTypes.flatMap((eventType) => (
        positions.map((position) => {
            const group = rows.filter((row) => (
                row.eventType === eventType && row.position === position
            ));
            return [`${eventType}:${position}`, summarize(group)];
        })
    ))),
    byEventAndSignal: Object.fromEntries(eventTypes.flatMap((eventType) => (
        signalTiers
            .map((signalTier) => {
                const group = rows.filter((row) => (
                    row.eventType === eventType && row.signalTier === signalTier
                ));
                return [`${eventType}:${signalTier}`, summarize(group)];
            })
            .filter(([, summary]) => summary.baseline.cases > 0)
    ))),
    partialByDirection: Object.fromEntries([-1, 1].map((shiftDirection) => [
        String(shiftDirection),
        summarize(rows.filter((row) => (
            row.eventType === "partialMove"
            && row.shiftDirection === shiftDirection
        ))),
    ])),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
