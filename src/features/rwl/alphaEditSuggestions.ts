import { invoke } from "@tauri-apps/api/core";
import {
    cofechaStyleStandardize,
    type CofechaPassReference,
} from "@/features/crossdating/reference";
import { stopMarker } from "@/shared/constants";
import type { RwlTreeData } from "./types";

export type AlphaEditCostMode =
    | "wenk_2003_standardized"
    | "experimental_processed_signal";

export type AlphaEditSuggestionConfig = {
    alphaMax?: number;
    minOverlap?: number;
    topK?: number;
    scanOuterYearMin?: number;
    scanOuterYearMax?: number;
    oppositeEditMinGap?: number;
    redundancyRatio?: number;
    sortBy?: "t_value";
    costMode?: AlphaEditCostMode;
    includeRedundant?: boolean;
    includeHeuristicRejected?: boolean;
    allowLeadingInsert?: boolean;
    allowTrailingInsert?: boolean;
    allowBarkMerge?: boolean;
};

export type TargetWenkPoint = {
    ringIndex: number;
    year: number;
    rawValue: number;
    standardizedValue: number;
};

export type ReferenceWenkPoint = {
    year: number;
    standardizedValue: number;
    replication?: number;
    weight?: number;
};

export type AlphaEditOperation = {
    operationType: "insert_missing_ring_suggestion" | "merge_double_ring_suggestion";
    targetBoundaryIndex: number | null;
    targetRingIndex: number | null;
    targetRingIndex2: number | null;
    recommendedDeleteIndex: number | null;
    mergeInto: "bark_side_neighbor" | null;
    referenceYear: number;
    costContribution: number;
    operationOrder: number;
    direction: "bark_to_pith";
};

export type RawTransformationStep = {
    op: "N" | "I" | "M" | "?";
    targetRingIndex: number | null;
    targetRingIndex2: number | null;
    referenceYear: number;
    transformedValue: number;
    referenceValue: number;
    costContribution: number;
};

export type AlphaEditCandidate = {
    id: string;
    rank: number;
    suggestedOuterYear: number;
    suggestedInnerYear: number;
    referenceOuterYear: number;
    referenceInnerYear: number;
    alpha: number;
    editCount: number;
    insertCount: number;
    mergeCount: number;
    overlap: number;
    sumSquaredError: number;
    normalizedEditDistance: number;
    correlation: number | null;
    tValue: number | null;
    operations: AlphaEditOperation[];
    warnings: string[];
    isRedundant: boolean;
    redundancyReason: string | null;
    rawTransformation: RawTransformationStep[];
};

export type AlphaEditSuggestionResult = {
    seriesId: string;
    candidateCount: number;
    returnedCount: number;
    referenceOuterYear: number | null;
    referenceInnerYear: number | null;
    targetLength: number;
    alphaMax: number;
    minOverlap: number;
    costMode: AlphaEditCostMode;
    candidates: AlphaEditCandidate[];
    warnings: string[];
};

export const DEFAULT_ALPHA_EDIT_CONFIG = {
    alphaMax: 3,
    minOverlap: 50,
    topK: 20,
    oppositeEditMinGap: 10,
    redundancyRatio: 0.9,
    sortBy: "t_value",
    costMode: "wenk_2003_standardized",
    includeRedundant: false,
    includeHeuristicRejected: false,
    allowLeadingInsert: false,
    allowTrailingInsert: false,
    allowBarkMerge: false,
} satisfies Required<Omit<AlphaEditSuggestionConfig, "scanOuterYearMin" | "scanOuterYearMax">>;

const DEFAULT_SCAN_RADIUS = 20;

export function buildAlphaEditTarget(
    series: RwlTreeData,
    reference: CofechaPassReference,
): TargetWenkPoint[] {
    const standardizedByYear = new Map(
        cofechaStyleStandardize(series, reference.options)
            .filter((point) => Number.isFinite(point.year) && Number.isFinite(point.value))
            .map((point) => [point.year, point.value]),
    );

    return Array.from(series.entries())
        .filter((entry): entry is [number, number] => {
            const [, value] = entry;
            return typeof value === "number"
                && Number.isFinite(value)
                && value !== stopMarker.value;
        })
        .sort((a, b) => b[0] - a[0])
        .map(([year, rawValue], ringIndex) => {
            const standardizedValue = standardizedByYear.get(year);
            return standardizedValue === undefined
                ? null
                : {
                    ringIndex,
                    year,
                    rawValue,
                    standardizedValue,
                };
        })
        .filter((point): point is TargetWenkPoint => point !== null);
}

export function buildAlphaEditReference(reference: CofechaPassReference): ReferenceWenkPoint[] {
    return reference.points
        .filter((point) => Number.isFinite(point.year) && Number.isFinite(point.value))
        .sort((a, b) => b.year - a.year)
        .map((point) => ({
            year: point.year,
            standardizedValue: point.value,
            replication: point.replication,
            weight: point.weight,
        }));
}

export async function suggestInsertDeleteYearsAlphaEdit(params: {
    seriesId: string;
    series: RwlTreeData;
    reference: CofechaPassReference;
    config?: AlphaEditSuggestionConfig;
}): Promise<AlphaEditSuggestionResult> {
    const totalStarted = performance.now();
    const target = buildAlphaEditTarget(params.series, params.reference);
    const reference = buildAlphaEditReference(params.reference);
    const currentOuterYear = target[0]?.year;
    const config = {
        ...DEFAULT_ALPHA_EDIT_CONFIG,
        scanOuterYearMin: currentOuterYear === undefined ? undefined : currentOuterYear - DEFAULT_SCAN_RADIUS,
        scanOuterYearMax: currentOuterYear === undefined ? undefined : currentOuterYear + DEFAULT_SCAN_RADIUS,
        ...params.config,
    };

    if (target.length === 0) {
        throw new Error("目标序列标准化后没有可用于插删年建议的点");
    }
    if (reference.length === 0) {
        throw new Error("COFECHA-pass 参考序列没有可用于插删年建议的点");
    }

    console.groupCollapsed(`[Alpha edit suggestions] ${params.seriesId}`);
    console.log("input", {
        targetPoints: target.length,
        referencePoints: reference.length,
        config,
    });

    try {
        const result = await invoke<AlphaEditSuggestionResult>("suggest_insert_delete_years_alpha_edit", {
            input: {
                seriesId: params.seriesId,
                target,
                reference,
                ...config,
            },
        });
        console.table([
            { phase: "total", ms: (performance.now() - totalStarted).toFixed(1) },
            { phase: "candidates", ms: `${result.returnedCount}/${result.candidateCount}` },
        ]);
        console.log("result", {
            best: result.candidates[0] ?? null,
            warnings: result.warnings,
        });
        return result;
    } finally {
        console.groupEnd();
    }
}

export function summarizeAlphaEditOperations(candidate: AlphaEditCandidate): string {
    if (candidate.operations.length === 0) {
        return "无插删年";
    }
    return candidate.operations.map((operation) => {
        if (operation.operationType === "insert_missing_ring_suggestion") {
            return `插年 index ${operation.targetBoundaryIndex ?? "-"} / ref ${operation.referenceYear}`;
        }
        return `删年 index ${operation.recommendedDeleteIndex ?? "-"} / ref ${operation.referenceYear}`;
    }).join("; ");
}
