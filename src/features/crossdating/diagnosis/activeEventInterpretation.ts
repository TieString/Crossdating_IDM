import type { DiagnosisEvent } from "./types";

const eventContainsInterpretation = (
    event: DiagnosisEvent,
    interpretationId: string,
) => event.id === interpretationId
    || event.interpretationAmbiguity?.alternative.id === interpretationId;

export const refreshActiveDiagnosisEventInterpretation = (
    events: readonly DiagnosisEvent[],
    activeEvent: DiagnosisEvent | null | undefined,
): DiagnosisEvent | null => {
    if (!activeEvent || activeEvent.stale) return null;

    for (const event of events) {
        if (event.stale || !eventContainsInterpretation(event, activeEvent.id)) continue;
        return event.id === activeEvent.id
            ? event
            : event.interpretationAmbiguity?.alternative ?? null;
    }

    return null;
};

export const projectActiveDiagnosisEventInterpretation = (
    events: readonly DiagnosisEvent[],
    activeEvent: DiagnosisEvent | null | undefined,
): DiagnosisEvent[] => {
    const refreshedActiveEvent = refreshActiveDiagnosisEventInterpretation(events, activeEvent);
    if (!refreshedActiveEvent) return [...events];

    return events.map((event) => (
        eventContainsInterpretation(event, refreshedActiveEvent.id)
            ? refreshedActiveEvent
            : event
    ));
};
