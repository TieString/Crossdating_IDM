import { describe, expect, it } from "vitest";
import { currentEventResultStatusToSessionStatus } from "./useCurrentEventRanker";

describe("current-event result status mapping", () => {
    it("keeps range-only advice distinct from errors and exact-year advice", () => {
        expect(currentEventResultStatusToSessionStatus("advice")).toBe("advice");
        expect(currentEventResultStatusToSessionStatus("range_advice")).toBe("range_advice");
        expect(currentEventResultStatusToSessionStatus("evidence_insufficient")).toBe("insufficient");
        expect(currentEventResultStatusToSessionStatus("unexpected")).toBe("error");
    });
});
