import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = "") => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const rowsPath = resolve(valueFor("--rows"));
const outputPath = resolve(valueFor("--output"));
const minimumFamilySupport = Number(valueFor("--minimum-family-support", "0"));
const minimumSupportMargin = Number(valueFor("--minimum-support-margin", "0"));
const rows = JSON.parse(readFileSync(rowsPath, "utf8"));

const PATH_FAMILIES = {
    boundedRegular: [
        "boundedRawPath",
        "boundedRawPathPenalty2",
        "boundedRawPathPenalty1",
        "boundedRawPathPenalty05",
        "boundedRawPathPenalty025",
    ],
    boundedMax6: ["boundedRawPathPenalty1Max6", "boundedRawPathPenalty05Max6"],
    zeroTerminal: [
        "boundedRawPathZeroTerminal",
        "boundedRawPathPenalty1ZeroTerminal",
        "boundedRawPathPenalty05ZeroTerminal",
    ],
    unitPulse: ["boundedRawUnitPulsePenalty1", "boundedRawUnitPulsePenalty05"],
    nearPath: [
        "boundedRawNearSinglePenalty2",
        "boundedRawNearPathPenalty2",
        "boundedRawNearPathPenalty1",
    ],
    cofechaBounded: ["boundedCofechaPath"],
    rawDirect: ["rawPathEvents"],
    cofechaDirect: ["cofechaPathEvents"],
};

const shiftFor = (event) => {
    const eventType = event?.eventType ?? event?.operationType;
    if (eventType === "missingRing") return -1;
    if (eventType === "falseRing") return 1;
    const shift = Number(event?.shiftYears);
    return Number.isFinite(shift) ? shift : null;
};
const topYear = (event) => {
    const year = Number(
        event?.topYear
        ?? event?.bestYear
        ?? event?.targetYear
        ?? event?.rankedYears?.[0]?.year,
    );
    if (Number.isFinite(year)) return year;
    const start = Number(event?.startYear);
    const end = Number(event?.endYear);
    return Number.isFinite(start) && Number.isFinite(end) ? (start + end) / 2 : null;
};
const localEvent = (event) => ["missingRing", "falseRing", "partialMove"].includes(
    event?.eventType ?? event?.operationType,
);
const identityKey = (event) => `${event.eventType ?? event.operationType}:${shiftFor(event)}`;
const eventsForView = (grid, view) => {
    const value = grid?.[view];
    if (view === "rawPathEvents" || view === "cofechaPathEvents") {
        return Array.isArray(value) ? value : [];
    }
    return value?.events ?? [];
};
const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
};

const familyFrontiers = (grid) => Object.entries(PATH_FAMILIES).flatMap(
    ([family, views]) => {
        const candidates = views.flatMap((view) => {
            const events = eventsForView(grid, view)
                .filter(localEvent)
                .filter((event) => topYear(event) !== null);
            if (events.length === 0) return [];
            const newestYear = Math.max(...events.map(topYear));
            return events.filter((event) => topYear(event) === newestYear)
                .map((event) => ({ family, view, event, year: newestYear }));
        });
        const unique = new Map();
        candidates.forEach((candidate) => {
            const key = `${family}:${identityKey(candidate.event)}:${candidate.year}`;
            if (!unique.has(key)) unique.set(key, candidate);
        });
        return [...unique.values()];
    },
);

const consensusCandidate = (grid) => {
    const frontiers = familyFrontiers(grid);
    const clusters = [];
    [...frontiers].sort((left, right) => right.year - left.year).forEach((candidate) => {
        const key = identityKey(candidate.event);
        const cluster = clusters.find((current) => (
            current.identity === key && Math.abs(current.center - candidate.year) <= 4
        ));
        if (cluster) {
            cluster.members.push(candidate);
            cluster.center = median(cluster.members.map((member) => member.year));
        } else {
            clusters.push({ identity: key, center: candidate.year, members: [candidate] });
        }
    });
    const scored = clusters.map((cluster) => {
        const families = [...new Set(cluster.members.map((member) => member.family))];
        const views = [...new Set(cluster.members.map((member) => member.view))];
        const representative = [...cluster.members].sort((left, right) => (
            Math.abs(left.year - cluster.center) - Math.abs(right.year - cluster.center)
        ))[0].event;
        return {
            eventType: representative.eventType,
            shiftYears: shiftFor(representative),
            topYear: Math.round(cluster.center),
            startYear: Math.round(cluster.center) - 6,
            endYear: Math.round(cluster.center) + 6,
            familySupport: families.length,
            viewSupport: views.length,
            families,
            views,
        };
    }).sort((left, right) => (
        right.familySupport - left.familySupport
        || right.viewSupport - left.viewSupport
        || right.topYear - left.topYear
    ));
    if (scored.length === 0) return null;
    return {
        ...scored[0],
        supportMargin: scored[0].familySupport - (scored[1]?.familySupport ?? 0),
        runnerUp: scored[1] ?? null,
    };
};

