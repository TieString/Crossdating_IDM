import { readFileSync } from "node:fs";

const controlDir = process.argv[2];
const candidateDir = process.argv[3];
const offsets = (process.argv[4] ?? "0-12").split(",").flatMap((part) => {
    const match = /^(-?\d+)-(-?\d+)$/.exec(part);
    if (!match) return [Number(part)];
    const start = Number(match[1]);
    const end = Number(match[2]);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
});

if (!controlDir || !candidateDir) {
    throw new Error(
        "usage: node tools/analyze_single_window_expansion.mjs "
        + "<control-dir> <candidate-dir> [offsets]",
    );
}

const keyForOutcome = (outcome) => [
    outcome.context.file,
    outcome.context.target,
    outcome.eventType,
].join("|");

const keyForRanking = (ranking) => [
    ranking.groupId,
    ranking.seriesId,
    ranking.eventType,
].join("|");

const noteValue = (notes, prefix) => {
    const note = notes?.find((value) => value.startsWith(`${prefix}=`));
    return note?.slice(prefix.length + 1) ?? null;
};

const parseRange = (value) => {
    const match = /^(-?\d+)-(-?\d+)$/.exec(value ?? "");
    return match ? [Number(match[1]), Number(match[2])] : null;
};

const rows = [];
for (const offset of offsets) {
    const name = `offset-${offset}-cases-25.json`;
    const control = JSON.parse(readFileSync(`${controlDir}/${name}`, "utf8"));
    const candidate = JSON.parse(readFileSync(`${candidateDir}/${name}`, "utf8"));
    const controlByKey = new Map(
        control.eventCaseOutcomes.map((outcome) => [keyForOutcome(outcome), outcome]),
    );
    const rankingByKey = new Map(
        candidate.rankingCases.map((ranking) => [keyForRanking(ranking), ranking]),
    );
    candidate.eventCaseOutcomes
        .filter(({ eventType }) => (
            eventType === "missingRing" || eventType === "falseRing"
        ))
        .forEach((outcome) => {
            const key = keyForOutcome(outcome);
            const ranking = rankingByKey.get(key);
            const controlOutcome = controlByKey.get(key);
            const core = parseRange(noteValue(
                ranking?.notes,
                "endpoint_residual_core_range",
            ));
            const finalRange = outcome.primaryPredictionRange;
            if (!ranking || !controlOutcome || !core || !finalRange) return;
            if (finalRange[1] - finalRange[0] === core[1] - core[0]) return;
            const addedYear = finalRange[0] < core[0]
                ? finalRange[0]
                : finalRange[1];
            const controlRange = controlOutcome.primaryPredictionRange;
            const posteriorTop = Number(noteValue(
                ranking.notes,
                "endpoint_residual_posterior_top_year",
            ));
            rows.push({
                offset,
                eventType: outcome.eventType,
                gained: outcome.context.year === addedYear,
                addedYear,
                controlContainsAdded: Boolean(
                    controlRange
                    && addedYear >= controlRange[0]
                    && addedYear <= controlRange[1],
                ),
                controlTopDistance: Math.abs(
                    (controlOutcome.primaryPredictionTopYear ?? 99999) - addedYear,
                ),
                posteriorTopDistance: Math.abs(posteriorTop - addedYear),
                fusedTopDistance: Math.abs(
                    (outcome.primaryPredictionTopYear ?? 99999) - addedYear,
                ),
                addedRank: ranking.rankedYears.findIndex(
                    ({ year }) => year === addedYear,
                ) + 1,
                windowMass: Number(noteValue(
                    ranking.notes,
                    "endpoint_residual_window_mass",
                )),
                referenceCount: Number(noteValue(
                    ranking.notes,
                    "endpoint_residual_reference_count",
                )),
                confidence: ranking.confidence,
                centerDelta: controlRange
                    ? Math.abs(
                        (controlRange[0] + controlRange[1] - core[0] - core[1]) / 2,
                    )
                    : 99,
            });
        });
}

const group = (eventType, label, predicate) => {
    const typeRows = rows.filter((row) => row.eventType === eventType);
    const selected = typeRows.filter(predicate);
    const gains = selected.filter((row) => row.gained).length;
    const allGains = typeRows.filter((row) => row.gained).length;
    return {
        label,
        selected: selected.length,
        gains,
        precision: selected.length > 0 ? gains / selected.length : 0,
        gainRecall: allGains > 0 ? gains / allGains : 0,
    };
};

const report = {};
for (const eventType of ["missingRing", "falseRing"]) {
    const typeRows = rows.filter((row) => row.eventType === eventType);
    report[eventType] = {
        expanded: typeRows.length,
        gains: typeRows.filter((row) => row.gained).length,
        groups: [
            group(eventType, "controlContainsAdded", (row) => row.controlContainsAdded),
            group(eventType, "controlTopDistance<=1", (row) => row.controlTopDistance <= 1),
            group(eventType, "controlTopDistance<=2", (row) => row.controlTopDistance <= 2),
            group(eventType, "posteriorTopDistance<=2", (row) => (
                row.posteriorTopDistance <= 2
            )),
            group(eventType, "posteriorTopDistance<=3", (row) => (
                row.posteriorTopDistance <= 3
            )),
            group(eventType, "fusedTopDistance<=2", (row) => row.fusedTopDistance <= 2),
            group(eventType, "addedRank<=4", (row) => row.addedRank <= 4),
            group(eventType, "windowMass>=0.03", (row) => row.windowMass >= 0.03),
            group(eventType, "windowMass>=0.05", (row) => row.windowMass >= 0.05),
            group(eventType, "referenceCount>=16", (row) => row.referenceCount >= 16),
            group(eventType, "centerDelta>=1", (row) => row.centerDelta >= 1),
            group(eventType, "centerDelta>=2", (row) => row.centerDelta >= 2),
        ],
    };
}

console.log(JSON.stringify(report, null, 2));
