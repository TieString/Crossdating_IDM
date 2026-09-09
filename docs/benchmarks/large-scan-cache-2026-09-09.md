# Large scan cache repair

Production workspace: `Crossdating_Tauri-experiment`. Original scans and frozen diagnosis models are unchanged.

- Fixed Blob eviction before acquisition: waiters reserve references before IO completes. Over-budget active images remain usable until released.
- Cache reset retires active entries and isolates in-flight generations. Old completion cannot overwrite the new cache or unregister a newer pending request for the same file.
- Each prepared disk image has a backend read lease, owned by the requesting window. Eviction skips every leased image across windows until `readFile` completes; failed reads also release their lease. Window destruction releases orphaned leases.
- Disk budget is configurable in Settings / Cache Management: 2, 4, 8, 16, 32, 64 or 128 GiB; default 16 GiB. Applied on preparation, with soft over-budget behavior for active reads. Hits update access time rather than relying only on original creation/modification order.
- Copy/TIFF conversion and eviction share a backend lock and execute on blocking-pool threads, avoiding conversion on the UI thread. Files are staged before publication so incomplete output is not a cache hit.

Validation: production Vitest suite 140 passed, 1 optional local-RWL fixture skipped; Rust library 17 passed, 1 optional real external TIFF test ignored; strict TypeScript and production Vite build passed (existing chunk warnings). Tests cover simulated 1 GiB payload accounting, concurrent waiters, cache clearing during IO, read failure/retry, indexing 120 scan paths without image reads, cross-window read protection, LRU hits and window-close cleanup.

The 1 GiB frontend tests use mocked byte counts to exercise eviction logic without allocating gigabytes. No claim is made about measured loading speed or memory peaks for 100 real 1 GiB images. Disk capacity is independent of decoded image memory; the existing TIFF overview and full-resolution crop path remains in place.

Restart the Tauri development process to compile and load the new backend commands; refreshing only Vite does not replace Rust code.
