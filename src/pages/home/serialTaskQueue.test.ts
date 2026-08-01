import { describe, expect, it } from "vitest";
import { createSerialTaskQueue } from "./serialTaskQueue";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((next) => {
        resolve = next;
    });
    return { promise, resolve };
};

describe("serial save task queue", () => {
    it("keeps disk writes in the order saves were requested", async () => {
        const queue = createSerialTaskQueue();
        const firstGate = deferred();
        const events: string[] = [];

        const first = queue.enqueue(async () => {
            events.push("first:start");
            await firstGate.promise;
            events.push("first:end");
        });
        const second = queue.enqueue(async () => {
            events.push("second:start");
            events.push("second:end");
        });

        await Promise.resolve();
        expect(events).toEqual(["first:start"]);
        firstGate.resolve();
        await Promise.all([first, second]);
        expect(events).toEqual([
            "first:start",
            "first:end",
            "second:start",
            "second:end",
        ]);
    });

    it("continues after a failed save", async () => {
        const queue = createSerialTaskQueue();
        const failed = queue.enqueue(async () => {
            throw new Error("write failed");
        });
        const next = queue.enqueue(async () => "saved");

        await expect(failed).rejects.toThrow("write failed");
        await expect(next).resolves.toBe("saved");
    });
});
