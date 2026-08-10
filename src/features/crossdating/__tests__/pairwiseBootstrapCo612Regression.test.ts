import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    extractPart6FlaggedASeriesIds,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import { parseRwl } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    createPairwiseBootstrapReferenceConfig,
    createPairwiseBootstrapTargetReferenceConfig,
} from "../pairwiseBootstrap";

const fixtureRoot = "D:/软件测试/co612-review-window-results/"
    + "review-bootstrap-repaired-final-js-diagnosis-events-v1-360-2026-08-11/rounds/0001";
const statePath = `${fixtureRoot}/state.rwl`;
const outPath = `${fixtureRoot}/VERYCOF.OUT`;

describe.skipIf(!existsSync(statePath) || !existsSync(outPath))(
    "co612 all-flagged pairwise bootstrap",
    () => {
        it("recovers the 1977 review frontier without target self-correlation", () => {
            const siteData: RwlSiteData = new Map(Array.from(
                parseRwl(readFileSync(statePath, "utf8")),
                ([seriesId, series]) => [seriesId, new Map(series.valuesByYear)],
            ));
            const cofechaText = readFileSync(outPath, "utf8");
            const flaggedAIds = extractPart6FlaggedASeriesIds(
                splitReportByParts(cofechaText).get("PART 6") ?? "",
            );
            const sharedReference = createPairwiseBootstrapReferenceConfig({
                siteData,
                flaggedAIds,
                cofechaRunId: "co612-cold-start-regression",
                rwlHash: "frozen-round-1",
            });

            expect(flaggedAIds).toHaveLength(55);
            expect(sharedReference?.selectedTrees).toHaveLength(41);
            for (const targetTree of ["mon031", "mon121", "mon122"]) {
                const targetReference = createPairwiseBootstrapTargetReferenceConfig(
                    siteData,
                    sharedReference,
                    targetTree,
                );
                expect(targetReference?.selectedTrees).toHaveLength(40);
                const diagnosis = diagnoseCrossdating(siteData, {
                    referenceConfig: targetReference,
                    targetTrees: [targetTree],
                    cofechaText,
                    reviewWindowDisplayMode: "review",
                });
                const event = diagnosis.reviewEvents?.[0] ?? diagnosis.events[0];
                expect(event?.eventType).toBe("missingRing");
                expect(event?.startYear).toBeLessThanOrEqual(1977);
                expect(event?.endYear).toBeGreaterThanOrEqual(1977);
            }
        }, 30_000);
    },
);
