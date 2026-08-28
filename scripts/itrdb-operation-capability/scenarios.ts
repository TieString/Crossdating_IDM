import { createHash } from "node:crypto";
import type {
    CapabilityCase,
    CapabilityConfig,
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

const cyclic = <T>(values: readonly T[], index: number, key: string): T => {
    if (values.length === 0) throw new Error("cyclic value list is empty");
    return values[(index + stableHash(key)) % values.length];
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

type LocalPattern = {
    slug: string;
    operations: CapabilityOperation[];
};

const distantMixedPatterns: LocalPattern[] = [
    { slug: "missing-false", operations: ["missingRing", "falseRing"] },
    { slug: "missing-partial", operations: ["missingRing", "partialMove"] },
    { slug: "missing-whole", operations: ["wholeSeriesMove", "missingRing"] },
    { slug: "false-partial", operations: ["falseRing", "partialMove"] },
    { slug: "false-whole", operations: ["wholeSeriesMove", "falseRing"] },
    { slug: "partial-whole", operations: ["wholeSeriesMove", "partialMove"] },
    { slug: "missing-false-partial", operations: ["missingRing", "falseRing", "partialMove"] },
    { slug: "whole-missing-false", operations: ["wholeSeriesMove", "missingRing", "falseRing"] },
    { slug: "whole-missing-partial", operations: ["wholeSeriesMove", "missingRing", "partialMove"] },
    { slug: "whole-false-partial", operations: ["wholeSeriesMove", "falseRing", "partialMove"] },
    { slug: "whole-missing-partial-false", operations: [
        "wholeSeriesMove",
        "missingRing",
        "partialMove",
        "falseRing",
    ] },
];

const buildPatternTruths = (
    pattern: LocalPattern,
    years: readonly number[],
    partialShiftYears: number,
    secondPartialShiftYears: number,
    wholeShiftYears: number,
): CapabilityTruth[] => {
    let partialIndex = 0;
    let localIndex = 0;
    return pattern.operations.map((eventType, index) => {
        if (eventType === "wholeSeriesMove") {
            return wholeTruth(`event-${index + 1}`, wholeShiftYears);
        }
        const shift = partialIndex % 2 === 0
            ? partialShiftYears
            : secondPartialShiftYears;
        if (eventType === "partialMove") partialIndex += 1;
        const truth = localTruth(
            `event-${index + 1}`,
            eventType,
            years[localIndex],
            shift,
        );
        localIndex += 1;
        return truth;
    });
};

const normalizedCounts = (values: readonly number[] | undefined): number[] => (
    Array.from(new Set(values ?? [2, 3, 4]))
        .filter((value) => Number.isInteger(value) && value >= 2)
        .sort((left, right) => left - right)
);

const nearSpacingFor = (config: CapabilityConfig, key: string): number => {
    const configured = Array.isArray(config.injection.nearSpacingYears)
        ? config.injection.nearSpacingYears
        : [config.injection.nearSpacingYears];
    const valid = configured.filter((value) => (
        Number.isInteger(value) && value >= 2 && value <= 13
    ));
    if (valid.length === 0) throw new Error("near spacing must be within 2-13 years");
    return balanced(valid, key);
};

const yearsForPattern = (
    config: CapabilityConfig,
    target: CapabilityTarget,
    localCount: number,
    spacingYears: number,
    key: string,
): number[] => localCount === 1
    ? [anchorYears(config, target, 0, key).single]
    : centeredEventYears(
            config,
            target,
            localCount,
            spacingYears * (localCount - 1),
            key,
        );

const addCase = (
    cases: CapabilityCase[],
    input: Omit<CapabilityCase, "index">,
): void => {
    cases.push({ ...input, index: cases.length });
};

const buildCapabilityCasesV3 = (
    config: CapabilityConfig,
    manifest: CapabilityManifest,
): CapabilityCase[] => {
    const cases: CapabilityCase[] = [];
    if (config.scenarioGeneratorVersion !== 3) {
        throw new Error("the unified frontier benchmark requires scenario generator v3");
    }
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
            caseId: `${file.fileId}:${target.targetId}:Clean0-control`,
            family: "Clean",
            scenarioId: "Clean0-control",
            spacingYears: null,
            evaluationMode: "sequentialFrontier",
            acceptanceTier: "blocking",
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
            evaluationMode: "sequentialFrontier",
            acceptanceTier: "blocking",
            truths: [localTruth("event-1", eventType, single, partialShiftYears)],
        }));
        addCase(cases, {
            ...common,
            caseId: `${file.fileId}:${target.targetId}:A4-single-whole`,
            family: "A",
            scenarioId: "A4-single-whole",
            spacingYears: null,
            evaluationMode: "sequentialFrontier",
            acceptanceTier: "blocking",
            truths: [wholeTruth("event-1", wholeShiftYears)],
        });

        normalizedCounts(config.injection.distantEventCounts).forEach((count) => {
            ([
                ["missing", "missingRing"],
                ["false", "falseRing"],
                ["partial", "partialMove"],
            ] as const).forEach(([slug, eventType]) => {
                const scenarioId = `B-${slug}-n${count}`;
                const years = yearsForPattern(
                    config,
                    target,
                    count,
                    config.injection.distantSpacingYears,
                    `${baseKey}:${scenarioId}`,
                );
                addCase(cases, {
                    ...common,
                    caseId: `${file.fileId}:${target.targetId}:${scenarioId}`,
                    family: "B",
                    scenarioId,
                    spacingYears: config.injection.distantSpacingYears,
                    evaluationMode: "sequentialFrontier",
                    acceptanceTier: "blocking",
                    truths: years.map((year, index) => localTruth(
                        `event-${index + 1}`,
                        eventType,
                        year,
                        index % 2 === 0 ? partialShiftYears : secondPartialShiftYears,
                    )),
                });
            });
        });

        const nearSpacingYears = nearSpacingFor(config, `${baseKey}:C-spacing`);
        normalizedCounts(config.injection.nearUnitEventCounts).forEach((count) => {
            ([
                ["missing", "missingRing"],
                ["false", "falseRing"],
            ] as const).forEach(([slug, eventType]) => {
                const scenarioId = `C-${slug}-n${count}`;
                const years = yearsForPattern(
                    config,
                    target,
                    count,
                    nearSpacingYears,
                    `${baseKey}:${scenarioId}`,
                );
                addCase(cases, {
                    ...common,
                    caseId: `${file.fileId}:${target.targetId}:${scenarioId}`,
                    family: "C",
                    scenarioId,
                    spacingYears: nearSpacingYears,
                    evaluationMode: "sequentialFrontier",
                    acceptanceTier: "blocking",
                    truths: years.map((year, index) => localTruth(
                        `event-${index + 1}`,
                        eventType,
                        year,
                        partialShiftYears,
                    )),
                });
            });
        });
        if (config.injection.includeAdjacentOptionalSuccess === true) {
            ([
                ["missing", "missingRing"],
                ["false", "falseRing"],
            ] as const).forEach(([slug, eventType]) => {
                const scenarioId = `C-optional-adjacent-${slug}`;
                const years = yearsForPattern(
                    config,
                    target,
                    2,
                    1,
                    `${baseKey}:${scenarioId}`,
                );
                addCase(cases, {
                    ...common,
                    caseId: `${file.fileId}:${target.targetId}:${scenarioId}`,
                    family: "C",
                    scenarioId,
                    spacingYears: 1,
                    evaluationMode: "sequentialFrontier",
                    acceptanceTier: "optionalSuccess",
                    truths: years.map((year, index) => localTruth(
                        `event-${index + 1}`,
                        eventType,
                        year,
                        partialShiftYears,
                    )),
                });
            });
        }

        distantMixedPatterns.forEach((pattern, patternIndex) => {
            const localCount = pattern.operations.filter((operation) => (
                operation !== "wholeSeriesMove"
            )).length;
            const years = yearsForPattern(
                config,
                target,
                localCount,
                config.injection.distantSpacingYears,
                `${baseKey}:D:${pattern.slug}`,
            );
            const scenarioId = `D${patternIndex + 1}-${pattern.slug}`;
            addCase(cases, {
                ...common,
                caseId: `${file.fileId}:${target.targetId}:${scenarioId}`,
                family: "D",
                scenarioId,
                spacingYears: localCount >= 2
                    ? config.injection.distantSpacingYears
                    : null,
                evaluationMode: "sequentialFrontier",
                acceptanceTier: "blocking",
                truths: buildPatternTruths(
                    pattern,
                    years,
                    partialShiftYears,
                    secondPartialShiftYears,
                    wholeShiftYears,
                ),
            });
        });
    }));
    return cases;
};

