import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EVENT_TYPES = new Set([
    "missingRing",
    "falseRing",
    "partialMove",
    "wholeSeriesMove",
]);
const STAGES = [
    ["candidate", "candidateProjectedEvents"],
    ["detected", "detectedBeforeFusion"],
    ["fused", "detectedAfterFusion"],
    ["retained", "retainedAfterEndpointGuard"],
    ["displayed", "displayedBeforeLocator"],
    ["final", "finalEvents"],
];
const SKIPPED_RECURSIVE_KEYS = new Set([
    "rows",
    "lagResults",
    "notes",
    "rankedYears",
    "ledger",
    "locationEvidence",
]);

const args = process.argv.slice(2);
const valueFor = (name) => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const runDir = resolve(valueFor("--run-dir") ?? "");
if (!valueFor("--run-dir")) throw new Error("--run-dir is required");
const outputDir = resolve(valueFor("--output-dir") ?? join(runDir, "oracle-analysis"));

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const numberOrNull = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};
const bool = (value) => value === true || String(value).toLowerCase() === "true";
const impliedShift = (eventType, shiftYears) => {
    if (eventType === "missingRing") return -1;
    if (eventType === "falseRing") return 1;
    return numberOrNull(shiftYears);
};
const rankedTopYear = (value) => numberOrNull(
    value?.topYear
    ?? value?.bestYear
    ?? value?.reviewTopYear
    ?? value?.selectedYear
    ?? value?.rankedYears?.[0]?.year,
);

const normalizeCandidate = (value, source) => {
    if (!value || typeof value !== "object" || !EVENT_TYPES.has(value.eventType)) {
        return null;
    }
    const topYear = rankedTopYear(value);
    let startYear = numberOrNull(value.startYear);
    let endYear = numberOrNull(value.endYear);
    if (value.eventType !== "wholeSeriesMove"
        && (startYear === null || endYear === null)
        && topYear !== null) {
        startYear = topYear - 6;
        endYear = topYear + 6;
    }
    return {
        eventType: value.eventType,
        shiftYears: impliedShift(value.eventType, value.shiftYears),
        startYear,
        endYear,
        topYear,
        score: numberOrNull(
            value.score
            ?? value.dynamicScore
            ?? value.topThreeDifferenceGain
            ?? value.bestCombinedGain
            ?? value.evidence?.score,
        ),
        source,
    };
};

const dedupeCandidates = (candidates) => {
    const seen = new Set();
    return candidates.filter((candidate) => {
        if (!candidate) return false;
        const key = [
            candidate.eventType,
            candidate.shiftYears,
            candidate.startYear,
            candidate.endYear,
            candidate.topYear,
            candidate.source,
        ].join(":");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const collectRecursiveCandidates = (root, source = "grid") => {
    const candidates = [];
    const visited = new Set();
    const visit = (value, path, depth) => {
        if (!value || typeof value !== "object" || depth > 10 || visited.has(value)) return;
        visited.add(value);
        if (Array.isArray(value)) {
            value.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
            return;
        }
        const direct = normalizeCandidate(value, path);
        if (direct) candidates.push(direct);
        for (const [key, nested] of Object.entries(value)) {
            if (SKIPPED_RECURSIVE_KEYS.has(key)) continue;
            visit(nested, `${path}.${key}`, depth + 1);
        }
    };
    visit(root, source, 0);
    return dedupeCandidates(candidates);
};

const operationMatches = (candidate, truth, relaxed = false) => {
    if (candidate.eventType === truth.eventType) {
        return truth.eventType !== "partialMove" && truth.eventType !== "wholeSeriesMove"
            ? true
            : candidate.shiftYears === truth.shiftYears;
    }
    return relaxed
        && truth.eventType === "missingRing"
        && candidate.eventType === "partialMove"
        && (candidate.shiftYears ?? 0) < -1;
};
const locationMatches = (candidate, truth) => {
    if (truth.eventType === "wholeSeriesMove") return true;
    if (truth.year === null) return false;
    if (candidate.startYear !== null && candidate.endYear !== null) {
        return truth.year >= candidate.startYear && truth.year <= candidate.endYear;
    }
    return candidate.topYear !== null && Math.abs(candidate.topYear - truth.year) <= 6;
};
const candidateMatches = (candidate, truth, relaxed = false) => (
    operationMatches(candidate, truth, relaxed) && locationMatches(candidate, truth)
);
const anyMatch = (candidates, truth, relaxed = false) => (
    candidates.some((candidate) => candidateMatches(candidate, truth, relaxed))
);

const auditFiles = (root) => {
    const found = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name === "diagnosis-audit.json") found.push(path);
        }
    };
    walk(join(root, "workers"));
    return found;
};

