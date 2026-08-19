import { describe, expect, it } from "vitest";
import { enhanceCofechaPart2View, groupCofechaPart2Series } from "./cofechaPart2View";

const report = `PART 2:  TIME PLOT OF TREE-RING SERIES:
----------------------------------------------------------------
 1900 1950 2000 Ident   Seq Time-span  Yrs
   :    :    : -------- --- ---- ---- ----
   . <====>. EBD101    1 1926 2024   99
   . <==>.   EBD201    2 1912 1953   42
   .   <=>.  EBD201    3 1957 2024   68
   . <====>. EBD011    4 1850 2024  175
   :    :    :
PART 3:  MASTER SERIES`;

describe("COFECHA PART 2 view enhancement", () => {
    it("uses the complete earliest-to-latest span for split series", () => {
        const groups = groupCofechaPart2Series(report.split("\n"), ["EBD101", "EBD201", "EBD011"]);
        expect(groups.find((group) => group.tree === "EBD201")).toMatchObject({
            startYear: 1912,
            endYear: 2024,
            age: 113,
        });
    });

    it("sorts whole series groups by derived age and keeps split rows adjacent", () => {
        const enhanced = enhanceCofechaPart2View(
            report,
            ["EBD101", "EBD201", "EBD011"],
            ["EBD201"],
            true,
        );
        const ebd011 = enhanced.text.indexOf("EBD011");
        const ebd201First = enhanced.text.indexOf("EBD201");
        const ebd201Second = enhanced.text.indexOf("EBD201", ebd201First + 1);
        const ebd101 = enhanced.text.indexOf("EBD101");
        expect(ebd011).toBeLessThan(ebd201First);
        expect(ebd201First).toBeLessThan(ebd201Second);
        expect(ebd201Second).toBeLessThan(ebd101);
        expect(enhanced.text.slice(ebd201First, ebd201Second)).not.toContain("EBD101");
    });

    it("adds synchronized checkbox controls and repeats the full age on every split row", () => {
        const enhanced = enhanceCofechaPart2View(
            report,
            ["EBD101", "EBD201", "EBD011"],
            ["EBD201"],
            false,
        );
        const ebd201Controls = enhanced.checkboxes.filter((control) => control.tree === "EBD201");
        expect(ebd201Controls).toHaveLength(2);
        expect(ebd201Controls.every((control) => control.checked)).toBe(true);
        const ebd201Lines = enhanced.text.split("\n").filter((line) => line.includes("EBD201"));
        expect(ebd201Lines).toHaveLength(2);
        expect(ebd201Lines.every((line) => line.endsWith("  113"))).toBe(true);
        expect(enhanced.sortControls).toHaveLength(1);
    });

    it("does not mutate the source report string", () => {
        const before = report;
        void enhanceCofechaPart2View(report, ["EBD101", "EBD201", "EBD011"], [], true);
        expect(report).toBe(before);
        expect(report).not.toContain("Show Age");
    });

    it("recognizes PART 2 after the form-feed used by the all-content report", () => {
        const allContent = `PART 1: SUMMARY\nsummary\n\f${report}`;
        const enhanced = enhanceCofechaPart2View(
            allContent,
            ["EBD101", "EBD201", "EBD011"],
            [],
            false,
        );
        expect(enhanced.sortControls).toHaveLength(1);
        expect(enhanced.checkboxes).toHaveLength(4);
        expect(enhanced.text).toContain("Show Age");
    });
});
