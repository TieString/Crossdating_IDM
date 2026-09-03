import { V5_FEATURE_COLUMNS } from "./unifiedV5Evidence";
import { V5_IDENTITIES, type V5Identity } from "./unifiedV5Operations";
import { V5_PROPOSAL_SPEC, type V5ProposalSpec } from "./unifiedV5Windows";

type TreeNode = { leaf_value: number } | {
    split_feature: number; threshold: number; decision_type: string; missing_type: "None" | "NaN" | "Zero";
    default_left: boolean; left_child: TreeNode; right_child: TreeNode;
};
export type UnifiedV5Model = {
    schemaVersion: 1; version: string; columns: string[]; identities: V5Identity[];
    proposalSpec: V5ProposalSpec; eventGate: number; windowWidth: number;
    sourceSha256: string; objective: string; averageOutput: boolean;
    treeInfo: Array<{ tree_structure: TreeNode }>;
};
type CompiledTree = { feature: Int32Array; threshold: Float64Array; left: Int32Array; right: Int32Array;
    defaultLeft: Uint8Array; missing: Uint8Array };
export const UNIFIED_V5_MODEL_VERSION = "joint-explicit-global-v5";
export const UNIFIED_V5_RUNTIME_VERSION = "joint-explicit-global-v5-sign-invariant-v1";
export const UNIFIED_V5_SOURCE_SHA256 = "ea06e86c66cf26eabe9a571a41e7088ca7d5146f217298a4b799df883dbd109c";
export const UNIFIED_V5_EVENT_GATE = -0.5126752297719945;
export const UNIFIED_V5_ASSET_SHA256 = "4a355af59c22a9cd53e20d233256d94b44b83aea222d7ace55e6cb7e9bbb5c1e";

function compile(root: TreeNode): CompiledTree {
    const feature: number[] = [], threshold: number[] = [], left: number[] = [], right: number[] = [], defaultLeft: number[] = [], missing: number[] = [];
    function append(node: TreeNode): number {
        const at = feature.length;
        feature.push(-1); threshold.push(0); left.push(0); right.push(0); defaultLeft.push(0); missing.push(0);
        if ("leaf_value" in node) threshold[at] = node.leaf_value;
        else {
            if (node.decision_type !== "<=") throw new Error("Unexpected categorical split in numerical v5 model");
            feature[at] = node.split_feature; threshold[at] = node.threshold;
            defaultLeft[at] = Number(node.default_left);
            missing[at] = node.missing_type === "NaN" ? 1 : node.missing_type === "Zero" ? 2 : 0;
            left[at] = append(node.left_child); right[at] = append(node.right_child);
        }
        return at;
    }
    append(root);
    return { feature: Int32Array.from(feature), threshold: Float64Array.from(threshold),
        left: Int32Array.from(left), right: Int32Array.from(right), defaultLeft: Uint8Array.from(defaultLeft), missing: Uint8Array.from(missing) };
}

/** An injected, version-checked frozen model keeps gold tests out of UI loading. */
export class UnifiedV5Predictor {
    private readonly trees: CompiledTree[];
    constructor(readonly model: UnifiedV5Model) {
        if (model.schemaVersion !== 1 || model.version !== UNIFIED_V5_MODEL_VERSION || model.sourceSha256 !== UNIFIED_V5_SOURCE_SHA256
            || model.windowWidth !== 13 || model.averageOutput || !model.objective.startsWith("lambdarank")
            || JSON.stringify(model.columns) !== JSON.stringify(V5_FEATURE_COLUMNS)
            || JSON.stringify(model.identities) !== JSON.stringify(V5_IDENTITIES)
            || JSON.stringify(model.proposalSpec) !== JSON.stringify(V5_PROPOSAL_SPEC)
            || model.eventGate !== UNIFIED_V5_EVENT_GATE) throw new Error("Frozen v5 model contract mismatch");
        this.trees = model.treeInfo.map(tree => compile(tree.tree_structure));
    }
    score(features: ArrayLike<number>): number {
        if (features.length !== V5_FEATURE_COLUMNS.length) throw new Error("V5 feature count mismatch");
        let score = 0;
        for (const tree of this.trees) {
            let node = 0;
            while (tree.feature[node]! >= 0) {
                let value = features[tree.feature[node]!]!;
                const missing = tree.missing[node]!;
                if (Number.isNaN(value) && missing !== 1) value = 0;
                const isMissing = missing === 1 ? Number.isNaN(value) : missing === 2 && Math.abs(value) <= 1e-35;
                const goLeft = isMissing ? tree.defaultLeft[node] === 1 : value <= tree.threshold[node]!;
                node = goLeft ? tree.left[node]! : tree.right[node]!;
            }
            // LightGBM's exported leaves already include learning-rate scaling.
            score += tree.threshold[node]!;
        }
        return score;
    }
    scoreCandidate(features: ArrayLike<number>, identity: number, wholeDirectionInvariant = false): number {
        const [operation, shift] = V5_IDENTITIES[identity]!;
        if (!wholeDirectionInvariant || operation !== "whole" || shift <= 0) return this.score(features);
        // Direction remains in the physical lag hypothesis/output. The ranker's
        // scalar descriptor uses the same embedding for equally large whole shifts;
        // otherwise a head trained on negative wholes treats positive sign as false-ring evidence.
        const canonical = Float32Array.from(features);
        canonical[V5_FEATURE_COLUMNS.indexOf("shift")] = -shift;
        return this.score(canonical);
    }
    predict(features: readonly Float32Array[], codes: Int16Array, starts: Int32Array, wholeDirectionInvariant = false) {
        if (features.length !== codes.length || codes.length !== starts.length) throw new Error("V5 candidate shape mismatch");
        const candidateScores = Float64Array.from(features, (row, index) => this.scoreCandidate(row, codes[index]!, wholeDirectionInvariant));
        const identityScores = new Float64Array(V5_IDENTITIES.length).fill(-1e9), windows = new Int32Array(V5_IDENTITIES.length);
        for (let row = 0; row < codes.length; row++) {
            const identity = codes[row]!;
            if (candidateScores[row]! > identityScores[identity]!) {
                identityScores[identity] = candidateScores[row]!; windows[identity] = starts[row]!;
            }
        }
        let best = 1;
        for (let i = 2; i < identityScores.length; i++) if (identityScores[i]! > identityScores[best]!) best = i;
        const margin = identityScores[best]! - identityScores[0]!;
        const chosen = margin > this.model.eventGate ? best : 0;
        const [operation, shift] = V5_IDENTITIES[chosen]!;
        const windowStart = operation === "none" || operation === "whole" ? null : windows[chosen]!;
        const missing = V5_IDENTITIES.findIndex(([op]) => op === "missing");
        return { operation, shift, windowStart, windowEnd: windowStart === null ? null : windowStart + 12,
            missingReviewStart: operation === "partial" ? windows[missing]! : null,
            margin, chosen, candidateScores, identityScores, windows };
    }
}