const steps = readJson(join(runDir, "steps.json"));
const audits = new Map();
for (const path of auditFiles(runDir)) {
    const match = path.match(/case-(\d+)-step-(\d+)[\\/]diagnosis-audit\.json$/);
    if (match) audits.set(`${match[1]}:${match[2]}`, readJson(path));
}

const rows = [];
for (const step of steps) {
    const truthType = step.diagnosedTruthType || step.acceptedTruthType || null;
    if (!EVENT_TYPES.has(truthType)) continue;
    const truth = {
        eventType: truthType,
        year: numberOrNull(step.diagnosedTruthYear ?? step.acceptedTruthYear),
        shiftYears: impliedShift(
            truthType,
            step.diagnosedTruthShiftYears ?? step.acceptedTruthShiftYears,
        ),
    };
    const auditFile = audits.get(`${step.caseIndex}:${step.step}`) ?? null;
    const snapshot = auditFile?.after?.audit
        ? auditFile.after
        : auditFile?.before?.audit ? auditFile.before : auditFile?.after ?? auditFile?.before ?? null;
    const audit = snapshot?.audit ?? null;
    const stageCandidates = Object.fromEntries(STAGES.map(([stage, field]) => [
        stage,
        dedupeCandidates((audit?.[field] ?? []).map((event) => (
            normalizeCandidate(event, `stage.${stage}`)
        ))),
    ]));
    const earlierCandidates = dedupeCandidates(STAGES
        .filter(([stage]) => stage !== "final")
        .flatMap(([stage]) => stageCandidates[stage]));
    const finalCandidates = stageCandidates.final;
    const jointCandidates = dedupeCandidates(
        (snapshot?.operationGrid?.jointDecision?.hypotheses ?? []).map((event) => (
            normalizeCandidate(event, "joint.hypothesis")
        )),
    );
    const gridCandidates = collectRecursiveCandidates({
        operationGrid: snapshot?.operationGrid ?? null,
        stableBoundedPathEvidence: audit?.stableBoundedPathEvidence ?? null,
        positiveUnitChainEvidence: audit?.positiveUnitChainEvidence ?? null,
        localLagTransitionEvidence: audit?.localLagTransitionEvidence ?? null,
        terminalUnitStaircaseEvidence: audit?.terminalUnitStaircaseEvidence ?? null,
    });
    const counterfactualCandidates = dedupeCandidates(
        (snapshot?.operationGrid?.operations ?? []).map((event) => (
            normalizeCandidate(event, "counterfactual.operation")
        )),
    ).sort((left, right) => (
        (right.score ?? Number.NEGATIVE_INFINITY)
        - (left.score ?? Number.NEGATIVE_INFINITY)
    ));
    const rankOfMatch = (candidates) => {
        const index = candidates.findIndex((candidate) => candidateMatches(candidate, truth));
        return index >= 0 ? index + 1 : null;
    };
    const counterfactualRank = rankOfMatch(counterfactualCandidates);
    const jointRank = rankOfMatch([...jointCandidates].sort((left, right) => (
        (right.score ?? Number.NEGATIVE_INFINITY)
        - (left.score ?? Number.NEGATIVE_INFINITY)
    )));
    const productCorrect = bool(step.workflowSuggestionCorrect);
    const finalOracle = anyMatch(finalCandidates, truth);
    const jointOracle = anyMatch(jointCandidates, truth);
    const stageOracle = anyMatch(earlierCandidates, truth);
    const gridOracle = anyMatch(gridCandidates, truth);
    const relaxedGridOracle = anyMatch(gridCandidates, truth, true);
    const allCandidates = dedupeCandidates([
        ...finalCandidates,
        ...jointCandidates,
        ...earlierCandidates,
        ...gridCandidates,
    ]);
    const operationOracle = allCandidates.some((candidate) => (
        operationMatches(candidate, truth)
    ));
    const locationOracle = allCandidates.some((candidate) => (
        locationMatches(candidate, truth)
    ));
    let category = "product_correct";
    if (!productCorrect) {
        if (finalOracle) category = "post_final_loss";
        else if (jointOracle) category = "joint_selection_loss";
        else if (stageOracle) category = "pipeline_rewrite_loss";
        else if (gridOracle) category = "evidence_projection_loss";
        else if (operationOracle && !locationOracle) category = "location_evidence_absent";
        else if (!operationOracle && locationOracle) category = "operation_evidence_absent";
        else category = "no_complete_hypothesis";
    }
    const strictOracle = productCorrect
        || finalOracle || jointOracle || stageOracle || gridOracle;
    const relaxedOracle = strictOracle || relaxedGridOracle;
    const matchingCandidate = [
        ...finalCandidates,
        ...jointCandidates,
        ...earlierCandidates,
        ...gridCandidates,
    ].find((candidate) => candidateMatches(candidate, truth)) ?? null;
    rows.push({
        caseIndex: step.caseIndex,
        caseId: step.caseId,
        step: step.step,
        family: step.family,
        fileId: step.fileId,
        targetId: step.targetId,
        truthType: truth.eventType,
        truthYear: truth.year,
        truthShiftYears: truth.shiftYears,
        productCorrect,
        response: bool(step.response),
        stopReason: step.stopReason || "",
        category,
        finalOracle,
        jointOracle,
        stageOracle,
        gridOracle,
        relaxedGridOracle,
        strictOracle,
        relaxedOracle,
        operationOracle,
        locationOracle,
        counterfactualRank: counterfactualRank ?? "",
        counterfactualTopCorrect: counterfactualRank === 1,
        jointRank: jointRank ?? "",
        oracleSource: matchingCandidate?.source ?? "",
        oracleType: matchingCandidate?.eventType ?? "",
        oracleShiftYears: matchingCandidate?.shiftYears ?? "",
        oracleStartYear: matchingCandidate?.startYear ?? "",
        oracleEndYear: matchingCandidate?.endYear ?? "",
        candidateCount: allCandidates.length,
        auditAvailable: auditFile !== null,
    });
}

