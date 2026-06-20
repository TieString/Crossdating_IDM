import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RwlSiteData } from "@/features/rwl";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import WidthContainer from "./WidthContainer";

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
