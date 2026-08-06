import { describe, expect, it } from "vitest";
import type { RwlSiteData } from "@/features/rwl/types";
import { resolveSequentialMissingPresentation } from "../eventEnsemble";
import {
    selectSharedExplicitZeroMarker,
    type SequentialMissingHead,
    type SharedExplicitZeroMarker,
} from "../eventPath";

const head: SequentialMissingHead = {
    year: 1900,
    score: 2,
    directScore: 1,
    gainOverDirect: 1,
    transitionCount: 3,
    headRunYears: 60,
    headMeanAdvantage: 0.1,
    fixedTailMeanAdvantage: 0.1,
    pathStartLag: -2,
};

const marker = (year: number): SharedExplicitZeroMarker => ({
    year,
    support: 4,
    distanceFromHead: Math.abs(year - head.year),
    weightedSupport: 4 / (1 + Math.abs(year - head.year)),
});

describe("shared explicit zero locality", () => {
    it("ignores a stronger shared zero beyond two years by default", () => {
        const site: RwlSiteData = new Map([
            ["target", new Map([[1900, 10]])],
            ["near", new Map([[1902, 0]])],
            ...Array.from({ length: 8 }, (_, index) => [
                `far-${index}`,
                new Map([[1906, 0]]),
            ] as const),
        ]);

        expect(selectSharedExplicitZeroMarker(site, "target", 1900)?.year).toBe(1902);
        expect(selectSharedExplicitZeroMarker(site, "target", 1900, 6)?.year).toBe(1906);
    });

    it("lets local markers rerank years without moving the lag-derived window center", () => {
        const local = resolveSequentialMissingPresentation(head, marker(1902), "local2");
        expect(local)
            .toMatchObject({
                selectedYear: 1902,
                windowCenterYear: 1900,
                width: 7,
                candidateConsensusYear: null,
            });
        expect(resolveSequentialMissingPresentation(head, null, "local2").width)
            .toBe(local.width);
        expect(resolveSequentialMissingPresentation({
            ...head,
            headMeanAdvantage: 0.5,
        }, marker(1902), "local2"))
            .toMatchObject({
                selectedYear: 1902,
                windowCenterYear: 1900,
                width: 5,
            });
    });

    it("uses a nearby independent partial locator to calibrate one consensus window", () => {
        expect(resolveSequentialMissingPresentation(
            head,
            marker(1902),
            "local2",
            [1902],
        )).toMatchObject({
            selectedYear: 1902,
            windowCenterYear: 1901,
            width: 9,
            candidateConsensusYear: 1901,
            candidateWindowSupportYear: 1902,
        });
        expect(resolveSequentialMissingPresentation(
            head,
            null,
            "local2",
            [1911],
        )).toMatchObject({
            selectedYear: 1906,
            windowCenterYear: 1906,
            width: 13,
            candidateConsensusYear: 1906,
            candidateWindowSupportYear: 1911,
        });
    });

    it("widens a one-year lag-head run without moving its center", () => {
        expect(resolveSequentialMissingPresentation({
            ...head,
            headRunYears: 1,
        }, null, "local2")).toMatchObject({
            selectedYear: 1900,
            windowCenterYear: 1898,
            width: 13,
            candidateConsensusYear: null,
            candidateWindowSupportYear: null,
        });
    });

    it("uses a strong shared zero to keep Top1 while candidate evidence only widens", () => {
        expect(resolveSequentialMissingPresentation(
            head,
            { ...marker(1900), support: 20 },
            "local2",
            [1903],
        )).toMatchObject({
            selectedYear: 1900,
            windowCenterYear: 1900,
            width: 13,
            candidateConsensusYear: null,
            candidateWindowSupportYear: 1903,
        });
    });

    it("uses only previously confirmed target zeros to continue an older staircase", () => {
        expect(resolveSequentialMissingPresentation(
            head,
            null,
            "local2",
            [],
            [1892, 1894, 1930],
        )).toMatchObject({
            selectedYear: 1891,
            windowCenterYear: 1891,
            width: 13,
            confirmedTargetStaircaseYear: 1891,
        });
        expect(resolveSequentialMissingPresentation(
            head,
            null,
            "local2",
            [],
            [1894],
        ).confirmedTargetStaircaseYear).toBeNull();
    });

    it("keeps legacy recentering only for the explicit baseline ablation", () => {
        expect(resolveSequentialMissingPresentation(head, marker(1906), "local2"))
            .toMatchObject({
                marker: null,
                selectedYear: 1900,
                windowCenterYear: 1900,
                width: 7,
            });
        expect(resolveSequentialMissingPresentation(head, marker(1906), "none"))
            .toMatchObject({
                marker: null,
                selectedYear: 1900,
                windowCenterYear: 1900,
            });
        expect(resolveSequentialMissingPresentation(head, marker(1906), "legacy6"))
            .toMatchObject({
                selectedYear: 1906,
                windowCenterYear: 1906,
                width: 13,
            });
    });
});
