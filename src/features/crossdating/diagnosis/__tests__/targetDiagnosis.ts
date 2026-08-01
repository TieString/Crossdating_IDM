import type { RwlSiteData } from "@/features/rwl/types";
import { compareDiagnosisCandidates, dedupeDiagnosisCandidates, rankDiagnosisCandidates } from "../candidateUtils";
import { getConfig } from "../config";
import { makeGlobalSlidingDrafts, makePatternDrafts, makeSegmentDrafts } from "../drafts";
import {
    INTERNAL_EVENT_ENSEMBLE_OPTIONS,
    makeDiagnosisEvents,
    type DiagnosisEventEnsembleOptions,
} from "../eventEnsemble";
import { evaluateDraft } from "../evaluation";
import { diagnoseSeriesCore } from "../segments";
import type { DiagnosisCandidateOperation, DiagnosisEvent, SeriesCoreDiagnosis } from "../types";

export type TargetDiagnosisBundle = {
    diagnosis: SeriesCoreDiagnosis;
    candidates: DiagnosisCandidateOperation[];
    events: DiagnosisEvent[];
};

/** Production-equivalent no-COFECHA diagnosis restricted to one target series for benchmarks. */
export const diagnoseTargetEvents = (
    siteData: RwlSiteData,
    targetTree: string,
    options: DiagnosisEventEnsembleOptions = {},
): DiagnosisEvent[] => diagnoseTargetBundle(siteData, targetTree, options)?.events ?? [];

export const diagnoseTargetBundle = (
    siteData: RwlSiteData,
    targetTree: string,
    options: DiagnosisEventEnsembleOptions = {},
): TargetDiagnosisBundle | null => {
    const eventOptions = {
        ...INTERNAL_EVENT_ENSEMBLE_OPTIONS,
        ...options,
        eventOperationRecoveryConfig: {
            ...INTERNAL_EVENT_ENSEMBLE_OPTIONS.eventOperationRecoveryConfig,
            ...options.eventOperationRecoveryConfig,
        },
    };
    const config = getConfig({ referenceConfig: null });
    const diagnosis = diagnoseSeriesCore(siteData, targetTree, config);
    if (!diagnosis) return null;
    const drafts = [
        ...makeGlobalSlidingDrafts(diagnosis),
        ...makePatternDrafts(diagnosis, config),
        ...makeSegmentDrafts(diagnosis, config),
    ];
    const evaluated = dedupeDiagnosisCandidates(
        drafts
            .map((draft) => evaluateDraft(siteData, diagnosis, draft, config, null))
            .filter((candidate): candidate is DiagnosisCandidateOperation => candidate !== null),
    );
    const candidates = rankDiagnosisCandidates(evaluated)
        .sort(compareDiagnosisCandidates)
        .slice(0, config.maxTopCandidates);
    return {
        diagnosis,
        candidates,
        events: makeDiagnosisEvents(siteData, [diagnosis], candidates, config, eventOptions),
    };
};
