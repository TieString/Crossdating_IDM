import { invoke } from "@tauri-apps/api/core";
import type { AuthoritativeDiagnosisDecision } from "@/features/crossdating/diagnosis/types";

export type AuthoritativeDiagnosisRequest = {
    rwlText: string;
    outText: string;
    targetId: string;
};

export const runAuthoritativeUnifiedDiagnosis = (
    request: AuthoritativeDiagnosisRequest,
): Promise<AuthoritativeDiagnosisDecision> => invoke<AuthoritativeDiagnosisDecision>(
    "run_authoritative_unified_diagnosis",
    { request },
);
