import { useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RawTextEditor, type RawEditorHandle } from "./RawTextEditor";

const sampleText = `TUCSON SAMPLE
AAA011900 100 110 120 130 140 150 160 170 180 190
AAA011910 105 115 125 135 145 155 165 175 185 999`;

const meta = {
    title: "Components/RawTextEditor",
    component: RawTextEditor,
    tags: ["autodocs"],
    args: {
        initialText: sampleText,
        invalid: false,
    },
    decorators: [
        (Story) => (
            <div style={{ height: 260, border: "1px solid #d1d5db" }}>
                <Story />
            </div>
        ),
    ],
    parameters: {
        docs: {
            description: {
                component: "CodeMirror-backed raw text editor used for RWL text workflows.",
            },
        },
    },
} satisfies Meta<typeof RawTextEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: (args) => {
        const editorRef = useRef<RawEditorHandle>(null);
        return <RawTextEditor {...args} ref={editorRef} />;
    },
};
