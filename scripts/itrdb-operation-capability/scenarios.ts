import { createHash } from "node:crypto";
import type {
    CapabilityCase,
    CapabilityConfig,
    CapabilityFamily,
    CapabilityManifest,
    CapabilityOperation,
    CapabilityTarget,
    CapabilityTruth,
} from "./types";

const stableHash = (value: string): number => Number.parseInt(
    createHash("sha256").update(value).digest("hex").slice(0, 12),
    16,
);

const balanced = <T>(values: readonly T[], key: string): T => {
    if (values.length === 0) throw new Error("balanced value list is empty");
    return values[stableHash(key) % values.length];
};

const localTruth = (
    truthId: string,
    eventType: Exclude<CapabilityOperation, "wholeSeriesMove">,
    year: number,
    partialShiftYears: number,
): CapabilityTruth => ({
    truthId,
    eventType,
    year,
    shiftYears: eventType === "missingRing"
        ? -1
        : eventType === "falseRing"
            ? 1
            : partialShiftYears,
});

const wholeTruth = (truthId: string, shiftYears: number): CapabilityTruth => ({
    truthId,
    eventType: "wholeSeriesMove",
    year: null,
    shiftYears,
});

const anchorYears = (
    config: CapabilityConfig,
    target: CapabilityTarget,
    spacingYears: number,
    key: string,
): { older: number; newer: number; single: number } => {
    const olderOffset = Math.floor(spacingYears / 2);
    const newerOffset = spacingYears - olderOffset;
    const minimumCenter = target.startYear
        + config.selection.minimumOlderContextYears
        + olderOffset;
    const maximumCenter = target.endYear
        - config.selection.minimumNewerContextYears
        - newerOffset;
    if (maximumCenter < minimumCenter) {
        throw new Error(`insufficient event context: ${target.targetId}`);
    }
    const fractions = [0.35, 0.5, 0.65] as const;
    const fraction = balanced(fractions, key);
    const center = Math.round(minimumCenter + (maximumCenter - minimumCenter) * fraction);
    return {
        older: center - olderOffset,
        newer: center + newerOffset,
        single: center,
    };
};

const centeredEventYears = (
    config: CapabilityConfig,
    target: CapabilityTarget,
    count: number,
    totalSpanYears: number,
    key: string,
): number[] => {
    if (!Number.isInteger(count) || count < 2) {
        throw new Error(`invalid event count: ${count}`);
    }
    if (!Number.isInteger(totalSpanYears) || totalSpanYears < count - 1) {
        throw new Error(`invalid event span: ${totalSpanYears}`);
    }
    const olderOffset = Math.floor(totalSpanYears / 2);
    const newerOffset = totalSpanYears - olderOffset;
    const minimumCenter = target.startYear
        + config.selection.minimumOlderContextYears
        + olderOffset;
    const maximumCenter = target.endYear
        - config.selection.minimumNewerContextYears
        - newerOffset;
    if (maximumCenter < minimumCenter) {
        throw new Error(`insufficient multi-event context: ${target.targetId}`);
    }
    const fraction = balanced([0.35, 0.5, 0.65] as const, key);
    const center = Math.round(minimumCenter + (maximumCenter - minimumCenter) * fraction);
    const startYear = center - olderOffset;
    return Array.from({ length: count }, (_, index) => (
        startYear + Math.round(index * totalSpanYears / (count - 1))
    ));
};

type LocalPair = {
    slug: string;
    older: Exclude<CapabilityOperation, "wholeSeriesMove">;
    newer: Exclude<CapabilityOperation, "wholeSeriesMove">;
};

const localPairs: LocalPair[] = [
    { slug: "missing-missing", older: "missingRing", newer: "missingRing" },
    { slug: "false-false", older: "falseRing", newer: "falseRing" },
    { slug: "partial-partial", older: "partialMove", newer: "partialMove" },
    { slug: "missing-false", older: "missingRing", newer: "falseRing" },
    { slug: "false-missing", older: "falseRing", newer: "missingRing" },
    { slug: "missing-partial", older: "missingRing", newer: "partialMove" },
    { slug: "partial-missing", older: "partialMove", newer: "missingRing" },
    { slug: "false-partial", older: "falseRing", newer: "partialMove" },
    { slug: "partial-false", older: "partialMove", newer: "falseRing" },
];

type LocalPattern = {
    slug: string;
    operations: Array<Exclude<CapabilityOperation, "wholeSeriesMove">>;
};

