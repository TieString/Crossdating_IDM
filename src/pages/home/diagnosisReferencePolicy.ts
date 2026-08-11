import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";

/** Manual references are visual aids and must never steer automatic diagnosis. */
export const selectAutomaticDiagnosisReferenceConfig = (
    referenceConfig: ReferenceSeriesConfig | null,
): ReferenceSeriesConfig | null => (
    referenceConfig?.mode === "dynamic" ? referenceConfig : null
);
