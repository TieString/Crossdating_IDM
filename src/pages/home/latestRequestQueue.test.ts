import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestRequestQueue } from "./latestRequestQueue";

afterEach(() => vi.useRealTimers());
describe("latest-only diagnosis work", () => {
    it("retains the running job and replaces obsolete pending jobs", async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        const gate = new Promise<void>(resolve => { finish = resolve; });
        const seen: number[] = [], errors = vi.fn();
        const enqueue = createLatestRequestQueue(async (id: number) => { seen.push(id); if (id === 1) await gate; }, errors);
        enqueue(1); await vi.advanceTimersByTimeAsync(0);
        enqueue(2); enqueue(3); enqueue(4);
        finish(); await vi.runAllTimersAsync();
        expect(seen).toEqual([1, 4]); expect(errors).not.toHaveBeenCalled();
    });
    it("coalesces an initial burst and continues after an error", async () => {
        vi.useFakeTimers();
        const seen: number[] = [], errors = vi.fn();
        const enqueue = createLatestRequestQueue(async (id: number) => { seen.push(id); if (id === 3) throw new Error("failed"); }, errors);
        enqueue(1); enqueue(2); enqueue(3); await vi.runAllTimersAsync();
        enqueue(4); await vi.runAllTimersAsync();
        expect(seen).toEqual([3, 4]); expect(errors).toHaveBeenCalledOnce();
    });
});