const multiEventPatterns: LocalPattern[] = [
    { slug: "missing-missing-missing", operations: ["missingRing", "missingRing", "missingRing"] },
    { slug: "false-false-false", operations: ["falseRing", "falseRing", "falseRing"] },
    { slug: "partial-partial-partial", operations: ["partialMove", "partialMove", "partialMove"] },
    { slug: "missing-false-partial", operations: ["missingRing", "falseRing", "partialMove"] },
    { slug: "partial-missing-false", operations: ["partialMove", "missingRing", "falseRing"] },
    { slug: "false-partial-missing", operations: ["falseRing", "partialMove", "missingRing"] },
    { slug: "missing-missing-false-partial", operations: ["missingRing", "missingRing", "falseRing", "partialMove"] },
    { slug: "false-false-missing-partial", operations: ["falseRing", "falseRing", "missingRing", "partialMove"] },
    { slug: "partial-partial-missing-false", operations: ["partialMove", "partialMove", "missingRing", "falseRing"] },
    { slug: "missing-partial-false-missing", operations: ["missingRing", "partialMove", "falseRing", "missingRing"] },
    { slug: "false-missing-partial-false", operations: ["falseRing", "missingRing", "partialMove", "falseRing"] },
    { slug: "partial-false-missing-partial", operations: ["partialMove", "falseRing", "missingRing", "partialMove"] },
    { slug: "missing-missing-missing-missing-missing", operations: ["missingRing", "missingRing", "missingRing", "missingRing", "missingRing"] },
    { slug: "false-false-false-false-false", operations: ["falseRing", "falseRing", "falseRing", "falseRing", "falseRing"] },
    { slug: "partial-partial-partial-partial-partial", operations: ["partialMove", "partialMove", "partialMove", "partialMove", "partialMove"] },
    { slug: "missing-false-partial-missing-false", operations: ["missingRing", "falseRing", "partialMove", "missingRing", "falseRing"] },
    { slug: "partial-false-missing-partial-false", operations: ["partialMove", "falseRing", "missingRing", "partialMove", "falseRing"] },
];

const buildPatternTruths = (
    pattern: LocalPattern,
    years: readonly number[],
    partialShiftYears: number,
    secondPartialShiftYears: number,
): CapabilityTruth[] => {
    let partialIndex = 0;
    return pattern.operations.map((eventType, index) => {
        const shift = partialIndex % 2 === 0
            ? partialShiftYears
            : secondPartialShiftYears;
        if (eventType === "partialMove") partialIndex += 1;
        return localTruth(`event-${index + 1}`, eventType, years[index], shift);
    });
};

const addCase = (
    cases: CapabilityCase[],
    input: Omit<CapabilityCase, "index">,
): void => {
    cases.push({ ...input, index: cases.length });
};

