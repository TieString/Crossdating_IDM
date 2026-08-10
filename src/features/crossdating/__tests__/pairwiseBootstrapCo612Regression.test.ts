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
        it("recovers newest review frontiers without target self-correlation", () => {
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
            const expectedFrontiers = new Map([
                ["mon031", 1977],
                ["mon032", 1977],
                ["mon121", 1977],
                ["mon122", 1977],
                ["mon221", 1902],
            ]);
            for (const [targetTree, truthYear] of expectedFrontiers) {
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
                    includeEventDecisionAudits: true,
                });
                const event = diagnosis.reviewEvents?.[0] ?? diagnosis.events[0];
                const context = JSON.stringify({
                    targetTree,
                    event,
                    audit: diagnosis.eventDecisionAudits?.[0],
                });
                expect(event?.eventType, context).toBe("missingRing");
                expect(event?.startYear, context).toBeLessThanOrEqual(truthYear);
                expect(event?.endYear, context).toBeGreaterThanOrEqual(truthYear);
                if (
                    targetTree === "mon031"
                    || targetTree === "mon032"
                    || targetTree === "mon221"
                ) {
                    expect(event?.rankedYears[0]?.year, context).toBe(truthYear);
                }
            }
        }, 30_000);
    },
);
