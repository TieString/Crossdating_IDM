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
    unitEventYears: [1880, 1900],
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

    it("advances past an already confirmed path head instead of suggesting it twice", () => {
        expect(resolveSequentialMissingPresentation(
            {
                ...head,
                unitEventYears: [1878, 1892, 1899, 1900],
            },
            marker(1900),
            "local2",
            [1900],
            [1900],
        )).toMatchObject({
            marker: null,
            selectedYear: 1892,
            windowCenterYear: 1892,
            width: 13,
            candidateWindowSupportYear: null,
            advancedSequentialPathYear: 1892,
        });
    });

    it("does not skip an unresolved consecutive head for a remote prior path transition", () => {
        expect(resolveSequentialMissingPresentation(
            {
                ...head,
                year: 1899,
                transitionCount: 20,
                headRunYears: 11,
                headMeanAdvantage: 0.2,
                fixedTailMeanAdvantage: 0.4,
                pathStartLag: -20,
                unitEventYears: [1888, 1899],
            },
            null,
            "local2",
            [],
            [1900],
        )).toMatchObject({
            selectedYear: 1899,
            windowCenterYear: 1894,
            width: 13,
            advancedSequentialPathYear: null,
            rejectedRemoteSequentialPathYear: 1888,
        });
    });

    it("uses an earlier validated location checkpoint before a raw candidate mode", () => {
        expect(resolveSequentialMissingPresentation(
            {
                ...head,
                year: 1738,
                transitionCount: 8,
                headRunYears: 4,
                headMeanAdvantage: 0.03,
                fixedTailMeanAdvantage: 0.4,
                pathStartLag: -8,
                unitEventYears: [1727, 1734, 1738],
            },
            null,
            "local2",
            [1750],
            [],
            [1725],
        )).toMatchObject({
            selectedYear: 1732,
            windowCenterYear: 1732,
            width: 13,
            candidateWindowSupportYear: 1725,
            preferredLocationSupportYear: 1725,
        });
    });

    it("widens around a strong marker when a prior missing checkpoint supports its older side", () => {
        expect(resolveSequentialMissingPresentation(
            {
                ...head,
                year: 1903,
                transitionCount: 4,
                headRunYears: 22,
                headMeanAdvantage: 0.26,
                fixedTailMeanAdvantage: 0.37,
                pathStartLag: -4,
                unitEventYears: [1881, 1903],
            },
            {
                year: 1902,
                support: 22,
                distanceFromHead: 1,
                weightedSupport: 11,
            },
            "local2",
            [1875],
            [],
            [1901],
        )).toMatchObject({
            selectedYear: 1902,
            windowCenterYear: 1903,
            width: 9,
            candidateWindowSupportYear: 1901,
            preferredLocationSupportYear: 1901,
        });
    });

    it("widens a deep staircase when its marker sits near a seven-year edge", () => {
        expect(resolveSequentialMissingPresentation(
            {
                ...head,
                transitionCount: 13,
                headRunYears: 3,
                headMeanAdvantage: 0.3,
            },
            marker(1902),
            "local2",
        )).toMatchObject({
            selectedYear: 1902,
            windowCenterYear: 1899,
            width: 9,
        });
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
