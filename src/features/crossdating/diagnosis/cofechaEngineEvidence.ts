import {
    prepareCofecha606SeriesForReport,
    type Cofecha606PreparedSeries,
    type Cofecha606SeriesAnalysisOptions,
} from "cofecha-js";
import type { RwlSiteData, RwlTreeData } from "../../rwl/types";
import type { UnifiedV5Sample } from "./unifiedV5Types";

export const COFECHA_ENGINE_EVIDENCE_VERSION = "cofecha-js-0.2.0-testing-values-v1";
export const COFECHA_ENGINE_EXPLICIT_UNITS_VERSION = "cofecha-js-0.2.0-explicit-units-testing-values-v2";

const OPTIONS: Cofecha606SeriesAnalysisOptions = {
    splineRigidityYears: 32,
    splineFrequencyResponse: 0.5,
    segmentLength: 50,
    segmentLag: 25,
    useAutoregressiveModel: true,
    useLogTransform: true,
    useFirstDifference: false,
    segmentGridStartYear: -10000,
    segmentGridEndYear: 10000,
    analysisStartYear: -10000,
    analysisEndYear: 10000,
};

const zScore = (source: Map<number, number>): Map<number, number> => {
    if (!source.size) return new Map();
    const values = [...source.values()];
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1;
    return new Map([...source].map(([year, value]) => [year, (value - mean) / sd]));
};

const testingMap = (prepared: Cofecha606PreparedSeries[]) => new Map(prepared.flatMap((part) => (
    part.years.flatMap((year, index) => (
        part.rawValues[index]! > 0 && Number.isFinite(part.testingValues[index])
            ? [[year, part.testingValues[index]!] as const] : []
    ))
)));

export type CofechaEngineSample = {
    sample: UnifiedV5Sample;
    referenceIds: string[];
    referenceDepth: Map<number, number>;
    targetSegmentCount: number;
    engineEvidenceVersion: typeof COFECHA_ENGINE_EVIDENCE_VERSION | typeof COFECHA_ENGINE_EXPLICIT_UNITS_VERSION;
};

/** Exact-content cache. Persisted state/evidence SHA-256 is owned by the runner. */
export class CofechaEngineEvidenceCache {
    private readonly cores = new Map<string, Cofecha606PreparedSeries[]>();
    readonly stats = { coreHits: 0, coreMisses: 0 };

    constructor(private readonly maximumCores = 512, private readonly explicitMarker = false) {}

    get version() {
        return this.explicitMarker ? COFECHA_ENGINE_EXPLICIT_UNITS_VERSION : COFECHA_ENGINE_EVIDENCE_VERSION;
    }

    private prepare(id: string, tree: RwlTreeData, marker: number): Cofecha606PreparedSeries[] {
        const entries = [...tree].sort(([left], [right]) => left - right);
        if (!entries.length) return [];
        const last = entries[entries.length - 1]!;
        // A virtual edit may replace the target Map without its terminal marker.
        // Preserve source precision explicitly; zeros remain in preprocessing.
        if (last[1] !== marker && (this.explicitMarker || (last[1] !== 999 && last[1] !== -9999))) {
            entries.push([last[0] + 1, marker]);
        }
        // With an explicit precision, a real 999 width at a gap is not a marker.
        if (this.explicitMarker) {
            for (let index = entries.length - 2; index >= 0; index -= 1) {
                const entry = entries[index]!;
                if (entry[1] !== null && entry[1] !== marker && entries[index + 1]![0] > entry[0] + 1) {
                    entries.splice(index + 1, 0, [entry[0] + 1, marker]);
                }
            }
        }
        const key = `${this.version}:${id}:${marker}:${JSON.stringify(entries)}`;
        const cached = this.cores.get(key);
        if (cached) {
            this.stats.coreHits += 1;
            this.cores.delete(key);
            this.cores.set(key, cached);
            return cached;
        }
        this.stats.coreMisses += 1;
        const prepared = prepareCofecha606SeriesForReport(new Map([[id, new Map(entries)]]), OPTIONS);
        this.cores.set(key, prepared);
        while (this.cores.size > this.maximumCores) this.cores.delete(this.cores.keys().next().value!);
        return prepared;
    }

    /** Virtual corrections change only this core; reference preparation is frozen. */
    buildTarget(targetId: string, tree: RwlTreeData, marker: number): Map<number, number> {
        return zScore(testingMap(this.prepare(targetId, tree, marker)));
    }

    build(site: RwlSiteData, targetId: string, marker: number): CofechaEngineSample | null {
        const series = [...site].map(([id, tree]) => ({ id, prepared: this.prepare(id, tree, marker) }));
        const targetParts = series.find((row) => row.id === targetId)?.prepared ?? [];
        const target = testingMap(targetParts);
        if (target.size < 40) return null;
        const references = series.filter((row) => row.id !== targetId)
            .map((row) => ({ id: row.id, values: testingMap(row.prepared) }))
            .filter((row) => row.values.size > 0);
        if (!references.length) return null;
        const annual = new Map<number, { sum: number; count: number }>();
        references.forEach((reference) => reference.values.forEach((value, year) => {
            const current = annual.get(year) ?? { sum: 0, count: 0 };
            current.sum = Math.fround(current.sum + Math.fround(value));
            current.count += 1;
            annual.set(year, current);
        }));
        const master = zScore(new Map([...annual].sort(([left], [right]) => left - right).map(([year, value]) => [
            year, Math.fround(value.sum / Math.fround(value.count)),
        ])));
        return {
            sample: { target: zScore(target), master, references: references.map((row) => row.values) },
            referenceIds: references.map((row) => row.id),
            referenceDepth: new Map([...annual].map(([year, value]) => [year, value.count])),
            targetSegmentCount: targetParts.length,
            engineEvidenceVersion: this.version,
        };
    }
}
