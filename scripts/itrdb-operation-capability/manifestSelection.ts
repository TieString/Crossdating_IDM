import { createHash } from "node:crypto";
import type { CapabilityConfig, CapabilityTarget } from "./types";

const targetOrderKey = (seed: string, fileId: string, targetId: string): string => (
    createHash("sha256").update(`${seed}:${fileId}:${targetId}`).digest("hex")
);

export const selectManifestTargets = (
    config: CapabilityConfig,
    fileId: string,
    eligibleTargets: readonly CapabilityTarget[],
): CapabilityTarget[] => {
    const maximumTargets = config.selection.maximumTargetsPerFile;
    if (!Number.isInteger(maximumTargets) || maximumTargets! <= 0) {
        return [...eligibleTargets].sort((left, right) => (
            left.targetId.localeCompare(right.targetId)
        ));
    }
    const seed = config.selection.targetSelectionSeed ?? config.seed;
    return [...eligibleTargets]
        .sort((left, right) => (
            targetOrderKey(seed, fileId, left.targetId)
                .localeCompare(targetOrderKey(seed, fileId, right.targetId))
            || left.targetId.localeCompare(right.targetId)
        ))
        .slice(0, maximumTargets);
};