type SinglePattern = {
    slug: string;
    operation: CapabilityOperation;
};

type SameTypePattern = {
    slug: string;
    operation: Exclude<CapabilityOperation, "wholeSeriesMove">;
    count: number;
};

type NearUnitPattern = {
    slug: string;
    operation: "missingRing" | "falseRing";
    count: number;
    spacingYears: number;
};

const configuredNearSpacings = (config: CapabilityConfig): number[] => {
    const values = Array.isArray(config.injection.nearSpacingYears)
        ? config.injection.nearSpacingYears
        : [config.injection.nearSpacingYears];
    const valid = Array.from(new Set(values)).filter((value) => (
        Number.isInteger(value) && value >= 2 && value <= 13
    )).sort((left, right) => left - right);
    if (valid.length === 0) throw new Error("near spacing must be within 2-13 years");
    return valid;
};

const buildBalancedCapabilityCases = (
    config: CapabilityConfig,
    manifest: CapabilityManifest,
    generatorVersion: 4 | 5,
): CapabilityCase[] => {
    if (config.design?.scenarioSampling !== "balancedOnePerFamily"
        || config.design.casesPerTargetPerFamily !== 1) {
        throw new Error(
            `scenario generator v${generatorVersion}`
            + " requires one balanced case per target and family",
        );
    }
    if (generatorVersion === 5 && (
        config.injection.wholeShiftYears.length === 0
        || config.injection.wholeShiftYears.some((shift) => (
            !Number.isInteger(shift) || shift >= 0
        ))
    )) {
        throw new Error("scenario generator v5 allows only negative whole-series shifts");
    }
    const cases: CapabilityCase[] = [];
    const wholeShiftCounters: Record<"A" | "D", number> = { A: 0, D: 0 };
    const nextWholeShift = (family: "A" | "D"): number => {
        if (generatorVersion === 4) {
            throw new Error("v4 whole shifts remain target-balanced");
        }
        const shifts = config.injection.wholeShiftYears;
        const phase = stableHash(`${config.seed}:${family}:whole-shift-phase`) % shifts.length;
        const shift = shifts[(phase + wholeShiftCounters[family]) % shifts.length];
        wholeShiftCounters[family] += 1;
        return shift;
    };
    const singlePatterns: SinglePattern[] = [
        { slug: "missing", operation: "missingRing" },
        { slug: "false", operation: "falseRing" },
        { slug: "partial", operation: "partialMove" },
        { slug: "whole", operation: "wholeSeriesMove" },
    ];
    const sameTypePatterns: SameTypePattern[] = normalizedCounts(
        config.injection.distantEventCounts,
    ).flatMap((count) => ([
        { slug: `missing-n${count}`, operation: "missingRing" as const, count },
        { slug: `false-n${count}`, operation: "falseRing" as const, count },
        { slug: `partial-n${count}`, operation: "partialMove" as const, count },
    ]));
    const nearUnitPatterns: NearUnitPattern[] = configuredNearSpacings(config)
        .flatMap((spacingYears) => normalizedCounts(
            config.injection.nearUnitEventCounts,
        ).flatMap((count) => ([
            {
                slug: `missing-n${count}-gap${spacingYears}`,
                operation: "missingRing" as const,
                count,
                spacingYears,
            },
            {
                slug: `false-n${count}-gap${spacingYears}`,
                operation: "falseRing" as const,
                count,
                spacingYears,
            },
        ])));

    manifest.files.forEach((file) => file.eligibleTargets.forEach((target, targetIndex) => {
        const baseKey = `${config.seed}:${file.fileId}:${target.targetId}`;
        const partialShiftYears = balanced(
            config.injection.partialShiftYears,
            `${baseKey}:partial-shift`,
        );
        const secondPartialShiftYears = balanced(
            [...config.injection.partialShiftYears].reverse(),
            `${baseKey}:second-partial-shift`,
        );
        const wholeShiftYears = balanced(
            config.injection.wholeShiftYears,
            `${baseKey}:whole-shift`,
        );
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
            caseId: `${file.fileId}:${target.targetId}:Clean0-control-v${generatorVersion}`,
            family: "Clean",
            scenarioId: `Clean0-control-v${generatorVersion}`,
            spacingYears: null,
            evaluationMode: "sequentialFrontier",
            acceptanceTier: "blocking",
            truths: [],
        });

        const single = cyclic(
            singlePatterns,
            targetIndex,
            `${config.seed}:${file.fileId}:A-pattern`,
        );
        const singleYear = anchorYears(
            config,
            target,
            0,
            `${baseKey}:A:${single.slug}`,
        ).single;
        const aScenarioId = `A-${single.slug}-v${generatorVersion}`;
        const aWholeShiftYears = single.operation === "wholeSeriesMove"
            && generatorVersion === 5
            ? nextWholeShift("A")
            : wholeShiftYears;
        addCase(cases, {
            ...common,
            wholeShiftYears: aWholeShiftYears,
            caseId: `${file.fileId}:${target.targetId}:${aScenarioId}`,
            family: "A",
            scenarioId: aScenarioId,
            spacingYears: null,
            evaluationMode: "sequentialFrontier",
            acceptanceTier: "blocking",
            truths: [single.operation === "wholeSeriesMove"
                ? wholeTruth("event-1", aWholeShiftYears)
                : localTruth(
                        "event-1",
                        single.operation,
                        singleYear,
                        partialShiftYears,
                    )],
        });

        const sameType = cyclic(
            sameTypePatterns,
            targetIndex,
            `${config.seed}:${file.fileId}:B-pattern`,
        );
        const bScenarioId = `B-${sameType.slug}-v${generatorVersion}`;
        const bYears = yearsForPattern(
            config,
            target,
            sameType.count,
            config.injection.distantSpacingYears,
            `${baseKey}:${bScenarioId}`,
        );
        addCase(cases, {
            ...common,
            caseId: `${file.fileId}:${target.targetId}:${bScenarioId}`,
            family: "B",
            scenarioId: bScenarioId,
            spacingYears: config.injection.distantSpacingYears,
            evaluationMode: "sequentialFrontier",
            acceptanceTier: "blocking",
            truths: bYears.map((year, index) => localTruth(
                `event-${index + 1}`,
                sameType.operation,
                year,
                index % 2 === 0 ? partialShiftYears : secondPartialShiftYears,
            )),
        });

        const nearUnit = cyclic(
            nearUnitPatterns,
            targetIndex,
            `${config.seed}:${file.fileId}:C-pattern`,
        );
        const cScenarioId = `C-${nearUnit.slug}-v${generatorVersion}`;
        const cYears = yearsForPattern(
            config,
            target,
            nearUnit.count,
            nearUnit.spacingYears,
            `${baseKey}:${cScenarioId}`,
        );
        addCase(cases, {
            ...common,
            caseId: `${file.fileId}:${target.targetId}:${cScenarioId}`,
            family: "C",
            scenarioId: cScenarioId,
            spacingYears: nearUnit.spacingYears,
            evaluationMode: "sequentialFrontier",
            acceptanceTier: "blocking",
            truths: cYears.map((year, index) => localTruth(
                `event-${index + 1}`,
                nearUnit.operation,
                year,
                partialShiftYears,
            )),
        });

        const mixed = cyclic(
            distantMixedPatterns,
            targetIndex,
            `${config.seed}:${file.fileId}:D-pattern`,
        );
        const dScenarioId = `D-${mixed.slug}-v${generatorVersion}`;
        const dWholeShiftYears = mixed.operations.includes("wholeSeriesMove")
            && generatorVersion === 5
            ? nextWholeShift("D")
            : wholeShiftYears;
        const localCount = mixed.operations.filter((operation) => (
            operation !== "wholeSeriesMove"
        )).length;
        const dYears = yearsForPattern(
            config,
            target,
            localCount,
            config.injection.distantSpacingYears,
            `${baseKey}:${dScenarioId}`,
        );
        addCase(cases, {
            ...common,
            wholeShiftYears: dWholeShiftYears,
            caseId: `${file.fileId}:${target.targetId}:${dScenarioId}`,
            family: "D",
            scenarioId: dScenarioId,
            spacingYears: localCount >= 2
                ? config.injection.distantSpacingYears
                : null,
            evaluationMode: "sequentialFrontier",
            acceptanceTier: "blocking",
            truths: buildPatternTruths(
                mixed,
                dYears,
                partialShiftYears,
                secondPartialShiftYears,
                dWholeShiftYears,
            ),
        });
    }));
    return cases;
};