const locationMatches = (candidate, row) => row.truthType === "wholeSeriesMove"
    || (Number(row.truthYear) >= candidate.startYear && Number(row.truthYear) <= candidate.endYear);
const candidateCorrect = (candidate, row) => {
    if (!candidate || !row.truthId || !locationMatches(candidate, row)) return false;
    if (candidate.eventType === row.truthType
        && candidate.shiftYears === Number(row.truthShiftYears)) return true;
    return candidate.eventType === "partialMove"
        && candidate.shiftYears < -1
        && row.truthType === "missingRing";
};
const productTop = (row) => row.windowStart !== null && row.windowEnd !== null
    ? (Number(row.windowStart) + Number(row.windowEnd)) / 2
    : null;
const materiallyDifferent = (candidate, row) => {
    if (!candidate) return false;
    const productShift = row.predictedType === "missingRing"
        ? -1
        : row.predictedType === "falseRing"
            ? 1
            : Number(row.predictedShiftYears);
    if (candidate.eventType !== row.predictedType || candidate.shiftYears !== productShift) {
        return true;
    }
    const currentTop = productTop(row);
    return currentTop === null || Math.abs(candidate.topYear - currentTop) > 3;
};
const directionConflictVeto = (candidate, row) => candidate?.eventType === "partialMove"
    && candidate.shiftYears < -1
    && row.predictedType === "falseRing"
    && !(row.operationGrid?.jointDecision?.hypotheses ?? []).some((hypothesis) => (
        hypothesis.eventType === candidate.eventType
        && Number(hypothesis.shiftYears) === candidate.shiftYears
        && Number(hypothesis.startYear) <= candidate.endYear
        && Number(hypothesis.endYear) >= candidate.startYear
    ));

const evaluated = rows.map((row) => {
    const candidate = consensusCandidate(row.operationGrid);
    const eligible = materiallyDifferent(candidate, row);
    const vetoed = directionConflictVeto(candidate, row);
    const selected = eligible
        && candidate.familySupport >= minimumFamilySupport
        && candidate.supportMargin >= minimumSupportMargin
        && !vetoed;
    const correct = candidateCorrect(candidate, row);
    return {
        attemptId: row.attemptId,
        fileId: row.fileId,
        family: row.family,
        isClean: row.truthId === null,
        productCorrect: Boolean(row.workflowCorrect),
        productResponse: Boolean(row.response),
        candidate,
        candidateCorrect: correct,
        eligible,
        vetoed,
        selected,
        beneficial: selected && !row.workflowCorrect && correct,
        harmful: selected && row.workflowCorrect && !correct,
        neutralBoth: selected && row.workflowCorrect && correct,
        neutralNeither: selected && !row.workflowCorrect && !correct,
    };
});

const summarize = (selected) => {
    const eventRows = selected.filter((row) => !row.isClean);
    const selectedRows = selected.filter((row) => row.selected);
    const baselineCorrect = eventRows.filter((row) => row.productCorrect).length;
    const beneficial = selectedRows.filter((row) => row.beneficial).length;
    const harmful = selectedRows.filter((row) => row.harmful).length;
    return {
        events: eventRows.length,
        baselineCorrect,
        candidateAvailable: selected.filter((row) => row.candidate !== null).length,
        selected: selectedRows.length,
        beneficial,
        harmful,
        neutralBoth: selectedRows.filter((row) => row.neutralBoth).length,
        neutralNeither: selectedRows.filter((row) => row.neutralNeither).length,
        newCleanFalsePositives: selectedRows.filter((row) => (
            row.isClean && !row.productResponse
        )).length,
        resultingCorrect: baselineCorrect + beneficial - harmful,
    };
};

const output = {
    schemaVersion: 1,
    rowsPath,
    minimumFamilySupport,
    minimumSupportMargin,
    overall: summarize(evaluated),
    byFamily: Object.fromEntries(["A", "B", "C", "D"].map((family) => [
        family,
        summarize(evaluated.filter((row) => row.family === family)),
    ])),
    rows: evaluated,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`INTERNAL_PATH_CONSENSUS_COMPLETE ${JSON.stringify({
    outputPath,
    overall: output.overall,
    byFamily: output.byFamily,
})}`);
