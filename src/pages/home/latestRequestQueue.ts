/** Keep one running request and only the newest pending request during rapid edits. */
export function createLatestRequestQueue<T>(run: (request: T) => Promise<void>, onError: (error: unknown, request: T) => void) {
    let pending: { value: T } | null = null, running = false, scheduled = false;
    const schedule = () => {
        if (scheduled || running || !pending) return;
        scheduled = true;
        setTimeout(() => {
            scheduled = false;
            if (!pending || running) return;
            const current = pending.value; pending = null; running = true;
            void Promise.resolve().then(() => run(current)).catch(error => onError(error, current)).finally(() => {
                running = false; schedule();
            });
        }, 0);
    };
    return (request: T) => { pending = { value: request }; schedule(); };
}