type ExternalPositionBand = "middle" | "newer" | "barkNear";

type ExternalScenarioPlan = {
    key: string;
    family: "A" | "B" | "C" | "D";
    file: CapabilityManifest["files"][number];
    target: CapabilityTarget;
    targetIndex: number;
    operationPattern: CapabilityOperation[];
    localCount: number;
    eventCount: number;
    spacingYears: number;
    partialShiftYears: number;
    secondPartialShiftYears: number;
    wholeShiftYears: number;
    positionBand: ExternalPositionBand | null;
    frontierDistance: number | null;
};

const externalPositionBounds: Record<
    ExternalPositionBand,
    { minimum: number; maximum: number | null }
> = {
    barkNear: { minimum: 15, maximum: 34 },
    newer: { minimum: 35, maximum: 69 },
    middle: { minimum: 70, maximum: null },
};

const eventCountChoices = (target: CapabilityTarget): number[] => (
    target.seriesYears < 200
        ? [2]
        : target.seriesYears < 300
            ? [2, 3]
            : [3, 4]
);

const preferredEventCount = (
    target: CapabilityTarget,
    key: string,
): number => balanced(eventCountChoices(target), key);

const maximumFrontierDistance = (
    config: CapabilityConfig,
    target: CapabilityTarget,
    localCount: number,
    spacingYears: number,
): number => (
    target.endYear
    - target.startYear
    - config.selection.minimumOlderContextYears
    - Math.max(0, localCount - 1) * spacingYears
);

