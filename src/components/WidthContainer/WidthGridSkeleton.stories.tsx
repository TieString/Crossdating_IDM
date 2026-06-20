import type { Meta, StoryObj } from "@storybook/react-vite";
import { WidthGridSkeleton } from "./WidthContainer";

const meta = {
    title: "Components/WidthGridSkeleton",
    component: WidthGridSkeleton,
    tags: ["autodocs"],
    args: {
        showRows: true,
    },
    parameters: {
        docs: {
            description: {
                component: "Loading skeleton that preserves the width-grid header and row rhythm.",
            },
        },
    },
} satisfies Meta<typeof WidthGridSkeleton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithRows: Story = {};

export const HeaderOnly: Story = {
    args: {
        showRows: false,
    },
};