const cleanRows = steps.filter((step) => step.family === "Clean").map((step) => {
    const auditFile = audits.get(`${step.caseIndex}:${step.step}`) ?? null;
    const snapshot = auditFile?.after?.audit
        ? auditFile.after
        : auditFile?.before?.audit ? auditFile.before : auditFile?.after ?? auditFile?.before ?? null;
    const audit = snapshot?.audit ?? null;
    const stageCandidates = dedupeCandidates(STAGES.flatMap(([stage, field]) => (
        (audit?.[field] ?? []).map((event) => normalizeCandidate(event, `stage.${stage}`))
    )));
    const jointCandidates = dedupeCandidates(
        (snapshot?.operationGrid?.jointDecision?.hypotheses ?? []).map((event) => (
            normalizeCandidate(event, "joint.hypothesis")
        )),
    );
    const gridCandidates = collectRecursiveCandidates({
        operationGrid: snapshot?.operationGrid ?? null,
        stableBoundedPathEvidence: audit?.stableBoundedPathEvidence ?? null,
        positiveUnitChainEvidence: audit?.positiveUnitChainEvidence ?? null,
    });
    return {
        caseIndex: step.caseIndex,
        fileId: step.fileId,
        targetId: step.targetId,
        productFalsePositive: bool(step.response),
        stageHypothesis: stageCandidates.length > 0,
        jointHypothesis: jointCandidates.length > 0,
        gridHypothesis: gridCandidates.length > 0,
        stageCandidateCount: stageCandidates.length,
        jointCandidateCount: jointCandidates.length,
        gridCandidateCount: gridCandidates.length,
    };
});

