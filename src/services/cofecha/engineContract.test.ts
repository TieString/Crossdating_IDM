import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter";

const official = vi.hoisted(() => ({ out: "", run: vi.fn(async () => official.out) }));
vi.mock("./runner", () => ({ runOfficialCofecha: official.run }));

import { runCofechaReport, runCofechaJsInline } from ".";

describe("dual COFECHA engine OUT contract", () => {
  it("feeds JavaScript and official OUT through the same parser contract", async () => {
    const rwlText = readFileSync(resolve(process.cwd(), "test-data", "paki033.rwl"), "utf8");
    const javascriptOut = runCofechaJsInline(rwlText, "paki033.rwl").outText;
    official.run.mockClear();
    expect(await runCofechaReport({ engine: "javascript", rwlText, inputFileName: "paki033.rwl" })).toBe(javascriptOut);
    expect(official.run).not.toHaveBeenCalled();
    official.out = javascriptOut;
    const officialOut = await runCofechaReport({ engine: "official", rwlText,
      inputFileName: "paki033.rwl", executablePath: "D:/LTRR/COFECHA.EXE" });
    expect(official.run).toHaveBeenCalledWith(rwlText, "paki033.rwl", "D:/LTRR/COFECHA.EXE", undefined);
    expect(Array.from(splitReportByParts(officialOut).keys())).toEqual(Array.from(splitReportByParts(javascriptOut).keys()));
    expect(parseCofechaResult(officialOut)).toEqual(parseCofechaResult(javascriptOut));
  });
});
