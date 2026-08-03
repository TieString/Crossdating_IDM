import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    selectCalibratedEventWindow,
    type CalibratedEventWindowInput,
} from "../calibratedEventWindow";
import { selectUnitEventShortWindow } from "../unitEventShortWindowSelector";
import type { UnitEventWindowRankerResult } from "../unitEventWindowRanker";

type LocatorAuditRow = {
    context: {
        groupId: string;
        file: string;
        target: string;
        baselineFlagged?: boolean;
    };
    truthYear: number;
    truthCorrectionYears: number;
    eventType: "missingRing" | "falseRing" | "partialMove";
    correctionYears: number;
    years: number[];
    ranks: Record<string, number[]>;
    candidates: Array<{ startYear: number; endYear: number; source: string }>;
    coarseWindow: { startYear: number; endYear: number };
    finalWindow: { startYear: number; endYear: number };
    calibratedWidth: number;
    currentPrimaryYear?: number;
    learnedWindowScore?: number;
    learnedWindowMargin?: number;
    learnedWindowRemoteMargin?: number;
    nineYearSafety?: number;
    nineYearSafetyThreshold?: number;
    selectedOperation?: {
        bestYear: number;
        remoteDifferenceMargin: number;
        sideStepBestYear?: number;
        sideStepRemoteMargin?: number;
    };
};

type AuditFile = {
    counterfactualLocatorCases?: LocatorAuditRow[];
};

const enabled = process.env.RUN_UNIT_SHORT_WINDOW_AUDIT === "1";
const d = enabled ? describe : describe.skip;

const contains = (
    window: { startYear: number; endYear: number },
    year: number,
): boolean => year >= window.startYear && year <= window.endYear;