const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
const percentile = (values, probability) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * probability) - 1),
    )];
};
const seededRandom = (seed) => {
    let state = Number.parseInt(
        createHash("sha256").update(seed).digest("hex").slice(0, 8),
        16,
    ) >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
};
const clusteredOracleGain = (subset, seed, replicates = 10000) => {
    const fileIds = [...new Set(subset.map(({ fileId }) => fileId))].sort();
    if (fileIds.length === 0) return null;
    const byFile = new Map(fileIds.map((fileId) => [
        fileId,
        subset.filter((row) => row.fileId === fileId),
    ]));
    const random = seededRandom(seed);
    const gains = [];
    for (let replicate = 0; replicate < replicates; replicate += 1) {
        let attempts = 0;
        let product = 0;
        let oracle = 0;
        for (let index = 0; index < fileIds.length; index += 1) {
            const fileId = fileIds[Math.floor(random() * fileIds.length)];
            const selected = byFile.get(fileId) ?? [];
            attempts += selected.length;
            product += selected.filter((row) => row.productCorrect).length;
            oracle += selected.filter((row) => row.strictOracle).length;
        }
        if (attempts > 0) gains.push((oracle - product) / attempts);
    }
    const product = subset.filter((row) => row.productCorrect).length;
    const oracle = subset.filter((row) => row.strictOracle).length;
    return {
        clusters: fileIds.length,
        replicates,
        estimate: (oracle - product) / subset.length,
        confidenceInterval: [percentile(gains, 0.025), percentile(gains, 0.975)],
        oneSidedLower: percentile(gains, 0.05),
    };
};
const summarize = (subset) => {
    const attempts = subset.length;
    const failures = subset.filter((row) => !row.productCorrect);
    const productCorrect = attempts - failures.length;
    const pipelineRecoverable = failures.filter((row) => (
        row.finalOracle || row.jointOracle || row.stageOracle
    )).length;
    const gridRecoverable = failures.filter((row) => row.gridOracle).length;
    const strictOracleCorrect = subset.filter((row) => row.strictOracle).length;
    const relaxedOracleCorrect = subset.filter((row) => row.relaxedOracle).length;
    const rankedCounterfactual = subset.filter((row) => row.counterfactualRank !== "");
    return {
        attempts,
        productCorrect,
        productAccuracy: ratio(productCorrect, attempts),
        failures: failures.length,
        pipelineRecoverable,
        pipelineRegretAmongFailures: ratio(pipelineRecoverable, failures.length),
        gridRecoverable,
        gridRecoverableAmongFailures: ratio(gridRecoverable, failures.length),
        strictOracleCorrect,
        strictOracleAccuracy: ratio(strictOracleCorrect, attempts),
        relaxedOracleCorrect,
        relaxedOracleAccuracy: ratio(relaxedOracleCorrect, attempts),
        counterfactualOracleAttempts: rankedCounterfactual.length,
        counterfactualTop1: rankedCounterfactual.filter((row) => (
            row.counterfactualRank === 1
        )).length,
        counterfactualTop3: rankedCounterfactual.filter((row) => (
            row.counterfactualRank <= 3
        )).length,
        counterfactualTop5: rankedCounterfactual.filter((row) => (
            row.counterfactualRank <= 5
        )).length,
        categories: Object.fromEntries([...new Set(subset.map(({ category }) => category))]
            .sort().map((category) => [
                category,
                subset.filter((row) => row.category === category).length,
            ])),
    };
};

