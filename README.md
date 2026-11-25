# square² (方方)

square² is a repo-agnostic skeleton with two planes. The **deterministic gate** runs a validated rule catalogue through engine adapters, subtracts a ratcheting baseline and expiring exceptions, and fails only on new violations, each printed with the fix (`Instead:`). The **advisory cross-family review** has a model from a different family than the code's authors review new commits and publish findings as issues; it never blocks anything.

Status: v0.1 in progress. Both planes are advisory: square² reports and opens issues; it does not block merges.

Docs: [gate rules](docs/dune-rules.md) · [consumer guide](docs/consumer-guide.md) · [trust model](docs/trust-model.md) · [auth](docs/auth.md). Templates for a consumer repository (workflows, `.square2/`, pre-push hook) are in [`templates/consumer/`](templates/consumer/).

Zero runtime dependencies. Requires Node >= 22.

```sh
npm install
npm run typecheck
npm test
```

CI (`.github/workflows/ci.yml`) runs the same plus an agnosticism grep whose word list is the
repository secret `SQ2_FORBIDDEN_PATTERN` (an extended regex, masked in logs), so the public
repository never names a consumer. Without the secret (forks) that step is skipped.

License: MIT.

## Commands

Run from the repository root (or pass `--root <dir>`). Exit codes: `0` pass, `1` violations, `2` square² could not run (catalogue, self-test, engine, vendor or usage error).

| Command | What it does |
|---|---|
| `square2 check [--only <ids>] [--format text\|github] [--report <path>] [--base <sha>] [--rev <sha>]` | Self-test, then run every enabled rule, subtract `.square2/baseline.json` and live exceptions, and print `[ID] path:line message — Instead: …` lines. `--report <path>` writes the JSON report (nothing is written without it). With `--base`, also enforce the baseline ratchet and exception immutability against that commit (all-zero sha = no previous commit; an unknown sha exits 2). With `--rev`, gate that commit's tree in a temporary worktree instead of the working tree (the pre-push hook uses this). |
| `square2 config get <key>` | Print one scalar of `.square2/config.yaml` (exit 1 when unset); the review workflow reads `branch` with it. |
| `square2 selftest [--only <ids>]` | Every enabled rule must fire on `.square2/fixtures/<id>/bad/` and stay silent on `good/`. |
| `square2 baseline show \| shrink \| grow --approval <id>` | Inspect, shrink (drop entries no longer observed), or grow (cite an entry of `.square2/approvals.yaml`) the baseline. |
| `square2 exceptions lint [--base <sha>]` | Validate `.square2/exceptions.yaml`. |
| `square2 vendor --from <path\|git-url> --ref <tag> [--into <dir>]` | Copy square² into `tools/square2/` and pin it in `.square2/lock.json`; the vendored runner refuses to run if its tree changes. |
| `square2 replay --rule <id> (--commit <sha> \| --since <days>) [--out <file>]` | Run one rule on history in a temporary worktree: does it fire newly on `<sha>` and not on its parent; or which commits in the window it fires on (with `grade: null` per firing). |
| `square2 review prepare \| run \| validate \| publish \| guard-env` | The daily review in three steps with separate credentials: `prepare` (context and tree archive), `run` (codex on a read-only copy, no GitHub token), `publish` (validated findings as issues, state). See [docs/consumer-guide.md](docs/consumer-guide.md). |
| `square2 publish-gate [--report <path>] [--branch <name>] [--test]` | Publish new gate violations as issues (configured branch only, unless `--test`). |
| `square2 budget` | Month-to-date Actions minutes of the square² workflows; warns on the state issue over the threshold. |

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
escapes:
  enabled: false            # experimental escape records (default false)
review:
  author_trailers:          # trailers naming the writers (default Co-Authored-By)
    - Co-Authored-By
    - X-Writers
  change_id_trailers:       # trailers whose value is a change id (default none)
    - X-Change
  provenance_trailers:      # further trailers shown on escape records (default none)
    - X-Reviewers
```

Escape records (experimental, off by default; `escapes.enabled: true`): fix commits on the reviewed branch become `square2:escape` issues (one per fix sha, no model call); a fix that closes a gate or review issue credits that issue instead. See docs/consumer-guide.md.

Engines: `depcruise` and `eslint` run the repository's own installed tools; `ruff` runs the configured command; `suppressions` is built in; `command` runs `options.argv` (with `{root}` replaced by the tree to scan) and reads one JSON object per line: `{"path": "src/a.ts", "line": 3, "subject": "what is wrong"}`.

## Changes

- **0.1.1**: configurable author, change-id and provenance trailers (`review.*_trailers`); commit
  trailers outside that allow-list never reach the review context or prompts; the model override
  (`SQ2_REVIEW_MODEL`) applies only within the selected reviewer's family; the pre-push hook skips
  checkouts without `tools/square2`; escape records added as an experimental feature, off by default
  (`escapes.enabled`), to be redesigned in 0.1.2.
- **0.1.0**: first release.

## Vendoring

`square2 vendor` copies square² into the repository and pins the copy in `.square2/lock.json`. Verification is mandatory as soon as `.square2/config.yaml` declares `vendored_path`, a lock exists, or the running copy carries the `.square2-vendored` marker: the lock's `path` must be a plain repo-relative path and the tree there must hash to `tree_sha256`, else every command exits 2 with `[S2-VENDOR-TAMPERED]`.

Threat model: detects accidental edits of the vendored copy; a committer can always change policy, which review of the commit must catch.
