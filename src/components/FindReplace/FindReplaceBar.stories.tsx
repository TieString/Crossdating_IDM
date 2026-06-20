import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FindReplaceBar, type FindReplaceMode } from "./FindReplaceBar";

const meta = {
    title: "Components/FindReplaceBar",
    component: FindReplaceBar,
    tags: ["autodocs"],
    args: {
        mode: "replace",
        query: "120",
        replaceValue: "121",
        matchIndex: 0,
        matchCount: 3,
        onModeChange: () => undefined,
        onQueryChange: () => undefined,
        onReplaceValueChange: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onReplaceOne: () => undefined,
        onReplaceAll: () => undefined,
        onClose: () => undefined,
    },
    parameters: {
        docs: {
            description: {
                component: "Controlled floating toolbar for find and replace actions.",
            },
        },
    },
} satisfies Meta<typeof FindReplaceBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ReplaceMode: Story = {
    render: () => {
        const [mode, setMode] = useState<FindReplaceMode>("replace");
        const [query, setQuery] = useState("120");
        const [replaceValue, setReplaceValue] = useState("121");

        return (
            <div style={{ position: "relative", minHeight: 96, paddingTop: 8 }}>
                <FindReplaceBar
                    mode={mode}
                    query={query}
                    replaceValue={replaceValue}
                    matchIndex={0}
                    matchCount={3}
                    onModeChange={setMode}
                    onQueryChange={setQuery}
                    onReplaceValueChange={setReplaceValue}
                    onNext={() => undefined}
                    onPrev={() => undefined}
                    onReplaceOne={() => undefined}
                    onReplaceAll={() => undefined}
                    onClose={() => undefined}
                />
            </div>
        );
    },
};
