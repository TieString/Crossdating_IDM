import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";

/** Production diagnosis requires a generated chronology and never falls back to manual/LOO. */
export const selectAutomaticDiagnosisReferenceConfig = (
    referenceConfig: ReferenceSeriesConfig | null,
): ReferenceSeriesConfig | null => (
    referenceConfig?.mode === "dynamic"
        && referenceConfig.isStale !== true
        && Boolean(referenceConfig.cofechaPassReference?.points.length)
        ? referenceConfig
        : null
);
