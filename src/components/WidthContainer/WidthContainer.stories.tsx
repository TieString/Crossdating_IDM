import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import type { RwlSiteData } from "@/features/rwl";
import { insertMissingYearAtSide, type RwlOperationLogEntry } from "@/features/rwl/edit";
import type { PersistedTreeRingScanState, TreeRingScanSeriesState } from "@/features/treeRingScans";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import WidthContainer from "./WidthContainer";
import { getTreeRingArtwork, getTreeRingFeature } from "./treeRingArtwork";

const buildSeries = (startYear: number, values: number[]) => (
    new Map<number, number | null>([
        ...values.map((value, index) => [startYear + index, value] as [number, number | null]),
        [startYear + values.length, 999],
    ])
);

const sampleSiteData: RwlSiteData = new Map([
    ["ABC01A", buildSeries(1900, [112, 118, 121, 110, 97, 103, 116, 128, 132, 125, 119, 111])],
    ["ABC02A", buildSeries(1902, [101, 108, 114, 109, 96, 99, 105, 117, 124, 120])],
]);

const interactiveTreeRingSeries = new Map<number, number | null>(
    Array.from({ length: 138 }, (_, index) => [
        1888 + index,
        Math.round(420 + (Math.sin(index * 0.37) + 1) * 410 + (index % 11) * 28),
    ]),
);
for (let year = 1940; year <= 1944; year += 1) interactiveTreeRingSeries.delete(year);
interactiveTreeRingSeries.set(1968, 0);
interactiveTreeRingSeries.set(2026, -9999);

const interactiveTreeRingSiteData: RwlSiteData = new Map([
    ["EBD022", interactiveTreeRingSeries],
]);

const longRadiusTreeRingSeries = new Map<number, number | null>(
    Array.from({ length: 166 }, (_, index) => [
        1858 + index,
        Math.round((980 + (Math.sin(index * 0.31) + 1) * 620 + (index % 9) * 35) * 1.25),
    ]),
);
longRadiusTreeRingSeries.set(2024, -9999);

const longRadiusTreeRingSiteData: RwlSiteData = new Map([
    ["ZSL052", longRadiusTreeRingSeries],
]);

const scanMappingOperation: RwlOperationLogEntry = {
    id: "scan-story-insert",
    sequence: 1,
    timestamp: "2026-08-16T00:00:00.000Z",
    action: "apply",
    operation: { type: "insert-missing", tree: "EBD022", year: 1977, side: "right" },
    summary: "1977 年右侧插入缺轮",
    detail: "scan story",
    tree: "EBD022",
    undoDepth: 1,
    redoDepth: 0,
};

function TreeRingScanStory({ calibrated }: { calibrated: boolean }) {
    const originalSeries = interactiveTreeRingSeries;
    const currentSeries = useMemo(
        () => insertMissingYearAtSide(originalSeries, 1977, "right"),
        [originalSeries],
    );
    const artwork = useMemo(() => getTreeRingArtwork(originalSeries, -9999, true), [originalSeries]);
    const initialSeriesState = useMemo<TreeRingScanSeriesState>(() => {
        if (!artwork) return { mode: "generated", anchors: [] };
        const anchorYears = [2020, 2010, 2000];
        const anchors = calibrated ? anchorYears.flatMap((year) => {
            const feature = getTreeRingFeature(artwork.geometry, year);
            return feature ? [{
                originalYear: year,
                xRatio: (artwork.radiusMm + feature.centreRadiusMm) / artwork.geometry.diameterMm,
                yRatio: 0.5,
                markerCount: year % 100 === 0 ? 3 as const : year % 50 === 0 ? 2 as const : 1 as const,
            }] : [];
        }) : [];
        const widths = Array.from(originalSeries.entries()).filter((entry): entry is [number, number] => (
            typeof entry[1] === "number" && entry[1] !== -9999
        ));
        return {
            mode: calibrated ? "scan" : "generated",
            anchors,
            imagePath: artwork.fullUrl,
            crop: calibrated
                ? { xRatio: 0, yRatio: 0, widthRatio: 1, heightRatio: 1 }
                : undefined,
            ...(calibrated ? {
                baselineStartYear: widths[0][0],
                baselineEndYear: widths[widths.length - 1][0],
                baselineOperationSequence: 0,
                baselineWidths: widths,
            } : {}),
        };
    }, [artwork, calibrated, originalSeries]);
    const [scanSeriesState, setScanSeriesState] = useState(initialSeriesState);
    const scanState = useMemo<PersistedTreeRingScanState>(() => {
        const filesBySeries: PersistedTreeRingScanState["filesBySeries"] = {};
        if (artwork?.fullUrl) {
            filesBySeries.ebd022 = { name: "EBD022.svg", path: artwork.fullUrl, extension: "svg" };
        }
        return {
            version: 1,
            savedAt: "2026-08-16T00:00:00.000Z",
            folderPath: "generated-svg-fixtures",
            filesBySeries,
            series: { ebd022: scanSeriesState },
        };
    }, [artwork?.fullUrl, scanSeriesState]);

    return (
        <WidthContainer
            siteData={new Map([["EBD022", currentSeries]])}
            selected="EBD022"
            masterCorrelations={new Map([["EBD022", 0.625]])}
            seriesProblemCounts={new Map([["EBD022", 0]])}
            treeRingScanState={scanState}
            rwlOperationLog={calibrated ? [scanMappingOperation] : []}
            onLoadTreeRingScanFolder={async () => 1}
            onTreeRingScanSeriesChange={(_, nextState) => setScanSeriesState(nextState)}
        />
    );
}

const meta = {
    title: "Components/WidthContainer",
    component: WidthContainer,
    tags: ["autodocs"],
    args: {
        siteData: sampleSiteData,
        selected: "ABC01A",
    },
    decorators: [
        (Story) => (
            <SettingsProvider>
                <div style={{ height: 440, overflow: "auto", border: "1px solid #d1d5db", padding: 12 }}>
                    <Story />
                </div>
            </SettingsProvider>
        ),
    ],
    parameters: {
        docs: {
            description: {
                component: "Editable Tucson-style width grid for parsed RWL site data.",
            },
        },
    },
} satisfies Meta<typeof WidthContainer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SampleData: Story = {};

export const InteractiveTreeRings: Story = {
    args: {
        siteData: interactiveTreeRingSiteData,
        selected: "EBD022",
        masterCorrelations: new Map([["EBD022", 0.625]]),
        seriesProblemCounts: new Map([["EBD022", 0]]),
    },
};

export const LongRadiusTreeRings: Story = {
    args: {
        siteData: longRadiusTreeRingSiteData,
        selected: "ZSL052",
        masterCorrelations: new Map([["ZSL052", 0.747]]),
        seriesProblemCounts: new Map([["ZSL052", 0]]),
    },
};

export const ScanAnnotationWorkflow: Story = {
    args: { siteData: interactiveTreeRingSiteData },
    render: () => <TreeRingScanStory calibrated={false} />,
};

export const ScannedYearMapping: Story = {
    args: { siteData: interactiveTreeRingSiteData },
    render: () => <TreeRingScanStory calibrated />,
};
