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
