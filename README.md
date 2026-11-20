# square² (方方)

square² is a repo-agnostic skeleton with two planes. The **deterministic gate** runs a validated rule catalogue through engine adapters, subtracts a ratcheting baseline and expiring exceptions, and fails only on new violations, each printed with the fix (`Instead:`). The **advisory cross-family review** has a model from a different family than the code's authors review new commits and publish findings as issues; it never blocks anything.

Status: v0.1 in progress.

Zero runtime dependencies. Requires Node >= 22.

```sh
npm install
npm run typecheck
npm test
```

License: MIT.
