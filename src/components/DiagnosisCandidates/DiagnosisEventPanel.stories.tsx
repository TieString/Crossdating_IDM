import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TreeChartManager } from "@/components/Chart/TreeChartManager";
import type { ChartJumpTarget } from "@/components/Chart/chartNavigation";
import WidthContainer from "@/components/WidthContainer/WidthContainer";
import type {
  CrossdatingDiagnosis,
  DiagnosisEvent,
} from "@/features/crossdating/diagnosis";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import { DiagnosisEventPanel } from "./DiagnosisEventPanel";

const partial: DiagnosisEvent = {
  id: "partial-interpretation",
  seriesId: "MTR841",
  eventType: "partialMove",
  startYear: 1774,
  endYear: 1782,
  rankedYears: [
    { year: 1777, rank: 1, score: 0.24, evidenceTags: ["counterfactual"] },
    { year: 1778, rank: 2, score: 0.22, evidenceTags: ["reference_vote"] },
  ],
  confidenceLevel: "medium",
  shiftYears: -2,
  shiftSide: "older",
  seriesRange: { startYear: 1700, endYear: 2000 },
  evidence: {
    algorithmSources: ["cofecha_segment_lag", "per_reference_completed_correction"],
    score: 0.24,
    scoreMargin: 0.01,
    baselineCorrelation: 0.43,
    correctedCorrelation: 0.61,
    correlationGain: 0.18,
    lagBefore: -2,
    lagAfter: 0,
    samplePairs: 180,
    candidateIds: ["partial-candidate"],
    notes: ["candidate_hard_gate_passed", "partial_reference_vote_year=1778"],
  },
  alternativeTypes: [],
};

const missing: DiagnosisEvent = {
  ...partial,
  id: "missing-interpretation",
  eventType: "missingRing",
  startYear: 1774,
  endYear: 1780,
  rankedYears: [
    { year: 1778, rank: 1, score: 0.25, evidenceTags: ["staircase"] },
    { year: 1777, rank: 2, score: 0.23, evidenceTags: ["staircase"] },
  ],
  shiftYears: undefined,
  shiftSide: undefined,
  evidence: {
    ...partial.evidence,
    algorithmSources: ["sequential_missing_staircase_head"],
    lagBefore: -1,
    lagAfter: 0,
  },
};

const ambiguity = {
  kind: "missingRingsOrPartialMove" as const,
  evidence: {
    missingRingCount: 2,
    cumulativeShiftYears: -2,
    missingYears: [1775, 1778],
    partialFirstFixedYear: 1777,
    normalizedCounterfactualGainDifference: 0.4,
    masterMargin: 0.012,
    referenceMedianMargin: 0.004,
    referenceCount: 18,
    missingReferenceSupport: 10,
    partialReferenceSupport: 8,
  },
};

const missingPrimary: DiagnosisEvent = {
  ...missing,
  interpretationAmbiguity: { ...ambiguity, alternative: partial },
};

const partialPrimary: DiagnosisEvent = {
  ...partial,
  interpretationAmbiguity: { ...ambiguity, alternative: missing },
};

const previewSiteData: RwlSiteData = new Map(
  Array.from({ length: 7 }, (_, seriesIndex) => {
    const tree: RwlTreeData = new Map();
    for (let year = 1740; year <= 1810; year += 1) {
      if (seriesIndex === 0 && year === 1780) continue;
      const signal = 900
        + Math.sin(year / 3.7) * 180
        + Math.cos(year / 8.3) * 90
        + seriesIndex * 4;
      tree.set(year, Math.round(signal));
    }
    return [seriesIndex === 0 ? partial.seriesId : `REF${seriesIndex}`, tree];
  }),
);

const previewDiagnosis: CrossdatingDiagnosis = {
  createdAt: "2026-08-16T00:00:00.000Z",
  seriesCount: previewSiteData.size,
  problemSegmentCount: 1,
  candidateCount: 0,
  eventCount: 1,
  segmentLength: 50,
  overlap: 25,
  lagRange: { min: -10, max: 10 },
  lowCorrelationThreshold: 0.32,
  summaries: [],
  segments: [],
  propagationPatterns: [],
  globalSlidingMatches: [],
  masterNarrowYears: [],
  events: [partial],
  reviewEvents: [partial],
  candidates: [],
};

function ReviewYearChartPreviewStory() {
  const requestIdRef = useRef(0);
  const [jumpTarget, setJumpTarget] = useState<ChartJumpTarget | null>(null);
  const [activeEvent, setActiveEvent] = useState<DiagnosisEvent | null>(null);
  const selectPreview = (event: DiagnosisEvent, year: number) => {
    requestIdRef.current += 1;
    setActiveEvent(event);
    setJumpTarget({
      id: requestIdRef.current,
      tree: event.seriesId,
      year,
      diagnosisPreviewEventId: event.id,
    });
  };

  return (
    <SettingsProvider>
      <div style={{ display: "grid", gridTemplateRows: "auto 250px minmax(420px, 1fr)", gap: 14, minHeight: 820, padding: 14, background: "#fff" }}>
        <DiagnosisEventPanel
          events={[partial]}
          selectedEventId={jumpTarget?.diagnosisPreviewEventId}
          selectedReviewYear={jumpTarget?.year}
          onFocusEvent={(event, selectedYear) => {
            const year = selectedYear ?? event.rankedYears[0]?.year;
            if (year === undefined) return;
            selectPreview(event, year);
          }}
          onApplyEvent={() => undefined}
          onDismiss={() => undefined}
        />
        <div style={{ minHeight: 0, overflow: "auto", borderBlock: "1px solid #edf0ee" }}>
          <WidthContainer
            siteData={previewSiteData}
            selected={partial.seriesId}
            suggestedRanges={[{
              tree: partial.seriesId,
              startYear: partial.startYear,
              endYear: partial.endYear,
            }]}
            jumpTarget={jumpTarget}
            onYearClick={(tree, year) => {
              if (
                tree === partial.seriesId
                && year >= partial.startYear
                && year <= partial.endYear
              ) {
                selectPreview(partial, year);
              }
            }}
          />
        </div>
        <TreeChartManager
          variant="expanded"
          fullData={previewSiteData}
          selectedTrees={[partial.seriesId]}
          focusedTree={partial.seriesId}
          jumpTarget={jumpTarget}
          activeDiagnosisEvent={activeEvent}
          diagnosis={previewDiagnosis}
          onDiagnosisPreviewChange={selectPreview}
        />
      </div>
    </SettingsProvider>
  );
}

const meta = {
  title: "Diagnosis/Constrained interpretation switch",
  component: DiagnosisEventPanel,
  parameters: { layout: "padded" },
  args: {
    onFocusEvent: () => undefined,
    onApplyEvent: () => true,
  },
} satisfies Meta<typeof DiagnosisEventPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MissingRingsPrimary: Story = {
  args: { events: [missingPrimary] },
};

export const PartialGapPrimary: Story = {
  args: { events: [partialPrimary] },
};

export const ReviewYearChartPreview: Story = {
  args: { events: [partial] },
  render: () => <ReviewYearChartPreviewStory />,
};