const families = ["A", "B", "C", "D"];
const summary = {
    schemaVersion: 1,
    runDir,
    generatedAt: new Date().toISOString(),
    auditedAttempts: rows.length,
    auditFiles: audits.size,
    clean: {
        attempts: cleanRows.length,
        productFalsePositives: cleanRows.filter((row) => row.productFalsePositive).length,
        stageHypothesisCases: cleanRows.filter((row) => row.stageHypothesis).length,
        jointHypothesisCases: cleanRows.filter((row) => row.jointHypothesis).length,
        gridHypothesisCases: cleanRows.filter((row) => row.gridHypothesis).length,
    },
    overall: summarize(rows),
    byFamily: Object.fromEntries(families.map((family) => {
        const selected = rows.filter((row) => row.family === family);
        return [family, {
            ...summarize(selected),
            clusteredOracleGain: clusteredOracleGain(
                selected,
                `diagnosis-oracle:${family}`,
            ),
        }];
    })),
    byTruthType: Object.fromEntries([...EVENT_TYPES].map((eventType) => [
        eventType,
        summarize(rows.filter((row) => row.truthType === eventType)),
    ])),
    byFile: Object.fromEntries([...new Set(rows.map(({ fileId }) => fileId))]
        .sort().map((fileId) => [
            fileId,
            summarize(rows.filter((row) => row.fileId === fileId)),
        ])),
};

const csvCell = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const writeCsv = (path, values) => {
    const headers = Object.keys(values[0] ?? {});
    writeFileSync(path, [
        headers.join(","),
        ...values.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
    ].join("\n") + "\n", "utf8");
};
const percent = (value) => value === null ? "-" : `${(value * 100).toFixed(2)}%`;
const markdown = [
    "# Diagnosis Oracle Audit",
    "",
    `- Run: \`${runDir}\``,
    `- Audited attempts: ${rows.length}`,
    `- Audit files: ${audits.size}`,
    "",
    "## Family Summary",
    "",
    "| Family | Attempts | Product | Strict oracle | Pipeline regret / failures | Grid recoverable / failures |",
    "|---|---:|---:|---:|---:|---:|",
    ...families.map((family) => {
        const value = summary.byFamily[family];
        return `| ${family} | ${value.attempts} | ${percent(value.productAccuracy)} | ${percent(value.strictOracleAccuracy)} | ${percent(value.pipelineRegretAmongFailures)} | ${percent(value.gridRecoverableAmongFailures)} |`;
    }),
    "",
    "## Clustered Oracle Gain",
    "",
    "| Family | Gain | One-sided 95% lower | 95% interval |",
    "|---|---:|---:|---:|",
    ...families.map((family) => {
        const gain = summary.byFamily[family].clusteredOracleGain;
        return `| ${family} | ${percent(gain?.estimate ?? null)} | ${percent(gain?.oneSidedLower ?? null)} | ${percent(gain?.confidenceInterval?.[0] ?? null)}–${percent(gain?.confidenceInterval?.[1] ?? null)} |`;
    }),
    "",
    "## Failure Attribution",
    "",
    "| Category | Count |",
    "|---|---:|",
    ...Object.entries(summary.overall.categories)
        .filter(([category]) => category !== "product_correct")
        .sort((left, right) => right[1] - left[1])
        .map(([category, count]) => `| ${category} | ${count} |`),
    "",
    "## Clean Controls",
    "",
    `- Product false positives: ${summary.clean.productFalsePositives}/${summary.clean.attempts}`,
    `- Complete stage hypotheses: ${summary.clean.stageHypothesisCases}/${summary.clean.attempts}`,
    `- Joint hypotheses: ${summary.clean.jointHypothesisCases}/${summary.clean.attempts}`,
    `- Any raw grid hypothesis: ${summary.clean.gridHypothesisCases}/${summary.clean.attempts}`,
    "",
    "## Interpretation",
    "",
    "- `post_final_loss`: a correct complete event reached `finalEvents` but was not shown.",
    "- `joint_selection_loss`: a correct joint hypothesis existed but lost selection.",
    "- `pipeline_rewrite_loss`: an earlier complete event was correct but downstream stages removed or moved it.",
    "- `evidence_projection_loss`: raw operation/path evidence contained a correct event but it never became a complete production hypothesis.",
    "- `*_evidence_absent` / `no_complete_hypothesis`: the audited evidence did not contain a complete strict answer.",
    "",
].join("\n");

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
writeCsv(join(outputDir, "attempts.csv"), rows);
writeCsv(join(outputDir, "clean-attempts.csv"), cleanRows);
writeFileSync(join(outputDir, "report.md"), markdown, "utf8");
console.log(JSON.stringify({ outputDir, ...summary.overall }));
