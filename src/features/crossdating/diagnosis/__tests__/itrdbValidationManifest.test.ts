import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    ITRDB_VALIDATION_PROTOCOL,
    itrdbSplitForRelativePath,
    type ItrdbValidationSplit,
} from "./itrdbValidationProtocol";

type ManifestCase = { caseId: string; file: string; kind: string };
type Manifest = {
    protocol: { protocolVersion: string };
    fileSha256: Record<string, string>;
    splits: Record<ItrdbValidationSplit, {
        cases: ManifestCase[];
        counts: Record<string, number>;
    }>;
};

const manifestPath = fileURLToPath(new URL(
    "../../../../../docs/benchmarks/itrdb-validation-v1-manifest.json",
    import.meta.url,
));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

describe("frozen ITRDB validation manifest", () => {
    it("contains no site leakage or duplicate case ids", () => {
        const owner = new Map<string, ItrdbValidationSplit>();
        const caseIds = new Set<string>();
        for (const split of ["development", "calibration", "final"] as const) {
            for (const item of manifest.splits[split].cases) {
                expect(itrdbSplitForRelativePath(item.file)).toBe(split);
                expect(owner.get(item.file) ?? split).toBe(split);
                owner.set(item.file, split);
                expect(caseIds.has(item.caseId)).toBe(false);
                caseIds.add(item.caseId);
            }
        }
    });

    it("freezes the requested per-split scenario counts and source hashes", () => {
        expect(manifest.protocol.protocolVersion).toBe(
            ITRDB_VALIDATION_PROTOCOL.protocolVersion,
        );
        for (const split of ["development", "calibration", "final"] as const) {
            expect(manifest.splits[split].counts).toEqual({
                singleInjected: 240,
                naturalSingle: 80,
                separatedMulti: 45,
                adjacentMulti: 45,
                crossSeries: 35,
                naturalBootstrap: 6,
            });
        }
        Object.values(manifest.fileSha256).forEach((hash) => {
            expect(hash).toMatch(/^[0-9a-f]{64}$/);
        });
    });
});
