import type { Meta, StoryObj } from "@storybook/react-vite";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis";
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
