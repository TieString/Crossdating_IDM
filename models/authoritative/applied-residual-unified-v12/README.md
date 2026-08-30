# Authoritative unified v12 runtime

This directory contains the frozen assets used as the sole user-facing diagnosis
authority in the `experiment` branch.

The TypeScript diagnosis engine remains an immutable candidate/evidence generator.
Its former final decision is not used as a fallback. The runtime selects one
operation identity, then one window inside that identity. A refusal or runtime
error produces no suggestion.

Development runtime requirements:

- the repository Python environment with the checked-in model dependencies;
- `node_modules` installed so `vite-node` can generate yearly evidence;
- a fresh COFECHA report matching the current RWL state.

Validate all model files and hashes with:

```text
python scripts/validate-authoritative-unified-runtime.py
```