const feasiblePositionBands = (
    config: CapabilityConfig,
    plan: ExternalScenarioPlan,
): ExternalPositionBand[] => {
    if (plan.localCount === 0) return [];
    const maximumDistance = maximumFrontierDistance(
        config,
        plan.target,
        plan.localCount,
        plan.spacingYears,
    );
    return (["barkNear", "newer", "middle"] as const).filter((band) => (
        maximumDistance >= externalPositionBounds[band].minimum
    ));
};

const positionQuotas = (
    total: number,
    weights: NonNullable<CapabilityConfig["design"]>["eventPositionWeights"],
): Record<ExternalPositionBand, number> => {
    const normalized = weights ?? { middle: 0.4, newer: 0.35, barkNear: 0.25 };
    const raw = (["middle", "newer", "barkNear"] as const).map((band) => ({
        band,
        exact: total * normalized[band],
    }));
    const quota = Object.fromEntries(raw.map(({ band, exact }) => (
        [band, Math.floor(exact)]
    ))) as Record<ExternalPositionBand, number>;
    let remainder = total - Object.values(quota).reduce((sum, value) => sum + value, 0);
    raw.sort((left, right) => (
        (right.exact - Math.floor(right.exact))
        - (left.exact - Math.floor(left.exact))
        || left.band.localeCompare(right.band)
    )).forEach(({ band }) => {
        if (remainder <= 0) return;
        quota[band] += 1;
        remainder -= 1;
    });
    return quota;
};

