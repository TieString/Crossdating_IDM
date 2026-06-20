import type { Meta, StoryObj } from "@storybook/react-vite";
import { FloatingScrollArea } from "./FloatingScrollArea";

const meta = {
    title: "Components/FloatingScrollArea",
    component: FloatingScrollArea,
    tags: ["autodocs"],
    decorators: [
        (Story) => (
            <div style={{ height: 260, width: 420, border: "1px solid #d1d5db" }}>
                <Story />
            </div>
        ),
    ],
    parameters: {
        docs: {
            description: {
                component: "Native scroll container with the project's floating overlay scrollbar.",
            },
        },
    },
} satisfies Meta<typeof FloatingScrollArea>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ScrollableContent: Story = {
    args: {
        children: (
            <div style={{ width: 720, padding: 16 }}>
                {Array.from({ length: 24 }, (_, index) => (
                    <p key={index}>Scrollable row {index + 1}: crossdating workspace content sample.</p>
                ))}
            </div>
        ),
    },
};
