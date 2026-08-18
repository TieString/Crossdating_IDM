import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import { createReferenceSeriesConfig } from "@/features/crossdating/reference";
import { deleteYearWithMode } from "@/features/rwl/edit";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl";
import { TreeChartManager } from "./TreeChartManager";

const makeSeries = (): RwlTreeData => {
  let state = 0x10203040;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return new Map(Array.from({ length: 221 }, (_, index) => {
    const year = 1800 + index;
    const width = 1050
      + (random() - 0.5) * 520
      + Math.sin(index / 11) * 90
      + Math.cos(index / 23) * 55;
    return [year, Math.max(80, Math.round(width))] as const;
  }));
};

const reference = makeSeries();
const pairwiseSite: RwlSiteData = new Map([
  ["PAIR01", deleteYearWithMode(reference, 1994, "direct", "right")],
  ["PAIR02", new Map(reference)],
]);
const secondReference = new Map(Array.from(reference, ([year, value], index) => [
  year,
  typeof value === "number" ? Math.max(1, value + (index % 5) - 2) : value,
]));
const pairwiseReferenceSite: RwlSiteData = new Map([
  ["PAIR01", deleteYearWithMode(reference, 1994, "direct", "right")],
  ["PAIR02", new Map(reference)],
  ["PAIR03", secondReference],
]);
const pairwiseReferenceConfig = createReferenceSeriesConfig(["PAIR02", "PAIR03"]);

const meta = {
  title: "Components/TreeChartManager",
  component: TreeChartManager,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TreeChartManager>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PairwiseMismatchAnalysis: Story = {
  args: {
    fullData: pairwiseSite,
    selectedTrees: ["PAIR01", "PAIR02"],
    focusedTree: "PAIR01",
  },
  render: (args) => (
    <SettingsProvider>
      <div style={{ height: "100vh", minHeight: 620, padding: 10, background: "#fff" }}>
        <TreeChartManager
          {...args}
          onApplyLocalSimulation={() => undefined}
        />
      </div>
    </SettingsProvider>
  ),
};

export const PairwiseReferenceAnalysis: Story = {
  args: {
    fullData: pairwiseReferenceSite,
    selectedTrees: ["PAIR01"],
    focusedTree: null,
    referenceConfig: pairwiseReferenceConfig,
  },
  render: (args) => (
    <SettingsProvider>
      <div style={{ height: "100vh", minHeight: 620, padding: 10, background: "#fff" }}>
        <TreeChartManager
          {...args}
          onApplyLocalSimulation={() => undefined}
        />
      </div>
    </SettingsProvider>
  ),
};
