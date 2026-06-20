import type { Meta, StoryObj } from "@storybook/react-vite";
import Menu from "./Menu";

const meta = {
    title: "Components/Menu",
    component: Menu,
    tags: ["autodocs"],
    args: {
        items: [
            { label: "File", children: <Menu items={[{ label: "Open", onClick: () => undefined }, { label: "Save", disabled: true }]} /> },
            { label: "View", children: <Menu items={[{ label: "Settings", onClick: () => undefined }]} /> },
        ],
    },
    decorators: [
        (Story) => (
            <div style={{ minHeight: 180, padding: 16 }}>
                <Story />
            </div>
        ),
    ],
    parameters: {
        docs: {
            description: {
                component: "Top menu container that coordinates hover-open submenus and leaf actions.",
            },
        },
    },
} satisfies Meta<typeof Menu>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Nested: Story = {};
