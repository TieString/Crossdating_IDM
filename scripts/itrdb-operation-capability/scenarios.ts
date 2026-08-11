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
            truths: [localTruth("event-1", eventType, single, partialShiftYears)],
        }));
        addCase(cases, {
            ...common,
            caseId: `${file.fileId}:${target.targetId}:A4-single-whole`,
            family: "A",
            scenarioId: "A4-single-whole",
            spacingYears: null,
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
                    truths: [
                        wholeTruth("whole", wholeShiftYears),
                        localTruth("local", eventType, pairYears.single, partialShiftYears),
                    ],
                }));
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
            truths: [
                wholeTruth("whole", wholeShiftYears),
                localTruth("older", olderType, tripleYears.older, partialShiftYears),
                localTruth("newer", newerType, tripleYears.newer, secondPartialShiftYears),
            ],
        }));
    }));
    return cases;
};