const assignExternalPositions = (
    config: CapabilityConfig,
    plans: ExternalScenarioPlan[],
): void => {
    (["A", "B", "C", "D"] as const).forEach((family) => {
        const localPlans = plans.filter((plan) => (
            plan.family === family && plan.localCount > 0
        ));
        const quotas = positionQuotas(
            localPlans.length,
            config.design?.eventPositionWeights,
        );
        const assigned: Record<ExternalPositionBand, number> = {
            middle: 0,
            newer: 0,
            barkNear: 0,
        };
        [...localPlans].sort((left, right) => {
            const leftFeasible = feasiblePositionBands(config, left).length;
            const rightFeasible = feasiblePositionBands(config, right).length;
            return leftFeasible - rightFeasible
                || stableHash(left.key) - stableHash(right.key)
                || left.key.localeCompare(right.key);
        }).forEach((plan) => {
            const feasible = feasiblePositionBands(config, plan);
            if (feasible.length === 0) {
                throw new Error(`no feasible external position: ${plan.key}`);
            }
            const selected = [...feasible].sort((left, right) => (
                (quotas[right] - assigned[right]) - (quotas[left] - assigned[left])
                || stableHash(`${plan.key}:${left}`) - stableHash(`${plan.key}:${right}`)
                || left.localeCompare(right)
            ))[0];
            const bounds = externalPositionBounds[selected];
            const maximumDistance = maximumFrontierDistance(
                config,
                plan.target,
                plan.localCount,
                plan.spacingYears,
            );
            const upper = Math.min(bounds.maximum ?? maximumDistance, maximumDistance);
            const width = upper - bounds.minimum + 1;
            if (width <= 0) throw new Error(`invalid external position range: ${plan.key}`);
            plan.positionBand = selected;
            plan.frontierDistance = bounds.minimum
                + stableHash(`${plan.key}:frontier-distance`) % width;
            assigned[selected] += 1;
        });
    });
};

