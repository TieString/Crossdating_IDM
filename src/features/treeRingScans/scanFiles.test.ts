import { describe, expect, it } from "vitest";
import {
    isFullResolutionTreeRingScanCrop,
    isMissingTreeRingScanPrepareCommandError,
    matchTreeRingScanEntries,
} from "./scanFiles";

describe("tree-ring scan folder matching", () => {
    it("matches exact same-named images case-insensitively without accepting prefixes", () => {
        const matches = matchTreeRingScanEntries([
            { name: "EBD021.SVG", isFile: true },
            { name: "ebd022.png", isFile: true },
            { name: "EBD021_backup.jpg", isFile: true },
            { name: "notes.txt", isFile: true },
            { name: "nested", isDirectory: true },
        ], ["EBD021", "EBD022", "EBD023"]);
        expect(matches.get("ebd021")?.name).toBe("EBD021.SVG");
        expect(matches.get("ebd022")?.name).toBe("ebd022.png");
        expect(matches.has("ebd023")).toBe(false);
        expect(matches.size).toBe(2);
    });

    it("recognizes a stale Tauri backend that has not registered the scan command", () => {
        expect(isMissingTreeRingScanPrepareCommandError(
            "Command prepare_tree_ring_scan_image not found",
        )).toBe(true);
        expect(isMissingTreeRingScanPrepareCommandError(
            "failed to read source scan image",
        )).toBe(false);
    });

    it("refuses to treat a stale TIFF overview as a full-resolution crop", () => {
        const crop = { xRatio: 0.1, yRatio: 0.2, widthRatio: 0.3, heightRatio: 0.4 };
        expect(isFullResolutionTreeRingScanCrop("tif", crop, { cropApplied: true })).toBe(true);
        expect(isFullResolutionTreeRingScanCrop("tiff", crop, { cropApplied: false })).toBe(false);
        expect(isFullResolutionTreeRingScanCrop("tif", crop, null)).toBe(false);
        expect(isFullResolutionTreeRingScanCrop("png", crop, null)).toBe(true);
        expect(isFullResolutionTreeRingScanCrop("tif", undefined, null)).toBe(true);
    });
});
