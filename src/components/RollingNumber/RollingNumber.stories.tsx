import type { Meta, StoryObj } from "@storybook/react-vite";
import { RollingNumber } from "./RollingNumber";

const meta = {
    title: "Components/RollingNumber",
    component: RollingNumber,
    tags: ["autodocs"],
    args: {
        value: 128,
        fromValue: 95,
        stagger: 0.04,
        speed: 1,
    },
    parameters: {
        docs: {
            description: {
                component: "Animates a numeric value by rendering each digit as a rolling column.",
            },
        },
    },
} satisfies Meta<typeof RollingNumber>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Placeholder: Story = {
    args: {
        value: undefined,
        placeholder: "missing",
    },
};
