import type { Meta, StoryObj } from "@storybook/react-vite";
import ContextMenu from "./ContextMenu";

const meta = {
    title: "Components/ContextMenu",
    component: ContextMenu,
    tags: ["autodocs"],
    args: {
        open: true,
        x: 48,
        y: 48,
        items: [
            { key: "insert", label: "Insert missing year", onSelect: () => undefined },
            { key: "delete", label: "Delete year", danger: true, onSelect: () => undefined },
            { key: "disabled", label: "Disabled action", disabled: true, onSelect: () => undefined },
        ],
        onClose: () => undefined,
    },
    decorators: [
        (Story) => (
            <div style={{ minHeight: 220, position: "relative" }}>
                <Story />
            </div>
        ),
    ],
    parameters: {
        docs: {
            description: {
                component: "Portal-based context menu used by grid editing surfaces.",
            },
        },
    },
} satisfies Meta<typeof ContextMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Open: Story = {};
