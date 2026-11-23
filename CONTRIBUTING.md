# Contributing to square² (方方)

Contributions, rule engine adapters, and bug reports are welcome!

## Local Verification

Requires **Node.js ≥ 22**:

```sh
npm install
npm run typecheck
npm test
```

## Guidelines

1. **Zero runtime dependencies**: Keep runtime code in plain Node.js ≥ 22 without adding third-party production dependencies.
2. **Repo-agnostic**: Never reference private or consumer-specific repository names, paths, or domains.
3. **Self-tested rules**: Any new built-in rule or adapter must include positive (`bad/`) and negative (`good/`) fixtures.
4. Keep PRs focused on a single concern and open a [Discussion](https://github.com/Overbaker/square2/discussions) or [Issue](https://github.com/Overbaker/square2/issues) before large design changes.