const externalYears = (plan: ExternalScenarioPlan): number[] => {
    if (plan.localCount === 0 || plan.frontierDistance === null) return [];
    const newest = plan.target.endYear - plan.frontierDistance;
    return Array.from({ length: plan.localCount }, (_, index) => (
        newest - (plan.localCount - index - 1) * plan.spacingYears
    ));
};

const externalPatternForD = (
    count: number,
    targetIndex: number,
    key: string,
): LocalPattern => {
    const patterns = distantMixedPatterns.filter((pattern) => (
        pattern.operations.length === count
    ));
    if (patterns.length === 0) throw new Error(`no D pattern for ${count} events`);
    return cyclic(patterns, targetIndex, key);
};

const buildFrozenExternalCapabilityCases = (
    config: CapabilityConfig,
    manifest: CapabilityManifest,
): CapabilityCase[] => {
    if (config.scenarioGeneratorVersion !== 6
        || config.protocolVersion !== "itrdb-frozen-external-v1"
        || config.design?.scenarioSampling !== "balancedOnePerFamily"
        || config.design.casesPerTargetPerFamily !== 1
        || config.design.lengthAwareEventCounts !== true) {
        throw new Error("external scenario generator v6 requires the frozen external protocol");
    }
    if (config.injection.wholeShiftYears.length === 0
        || config.injection.wholeShiftYears.some((shift) => (
            !Number.isInteger(shift) || shift >= 0
        ))) {
        throw new Error("external scenario generator allows only negative whole shifts");
    }
    const flattened = manifest.files.flatMap((file) => (
        file.eligibleTargets.map((target) => ({ file, target }))
    ));
    const plans: ExternalScenarioPlan[] = [];
    const wholeShiftCounters: Record<"A" | "D", number> = { A: 0, D: 0 };
    const nextWholeShift = (family: "A" | "D"): number => {
        const shifts = config.injection.wholeShiftYears;
        const phase = stableHash(`${config.seed}:${family}:external-whole-phase`) % shifts.length;
        const shift = shifts[(phase + wholeShiftCounters[family]) % shifts.length];
        wholeShiftCounters[family] += 1;
        return shift;
    };
    const singlePatterns: CapabilityOperation[] = [
        "missingRing", "falseRing", "partialMove", "wholeSeriesMove",
    ];
    const nearSpacings = configuredNearSpacings(config);
    flattened.forEach(({ file, target }, targetIndex) => {
        const baseKey = `${config.seed}:${file.fileId}:${target.targetId}`;
        const partialShiftYears = balanced(
            config.injection.partialShiftYears,
            `${baseKey}:partial-shift`,
        );
        const secondPartialShiftYears = balanced(
            [...config.injection.partialShiftYears].reverse(),
            `${baseKey}:second-partial-shift`,
        );
        const aOperation = cyclic(
            singlePatterns,
            targetIndex,
            `${config.seed}:A-operation`,
        );
        const aWholeShift = aOperation === "wholeSeriesMove"
            ? nextWholeShift("A")
            : balanced(config.injection.wholeShiftYears, `${baseKey}:A-whole`);
        plans.push({
            key: `${baseKey}:A`, family: "A", file, target, targetIndex,
            operationPattern: [aOperation],
            localCount: aOperation === "wholeSeriesMove" ? 0 : 1,
            eventCount: 1,
            spacingYears: 0,
            partialShiftYears,
            secondPartialShiftYears,
            wholeShiftYears: aWholeShift,
            positionBand: null,
            frontierDistance: null,
        });

        const count = preferredEventCount(target, `${baseKey}:event-count`);
        const bOperation = cyclic(
            ["missingRing", "falseRing", "partialMove"] as const,
            targetIndex,
            `${config.seed}:B-operation`,
        );
        plans.push({
            key: `${baseKey}:B`, family: "B", file, target, targetIndex,
            operationPattern: Array.from({ length: count }, () => bOperation),
            localCount: count,
            eventCount: count,
            spacingYears: config.injection.distantSpacingYears,
            partialShiftYears,
            secondPartialShiftYears,
            wholeShiftYears: balanced(config.injection.wholeShiftYears, `${baseKey}:B-whole`),
            positionBand: null,
            frontierDistance: null,
        });

        const cOperation = cyclic(
            ["missingRing", "falseRing"] as const,
            targetIndex,
            `${config.seed}:C-operation`,
        );
        const cSpacing = cyclic(
            nearSpacings,
            targetIndex,
            `${config.seed}:C-spacing`,
        );
        plans.push({
            key: `${baseKey}:C`, family: "C", file, target, targetIndex,
            operationPattern: Array.from({ length: count }, () => cOperation),
            localCount: count,
            eventCount: count,
            spacingYears: cSpacing,
            partialShiftYears,
            secondPartialShiftYears,
            wholeShiftYears: balanced(config.injection.wholeShiftYears, `${baseKey}:C-whole`),
            positionBand: null,
            frontierDistance: null,
        });

        const dPattern = externalPatternForD(
            count,
            targetIndex,
            `${config.seed}:D-pattern`,
        );
        const dWholeShift = dPattern.operations.includes("wholeSeriesMove")
            ? nextWholeShift("D")
            : balanced(config.injection.wholeShiftYears, `${baseKey}:D-whole`);
        plans.push({
            key: `${baseKey}:D`, family: "D", file, target, targetIndex,
            operationPattern: dPattern.operations,
            localCount: dPattern.operations.filter((operation) => (
                operation !== "wholeSeriesMove"
            )).length,
            eventCount: count,
            spacingYears: config.injection.distantSpacingYears,
            partialShiftYears,
            secondPartialShiftYears,
            wholeShiftYears: dWholeShift,
            positionBand: null,
            frontierDistance: null,
        });
    });
    assignExternalPositions(config, plans);

    const cases: CapabilityCase[] = [];
    flattened.forEach(({ file, target }) => {
        const baseKey = `${config.seed}:${file.fileId}:${target.targetId}`;
        const targetPlans = plans.filter((plan) => (
            plan.file.fileId === file.fileId && plan.target.targetId === target.targetId
        ));
        const common = {
            fileId: file.fileId,
            relativePath: file.relativePath,
            targetId: target.targetId,
            seriesYears: target.seriesYears,
            targetStartYear: target.startYear,
            targetEndYear: target.endYear,
            masterCorrelation: target.masterCorrelation,
            problemSegments: target.problemSegments,
        };
        addCase(cases, {
            ...common,
            caseId: `${file.fileId}:${target.targetId}:Clean0-control-v6`,
            family: "Clean",
            scenarioId: "Clean0-control-v6",
            spacingYears: null,
            partialShiftYears: balanced(config.injection.partialShiftYears, `${baseKey}:partial-shift`),
            wholeShiftYears: balanced(config.injection.wholeShiftYears, `${baseKey}:clean-whole`),
            eventCount: 0,
            frontierPositionBand: null,
            frontierDistanceFromNewest: null,
            evaluationMode: "sequentialFrontier",
            acceptanceTier: "blocking",
            truths: [],
        });
        targetPlans.forEach((plan) => {
            const years = externalYears(plan);
            const truths = buildPatternTruths(
                { slug: plan.family, operations: plan.operationPattern },
                years,
                plan.partialShiftYears,
                plan.secondPartialShiftYears,
                plan.wholeShiftYears,
            );
            addCase(cases, {
                ...common,
                caseId: `${file.fileId}:${target.targetId}:${plan.family}-external-v6`,
                family: plan.family,
                scenarioId: `${plan.family}-external-v6`,
                spacingYears: plan.localCount >= 2 ? plan.spacingYears : null,
                partialShiftYears: plan.partialShiftYears,
                wholeShiftYears: plan.wholeShiftYears,
                eventCount: plan.eventCount,
                frontierPositionBand: plan.positionBand,
                frontierDistanceFromNewest: plan.frontierDistance,
                evaluationMode: "sequentialFrontier",
                acceptanceTier: "blocking",
                truths,
            });
        });
    });
    return cases;
};

export const buildCapabilityCases = (
    config: CapabilityConfig,
    manifest: CapabilityManifest,
): CapabilityCase[] => config.scenarioGeneratorVersion === 3
    ? buildCapabilityCasesV3(config, manifest)
    : config.scenarioGeneratorVersion === 4
        ? buildBalancedCapabilityCases(config, manifest, 4)
        : config.scenarioGeneratorVersion === 5
            ? buildBalancedCapabilityCases(config, manifest, 5)
            : config.scenarioGeneratorVersion === 6
                ? buildFrozenExternalCapabilityCases(config, manifest)
                : (() => { throw new Error("unsupported scenario generator version"); })();
