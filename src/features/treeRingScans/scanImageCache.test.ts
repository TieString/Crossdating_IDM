import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireTreeRingScanImage, clearTreeRingScanImageCache, indexTreeRingScanFolder } from "./scanFiles";

const io = vi.hoisted(() => ({ invoke: vi.fn(), read: vi.fn(), directory: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...parts: string[]) => parts.join("/") }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: io.read, readDir: io.directory }));
const file = (name = "A") => ({ path: `D:\\scans\\${name}.png`, name: `${name}.png`, extension: "png" });
const gib = 1024 ** 3;
// Model payload sizes without allocating multi-GB buffers in unit tests.
const bytes = (size = gib) => ({ byteLength: size } as Uint8Array);
let revoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
    clearTreeRingScanImageCache();
    io.invoke.mockReset(); io.read.mockReset(); io.directory.mockReset();
    io.invoke.mockImplementation(async (command: string) => command === "prepare_tree_ring_scan_image"
        ? { path: "D:\\cache\\image.png", mimeType: "image/png", leaseId: "lease" } : undefined);
    io.read.mockResolvedValue(bytes());
    vi.stubGlobal("window", {});
    vi.stubGlobal("Blob", class {});
    let id = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${++id}`);
    revoke = vi.fn();
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
});
afterEach(() => { clearTreeRingScanImageCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("large scan image lifetimes", () => {
    it("keeps a 1 GiB image alive while displayed and evicts only after release", async () => {
        const image = await acquireTreeRingScanImage(file());
        expect(image.byteLength).toBe(gib);
        expect(revoke).not.toHaveBeenCalled();
        expect(io.invoke).toHaveBeenCalledWith("prepare_tree_ring_scan_image", expect.objectContaining({ cacheLimitGib: 16 }));
        expect(io.invoke).toHaveBeenCalledWith("release_tree_ring_scan_image", { leaseId: "lease" });
        image.release(); image.release();
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it("protects both callers of the same in-flight oversized image", async () => {
        let complete!: (value: Uint8Array) => void;
        io.read.mockReturnValue(new Promise<Uint8Array>((resolve) => { complete = resolve; }));
        const a = acquireTreeRingScanImage(file());
        const b = acquireTreeRingScanImage(file());
        await vi.waitFor(() => expect(io.read).toHaveBeenCalledTimes(1));
        complete(bytes());
        const [first, second] = await Promise.all([a, b]);
        expect(first.url).toBe(second.url);
        first.release();
        expect(revoke).not.toHaveBeenCalled();
        second.release();
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it("does not revoke an active view when its workspace cache is cleared", async () => {
        const first = await acquireTreeRingScanImage(file());
        clearTreeRingScanImageCache();
        expect(revoke).not.toHaveBeenCalled();
        const second = await acquireTreeRingScanImage(file());
        expect(second.url).not.toBe(first.url);
        first.release();
        expect(revoke).toHaveBeenCalledWith(first.url);
        expect(revoke).not.toHaveBeenCalledWith(second.url);
        second.release();
    });

    it("does not let a cleared in-flight generation overwrite or unregister a new load", async () => {
        const completions: Array<(value: Uint8Array) => void> = [];
        io.read.mockImplementation(() => new Promise<Uint8Array>((resolve) => completions.push(resolve)));
        const old = acquireTreeRingScanImage(file());
        await vi.waitFor(() => expect(completions).toHaveLength(1));
        clearTreeRingScanImageCache();
        const next = acquireTreeRingScanImage(file());
        await vi.waitFor(() => expect(completions).toHaveLength(2));
        completions[0](bytes());
        const oldImage = await old;
        const shared = acquireTreeRingScanImage(file());
        completions[1](bytes());
        const [a, b] = await Promise.all([next, shared]);
        expect(a.url).toBe(b.url);
        expect(io.read).toHaveBeenCalledTimes(2);
        oldImage.release(); a.release();
        expect(revoke).not.toHaveBeenCalledWith(b.url);
        b.release();
    });

    it("releases the native read lease on failure and allows a later retry", async () => {
        io.read.mockRejectedValueOnce(new Error("read failed"));
        await expect(acquireTreeRingScanImage(file())).rejects.toThrow("read failed");
        expect(io.invoke).toHaveBeenCalledWith("release_tree_ring_scan_image", { leaseId: "lease" });
        const retried = await acquireTreeRingScanImage(file());
        expect(io.read).toHaveBeenCalledTimes(2);
        retried.release();
    });

    it("indexes 120 scans without reading images and safely cycles through large selections", async () => {
        const ids = Array.from({ length: 120 }, (_, i) => `S${i}`);
        io.directory.mockResolvedValue(ids.map((id) => ({ name: `${id}.png`, isFile: true })));
        const indexed = await indexTreeRingScanFolder("D:\\scans", ids);
        expect(Object.keys(indexed)).toHaveLength(120);
        expect(io.read).not.toHaveBeenCalled();
        for (const id of ids) {
            const image = await acquireTreeRingScanImage(file(id));
            expect(revoke).not.toHaveBeenCalledWith(image.url);
            image.release();
        }
        expect(revoke).toHaveBeenCalledTimes(120);
    });
});