export const buildCapabilityCases = (
    config: CapabilityConfig,
    manifest: CapabilityManifest,
): CapabilityCase[] => {
    const cases: CapabilityCase[] = [];
    const scenarioGeneratorVersion = config.scenarioGeneratorVersion ?? 1;
    manifest.files.forEach((file) => file.eligibleTargets.forEach((target) => {
        const baseKey = `${config.seed}:${file.fileId}:${target.targetId}`;
        const partialShiftYears = balanced(
            config.injection.partialShiftYears,
            `${baseKey}:partial-shift`,
        );
        const secondPartialShiftYears = balanced(
            [...config.injection.partialShiftYears].reverse(),
            `${baseKey}:partial-shift`,
        );
        const wholeShiftYears = balanced(
            config.injection.wholeShiftYears,
            `${baseKey}:whole-shift`,
        );
        const single = anchorYears(config, target, 0, `${baseKey}:A`).single;
        const common = {
            fileId: file.fileId,
            relativePath: file.relativePath,
            targetId: target.targetId,
            seriesYears: target.seriesYears,
            targetStartYear: target.startYear,
            targetEndYear: target.endYear,
            masterCorrelation: target.masterCorrelation,
            problemSegments: target.problemSegments,
            partialShiftYears,
            wholeShiftYears,
        };
        addCase(cases, {
            ...common,
            caseId: `${file.fileId}:${target.targetId}:A0-clean`,
            family: "A",
            scenarioId: "A0-clean",
            spacingYears: null,
            evaluationMode: "sequentialExact",
            truthCluster: null,
            truths: [],
        });
        ([
            ["A1-single-missing", "missingRing"],
            ["A2-single-false", "falseRing"],
            ["A3-single-partial", "partialMove"],
        ] as const).forEach(([scenarioId, eventType]) => addCase(cases, {
            ...common,
            caseId: `${file.fileId}:${target.targetId}:${scenarioId}`,
            family: "A",
            scenarioId,
            spacingYears: null,
            evaluationMode: "sequentialExact",
            truthCluster: null,
            truths: [localTruth("event-1", eventType, single, partialShiftYears)],
        }));
        addCase(cases, {
            ...common,
            caseId: `${file.fileId}:${target.targetId}:A4-single-whole`,
            family: "A",
            scenarioId: "A4-single-whole",
            spacingYears: null,
            evaluationMode: "sequentialExact",
            truthCluster: null,
            truths: [wholeTruth("event-1", wholeShiftYears)],
        });

        const addPairFamily = (family: Extract<CapabilityFamily, "B" | "C">): void => {
            const spacingYears = family === "B"
                ? config.injection.distantSpacingYears
                : config.injection.nearSpacingYears;
            const pairYears = anchorYears(config, target, spacingYears, `${baseKey}:${family}`);
            localPairs.forEach((pair, pairIndex) => addCase(cases, {
                ...common,
                caseId: `${file.fileId}:${target.targetId}:${family}${pairIndex + 1}-${pair.slug}`,
                family,
                scenarioId: `${family}${pairIndex + 1}-${pair.slug}`,
                spacingYears,
                evaluationMode: family === "C" && scenarioGeneratorVersion >= 2
                    ? "nearEventCluster"
                    : "sequentialExact",
                truthCluster: family === "C" && scenarioGeneratorVersion >= 2 ? {
                    startYear: pairYears.older,
                    endYear: pairYears.newer,
                    eventCount: 2,
                } : null,
                truths: [
                    localTruth("older", pair.older, pairYears.older, partialShiftYears),
                    localTruth("newer", pair.newer, pairYears.newer, secondPartialShiftYears),
                ],
            }));
            if (family === "B") {
                ([
                    ["B10-whole-missing", "missingRing"],
                    ["B11-whole-false", "falseRing"],
                    ["B12-whole-partial", "partialMove"],
                ] as const).forEach(([scenarioId, eventType]) => addCase(cases, {
                    ...common,
                    caseId: `${file.fileId}:${target.targetId}:${scenarioId}`,
                    family,
                    scenarioId,
                    spacingYears,
                    evaluationMode: "sequentialExact",
                    truthCluster: null,
                    truths: [
                        wholeTruth("whole", wholeShiftYears),
                        localTruth("local", eventType, pairYears.single, partialShiftYears),
                    ],
                }));
            }
            if (scenarioGeneratorVersion >= 2) {
                const requestedCounts = family === "B"
                    ? config.injection.distantEventCounts ?? [3, 4]
                    : config.injection.nearClusterEventCounts ?? [3, 4, 5];
                const patterns = multiEventPatterns.filter((pattern) => (
                    requestedCounts.includes(pattern.operations.length)
                ));
                const firstScenarioNumber = family === "B" ? 13 : 10;
                patterns.forEach((pattern, patternIndex) => {
                    const count = pattern.operations.length;
                    const totalSpanYears = family === "B"
                        ? spacingYears * (count - 1)
                        : Math.min(
                            config.injection.nearClusterMaximumSpanYears ?? 12,
                            spacingYears * (count - 1),
                        );
                    const years = centeredEventYears(
                        config,
                        target,
                        count,
                        totalSpanYears,
                        `${baseKey}:${family}:multi:${pattern.slug}`,
                    );
                    const scenarioId = `${family}${firstScenarioNumber + patternIndex}`
                        + `-${pattern.slug}`;
                    addCase(cases, {
                        ...common,
                        caseId: `${file.fileId}:${target.targetId}:${scenarioId}`,
                        family,
                        scenarioId,
                        spacingYears: family === "B" ? spacingYears : null,
                        evaluationMode: family === "C"
                            ? "nearEventCluster"
                            : "sequentialExact",
                        truthCluster: family === "C" ? {
                            startYear: years[0],
                            endYear: years[years.length - 1],
                            eventCount: years.length,
                        } : null,
                        truths: buildPatternTruths(
                            pattern,
                            years,
                            partialShiftYears,
                            secondPartialShiftYears,
                        ),
                    });
                });
            }
        };
        addPairFamily("B");
        addPairFamily("C");

        const tripleYears = anchorYears(
            config,
            target,
            config.injection.distantSpacingYears,
            `${baseKey}:D`,
        );
        ([
            ["D1-whole-missing-partial", "missingRing", "partialMove"],
            ["D2-whole-partial-missing", "partialMove", "missingRing"],
            ["D3-whole-false-partial", "falseRing", "partialMove"],
            ["D4-whole-partial-false", "partialMove", "falseRing"],
        ] as const).forEach(([scenarioId, olderType, newerType]) => addCase(cases, {
            ...common,
            caseId: `${file.fileId}:${target.targetId}:${scenarioId}`,
            family: "D",
            scenarioId,
            spacingYears: config.injection.distantSpacingYears,
            evaluationMode: "sequentialExact",
            truthCluster: null,
            truths: [
                wholeTruth("whole", wholeShiftYears),
                localTruth("older", olderType, tripleYears.older, partialShiftYears),
                localTruth("newer", newerType, tripleYears.newer, secondPartialShiftYears),
            ],
        }));
    }));
    return cases;
};
