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

## Commands

Run from the repository root (or pass `--root <dir>`). Exit codes: `0` pass, `1` violations, `2` square² could not run (catalogue, self-test, engine, vendor or usage error).

| Command | What it does |
|---|---|
| `square2 check [--only <ids>] [--format text\|github] [--report <path>] [--base <sha>]` | Self-test, then run every enabled rule, subtract `.square2/baseline.json` and live exceptions, print `[ID] path:line message — Instead: …` lines and write `square2-report.json`. With `--base`, also enforce the baseline ratchet and exception immutability against that commit (all-zero sha = no previous commit; an unknown sha exits 2). |
| `square2 selftest [--only <ids>]` | Every enabled rule must fire on `.square2/fixtures/<id>/bad/` and stay silent on `good/`. |
| `square2 baseline show \| shrink \| grow --approval <id>` | Inspect, shrink (drop entries no longer observed), or grow (cite an entry of `.square2/approvals.yaml`) the baseline. |
| `square2 exceptions lint [--base <sha>]` | Validate `.square2/exceptions.yaml`. |
| `square2 vendor --from <path\|git-url> --ref <tag> [--into <dir>]` | Copy square² into `tools/square2/` and pin it in `.square2/lock.json`; the vendored runner refuses to run if its tree changes. |
| `square2 replay --rule <id> (--commit <sha> \| --since <days>) [--out <file>]` | Run one rule on history in a temporary worktree: does it fire newly on `<sha>` and not on its parent; or which commits in the window it fires on (with `grade: null` per firing). |

`<ids>` is a comma-separated list of id globs such as `S2-DEP-*,S2-SUPPRESS-*`. `--square2-dir <dir>` (or `SQUARE2_DIR`) reads the catalogue from another directory.

## Configuration (`.square2/config.yaml`)

```yaml
approvers:
  - some-login
max_exception_ttl_days: 90
require_provenance: false   # true: every enabled rule needs born_from and a replay report
generated:
  - apps/web/generated/**
engines:
  ruff:
    command:                # block list; e.g. a workspace venv or uv
      - uv
      - run
      - --project
      - python
      - ruff
  depcruise:
    config: .dependency-cruiser.cjs
  eslint:
    config: eslint.config.mjs
```

Engines: `depcruise` and `eslint` run the repository's own installed tools; `ruff` runs the configured command; `suppressions` is built in; `command` runs `options.argv` (with `{root}` replaced by the tree to scan) and reads one JSON object per line: `{"path": "src/a.ts", "line": 3, "subject": "what is wrong"}`.

## Vendoring

`square2 vendor` copies square² into the repository and pins the copy in `.square2/lock.json`. Verification is mandatory as soon as `.square2/config.yaml` declares `vendored_path`, a lock exists, or the running copy carries the `.square2-vendored` marker: the lock's `path` must be a plain repo-relative path and the tree there must hash to `tree_sha256`, else every command exits 2 with `[S2-VENDOR-TAMPERED]`.

Threat model: detects accidental edits of the vendored copy; a committer can always change policy, which review of the commit must catch.