d("unit short-window audit", () => {
    it("replays the independent 5/7/9-year selector", () => {
        const paths = (process.env.UNIT_SHORT_WINDOW_AUDITS ?? "")
            .split(";")
            .map((value) => value.trim())
            .filter(Boolean);
        expect(paths.length).toBeGreaterThan(0);
        const rows = paths.flatMap((path) => (
            JSON.parse(readFileSync(path, "utf8")) as AuditFile
        ).counterfactualLocatorCases ?? []).filter((row) => (
            row.context.baselineFlagged === false
            && (row.eventType === "missingRing" || row.eventType === "falseRing")
            && row.correctionYears === row.truthCorrectionYears
        ));
        const replayed = rows.flatMap((row) => {
            if (
                row.eventType !== "missingRing"
                && row.eventType !== "falseRing"
            ) return [];
            const input: CalibratedEventWindowInput = {
                eventType: row.eventType,
                years: row.years,
                ranks: new Map(Object.entries(row.ranks)),
                coarseWindow: row.coarseWindow,
                internalCandidates: row.candidates,
                currentPrimaryYear: row.currentPrimaryYear,
                ...(row.selectedOperation ? {
                    operationEvidence: row.selectedOperation,
                } : {}),
            };
            const legacy = selectCalibratedEventWindow(input);
            if (!legacy) return [];
            const learnedWindow: UnitEventWindowRankerResult = {
                window: row.finalWindow,
                modeWindow: row.finalWindow,
                prePointModeWindow: row.finalWindow,
                preFalseCurrentAnchorModeWindow: row.finalWindow,
                preDirectModeWindow: row.finalWindow,
                recommendedWidth:
                    row.calibratedWidth as 5 | 7 | 9 | 13,
                nineYearSafety: row.nineYearSafety ?? 0,
                widthThreshold: row.nineYearSafetyThreshold ?? 1,
                windowCenteringRule: "mode_mass",
                widthFallbackRule: "none",
                widthSelectionRule: "legacy_model",
                score: row.learnedWindowScore ?? 0,
                margin: row.learnedWindowMargin ?? 0,
                remoteMargin: row.learnedWindowRemoteMargin ?? 0,
                scoredWindows: [],
            };
            const short = selectUnitEventShortWindow({
                eventType: row.eventType,
                learnedWindow,
                independentWindow: legacy,
                currentPrimaryYear: row.currentPrimaryYear,
                ...(row.selectedOperation ? {
                    operationEvidence: row.selectedOperation,
                } : {}),
            });
            const productionWindow = short?.window ?? row.finalWindow;
            const productionWidth = short?.recommendedWidth
                ?? row.calibratedWidth;
            return [{
                groupId: row.context.groupId,
                file: row.context.file,
                target: row.context.target,
                eventType: row.eventType,
                truthYear: row.truthYear,
                currentWindow: row.finalWindow,
                currentWidth: row.calibratedWidth,
                currentHit: contains(row.finalWindow, row.truthYear),
                legacyWindow: legacy.window,
                legacyModeWindow: legacy.modeWindow,
                legacyWidth: legacy.width,
                legacyHit: contains(legacy.window, row.truthYear),
                legacyModeHit: contains(legacy.modeWindow, row.truthYear),
                legacyRule: legacy.calibrationRule,
                legacyConcentration: legacy.concentration,
                legacyRemoteMargin: legacy.remoteMargin,
                currentPrimaryYear: row.currentPrimaryYear ?? null,
                learnedWindowScore: row.learnedWindowScore ?? null,
                learnedWindowMargin: row.learnedWindowMargin ?? null,
                learnedWindowRemoteMargin:
                    row.learnedWindowRemoteMargin ?? null,
                nineYearSafety: row.nineYearSafety ?? null,
                nineYearSafetyThreshold:
                    row.nineYearSafetyThreshold ?? null,
                operationBestYear: row.selectedOperation?.bestYear ?? null,
                operationRemoteMargin:
                    row.selectedOperation?.remoteDifferenceMargin ?? null,
                sideStepBestYear:
                    row.selectedOperation?.sideStepBestYear ?? null,
                sideStepRemoteMargin:
                    row.selectedOperation?.sideStepRemoteMargin ?? null,
                productionWindow,
                productionWidth,
                productionRule: short?.rule ?? null,
                productionHit: contains(productionWindow, row.truthYear),
                shortened: short !== null,
            }];
        });
        const summarize = (eventType: "missingRing" | "falseRing") => {
            const selected = replayed.filter((row) => (
                row.eventType === eventType
            ));
            return Object.fromEntries([5, 7, 9, 13].map((width) => {
                const widthRows = selected.filter((row) => (
                    row.legacyWidth === width
                ));
                return [width, {
                    cases: widthRows.length,
                    hits: widthRows.filter((row) => row.legacyHit).length,
                    coverage: widthRows.length === 0
                        ? 0
                        : widthRows.filter((row) => row.legacyHit).length
                            / widthRows.length,
                    currentHits: widthRows.filter((row) => row.currentHit).length,
                }];
            }));
        };
        const summarizeProduction = (
            eventType: "missingRing" | "falseRing",
        ) => Object.fromEntries([5, 7, 9, 13].map((width) => {
            const widthRows = replayed.filter((row) => (
                row.eventType === eventType
                && row.productionWidth === width
            ));
            const shortenedRows = widthRows.filter((row) => row.shortened);
            return [width, {
                cases: widthRows.length,
                hits: widthRows.filter((row) => row.productionHit).length,
                coverage: widthRows.length === 0
                    ? 0
                    : widthRows.filter((row) => row.productionHit).length
                        / widthRows.length,
                shortenedCases: shortenedRows.length,
                shortenedHits: shortenedRows.filter(
                    (row) => row.productionHit,
                ).length,
            }];
        }));
        const output = {
            paths,
            summary: {
                missingRing: summarize("missingRing"),
                falseRing: summarize("falseRing"),
            },
            productionSummary: {
                missingRing: summarizeProduction("missingRing"),
                falseRing: summarizeProduction("falseRing"),
            },
            rows: replayed,
        };
        const outputPath = process.env.UNIT_SHORT_WINDOW_OUTPUT;
        if (outputPath) {
            writeFileSync(outputPath, JSON.stringify(output), "utf8");
        }
        // eslint-disable-next-line no-console
        console.log(`UNIT SHORT WINDOW AUDIT ${JSON.stringify(output.summary)}`);
        // eslint-disable-next-line no-console
        console.log(
            `UNIT SHORT WINDOW PRODUCTION ${
                JSON.stringify(output.productionSummary)
            }`,
        );
        expect(replayed.length).toBeGreaterThan(0);
    });
});
