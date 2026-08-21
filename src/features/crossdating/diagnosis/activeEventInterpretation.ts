import type { DiagnosisEvent } from "./types";

export const diagnosisEventInterpretationChain = (
    event: DiagnosisEvent,
): DiagnosisEvent[] => {
    const chain: DiagnosisEvent[] = [];
    const visited = new Set<DiagnosisEvent>();
    let current: DiagnosisEvent | undefined = event;
    while (current && !visited.has(current)) {
        chain.push(current);
        visited.add(current);
        current = current.interpretationAmbiguity?.alternative;
    }
    return chain;
};

export const resolveDiagnosisEventInterpretation = (
    event: DiagnosisEvent,
    interpretationId: string,
): DiagnosisEvent | null => diagnosisEventInterpretationChain(event)
    .find((interpretation) => interpretation.id === interpretationId) ?? null;

const eventContainsInterpretation = (
    event: DiagnosisEvent,
    interpretationId: string,
) => resolveDiagnosisEventInterpretation(event, interpretationId) !== null;

export const refreshActiveDiagnosisEventInterpretation = (
    events: readonly DiagnosisEvent[],
    activeEvent: DiagnosisEvent | null | undefined,
): DiagnosisEvent | null => {
    if (!activeEvent || activeEvent.stale) return null;

    for (const event of events) {
        if (event.stale || !eventContainsInterpretation(event, activeEvent.id)) continue;
        const refreshed = resolveDiagnosisEventInterpretation(event, activeEvent.id);
        if (refreshed?.stale) return null;
        return refreshed;
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
