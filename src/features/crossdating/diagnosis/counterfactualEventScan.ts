/**
 * Broad but hard-gated single-edit scan used to recover event locations missed by segment drafts.
 * The scan only proposes review evidence: executable candidates still pass through evaluateDraft.
 */
import { CrossdateConfig } from "./config";
import { compareDiagnosisCandidates, dedupeDiagnosisCandidates, rankDiagnosisCandidates } from "./candidateUtils";
import { evaluateDraft } from "./evaluation";
import { makeDiagnosisEventsFromCandidates } from "./events";
import { getSegmentNearYear, prescanEditYearsInRegion } from "./rangeMove";
import type { RwlSiteData } from "@/features/rwl/types";
import type {
    CandidateDraft,
    DiagnosisCandidateOperation,
    DiagnosisEvent,
    EffectiveDiagnosisConfig,
    SeriesCoreDiagnosis,
} from "./types";

export type CounterfactualEventScanConfig = {
    prescanYearsPerType: number;
    candidatesPerType: number;
    minimumScore: number;
    requireStrong: boolean;
};

export const DEFAULT_COUNTERFACTUAL_EVENT_SCAN_CONFIG: CounterfactualEventScanConfig = {
    prescanYearsPerType: 12,
    candidatesPerType: 5,
    minimumScore: CrossdateConfig.evaluationV2.acceptanceThreshold,
    requireStrong: true,
};

const makeDraft = (
    diagnosis: SeriesCoreDiagnosis,
    editType: "insert" | "delete",
    year: number,
): CandidateDraft | null => {
    const sourceSegment = getSegmentNearYear(diagnosis.segments, year);
    if (!sourceSegment) return null;
    const insert = editType === "insert";
    return {
        targetTree: diagnosis.targetTree,
        operationType: insert ? "INSERT_MISSING_RING" : "DELETE_FALSE_RING",
        candidateType: insert ? "insertMissingYear" : "deleteFalseYear",
        anchorYear: year,
        targetYear: year,
        selectedRange: {
            startYear: diagnosis.targetRange.startYear,
            endYear: year,
        },
        missingRange: insert ? { startYear: year, endYear: year } : undefined,
        side: "right",
        sourceSegment,
        algorithmSource: ["local_edit_alignment", "segmented_diagnosis"],
        recallSourceTags: ["broad_counterfactual_prescan"],
    };
};

export const scanCounterfactualCandidates = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    effectiveConfig: EffectiveDiagnosisConfig,
    overrides: Partial<CounterfactualEventScanConfig> = {},
): DiagnosisCandidateOperation[] => {
    const config = { ...DEFAULT_COUNTERFACTUAL_EVENT_SCAN_CONFIG, ...overrides };
    const candidates: DiagnosisCandidateOperation[] = [];
    (["insert", "delete"] as const).forEach((editType) => {
        const years = prescanEditYearsInRegion(
            diagnosis,
            editType,
            diagnosis.targetRange.startYear + 2,
            diagnosis.targetRange.endYear - 2,
            Math.round((diagnosis.targetRange.startYear + diagnosis.targetRange.endYear) / 2),
            effectiveConfig,
            config.prescanYearsPerType,
        );
        years.forEach((year) => {
            const draft = makeDraft(diagnosis, editType, year);
            if (!draft) return;
            const evaluated = evaluateDraft(siteData, diagnosis, draft, effectiveConfig, null);
            if (evaluated) candidates.push(evaluated);
        });
    });

    const deduped = dedupeDiagnosisCandidates(candidates)
        .filter((candidate) => candidate.score >= config.minimumScore)
        .filter((candidate) => !config.requireStrong || candidate.candidateStrength === "strong");
    const byType = new Map<string, DiagnosisCandidateOperation[]>();
    deduped.forEach((candidate) => {
        const values = byType.get(candidate.operationType) ?? [];
        values.push(candidate);
        byType.set(candidate.operationType, values);
    });
    return Array.from(byType.values())
        .flatMap((values) => rankDiagnosisCandidates(values)
            .sort(compareDiagnosisCandidates)
            .slice(0, config.candidatesPerType))
        .sort(compareDiagnosisCandidates);
};

export const scanCounterfactualEvents = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    effectiveConfig: EffectiveDiagnosisConfig,
    overrides: Partial<CounterfactualEventScanConfig> = {},
): DiagnosisEvent[] => makeDiagnosisEventsFromCandidates(
    [diagnosis],
    scanCounterfactualCandidates(siteData, diagnosis, effectiveConfig, overrides),
);
