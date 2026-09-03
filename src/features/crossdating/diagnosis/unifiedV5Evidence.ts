/** Homologous port of the accepted 207-field research model, without test metadata. */
import type { UnifiedV5Sample } from "./unifiedV5Types";
import { buildV5OperationEvidence, V5_BASE_COLUMNS, V5_IDENTITIES } from "./unifiedV5Operations";
import { buildV5Windows, buildV5Profiles, V5_LOCAL_COLUMNS, V5_PROFILE_COLUMNS } from "./unifiedV5Windows";
import { buildV5GlobalEvidence, V5_GLOBAL_COLUMNS } from "./unifiedV5Global";

export const V5_FEATURE_COLUMNS = [...V5_BASE_COLUMNS, ...V5_LOCAL_COLUMNS, ...V5_PROFILE_COLUMNS, ...V5_GLOBAL_COLUMNS];

export function buildUnifiedV5Evidence(sample: UnifiedV5Sample, rawEntries: ReadonlyArray<readonly [number, number | null]>) {
    const context = buildV5OperationEvidence(sample);
    const windows = buildV5Windows(context, rawEntries), profiles = buildV5Profiles(context, windows);
    const global = buildV5GlobalEvidence(context);
    const features = windows.features.map((base, i) => {
        const identity = V5_IDENTITIES[windows.codes[i]!]!;
        // Local delta is never substituted for G: all local hypotheses bind G=0.
        const globalIndex = identity[0] === "whole" ? identity[1] + 100 : 100;
        const combined = new Float32Array(V5_FEATURE_COLUMNS.length);
        combined.set(base); combined.set(profiles[i]!, base.length);
        combined.set(global.features[globalIndex]!, base.length + profiles[i]!.length);
        return combined;
    });
    return { features, codes: windows.codes, starts: windows.starts, context, global };
}
