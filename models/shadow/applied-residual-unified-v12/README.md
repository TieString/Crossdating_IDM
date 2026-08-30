# Applied-residual unified shadow v12

This directory contains the frozen Python inference heads for the experimental
unified diagnosis adjudicator.

- `model.joblib`: operation/shift pairwise head followed by a same-identity
  location pairwise head.
- `manifest.json`: schema, immutable-package guarantees, source evidence
  hashes, and the model SHA-256.

The model consumes an immutable Top4 operation table and the selected
operation's immutable location table. It requires the upstream base
selection/meta/pair/listwise/anchor scores and post-correction residual
evidence. Missing continuous evidence is a contract error; it is never silently
filled with zero. Only absent event-type one-hot columns may be zero-filled.

Validate the checked-in artifact with:

```powershell
python scripts/validate-applied-residual-unified-shadow.py
```

Run truth-blind inference with
`scripts/predict-applied-residual-unified-shadow.py`. The checked-in model is a
shadow artifact and does not replace the TypeScript production adjudicator.
