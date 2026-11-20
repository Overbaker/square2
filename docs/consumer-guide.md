# Consumer guide

How to add square² to a repository. Templates live in `templates/consumer/`. Every YAML file
square² reads uses block maps and block lists only (no `{}` or `[]` flow syntax).

## 1. Vendor

From the consumer repository root:

```sh
node /path/to/square2/bin/square2.mjs vendor --from https://github.com/<owner>/square2 --ref v0.1.0
```

This copies `bin/ src/ prompts/ schemas/ LICENSE` into `tools/square2/` and writes
`.square2/lock.json` (`version`, `commit_sha`, `tree_sha256`). Every command verifies the copy against
`<repo root>/.square2/lock.json` (even when `SQUARE2_DIR` points the catalogue elsewhere) and exits 2
with `[S2-VENDOR-TAMPERED]` if it was edited. To upgrade, run the same command with a new `--ref`.

## 2. Config

Copy `templates/consumer/.square2/config.yaml` and fill in every `CONSUMER` line. Start with
`require_provenance: false`: rules cannot have provenance before they exist.

- `branch`: the integration branch. The gate publishes issues only for pushes to it; the review
  reviews it (`square2 config get branch` prints it for the workflows).
- `notify`: logins mentioned once per run digest (nowhere else).
- `approvers`: who may approve baseline growth.
- `reviewers`: the review model, by family, provider and deployment. Pick a family different from the
  one that writes most commits (author families come from `Co-Authored-By` trailers).
- `risk_paths`: groups touching these are reviewed first and keep their full diffs when a call must
  be trimmed.
- `budget`: the monthly minutes target. A run counts as its wall time times its job count; the
  default count is 1, which is right for the square² workflows because their jobs run one after
  another. Only a workflow whose jobs run in parallel needs `budget.jobs` (block map, file name to
  the number of jobs that run at once).

Copy `review-context.md` and describe what a reviewer needs to know beyond one diff.

## 3. Rules and fixtures

One YAML file per area in `.square2/rules/`. Each rule has `id`, `dune_rule`, `engine`, `scope`,
`instead` and `owner`, and needs `.square2/fixtures/<id>/bad/` (must fire) and optionally `good/`
(must stay silent). See [dune-rules.md](dune-rules.md).

```yaml
rules:
  - id: S2-DB-SINGLE-OWNER
    dune_rule: 2
    engine: pattern
    scope:
      - 'apps/**'
    instead: create tables only in the database package (move this DDL into a migration there)
    owner: your-login
    options:
      pattern: 'CREATE TABLE'
```

## 4. Replay, then provenance

For each rule, find the commit that introduced the real defect it is meant to catch, and replay:

```sh
node tools/square2/bin/square2.mjs replay --rule S2-DB-SINGLE-OWNER --commit <sha> --out .square2/replay/S2-DB-SINGLE-OWNER.json
node tools/square2/bin/square2.mjs replay --rule S2-DB-SINGLE-OWNER --since 90
```

The first must report that it fires on `<sha>` and not on its parent; the second lists the commits it
would have fired on, to grade before enabling. Then add `born_from: <sha>` to the rule, commit the
replay report, and once every enabled rule has both, set `require_provenance: true`.

```sh
node tools/square2/bin/square2.mjs selftest   # every rule fires on bad/, stays silent on good/
```

## 5. Baseline

Existing violations are accepted once, with an approval in `.square2/approvals.yaml`:

```yaml
approvals:
  - id: A-0001
    approver: your-login
    date: '2026-11-20'
    reason: introduce the batch-1 rules on existing code
    adr: link or path to the decision record
```

```sh
node tools/square2/bin/square2.mjs baseline grow --approval A-0001
node tools/square2/bin/square2.mjs check   # exit 0
```

Afterwards the baseline only shrinks (`baseline shrink` drops entries that are fixed); growing it
again needs a new approval.

## 6. Workflows and the local hook

Copy `templates/consumer/.github/workflows/square2-{gate,review}.yml` and
`templates/consumer/.githooks/pre-push`. In the gate workflow set the branch and replace the
`CONSUMER` block with the tools your engines need. Activate the hook with
`git config core.hooksPath .githooks` (or from your package manager's `prepare` script). The hook
runs `check --rev <pushed commit>` for every pushed ref, in a temporary worktree, so it gates exactly
what is pushed and writes nothing into the repository.

- **Gate**: push to the branch, pull requests to it, and manual dispatch; docs-only changes do not
  start it. The `check` job (`contents: read`) is cancelled by a newer push to the same ref. The
  `publish` job (`issues: write`) runs after it, only for a push or a dispatch with `test: true`.
- **Review**: daily at 01:00 UTC and on dispatch (optional `from` and `to`, both or neither; an
  explicit range never moves the review state). The branch comes from `.square2/config.yaml`; the
  schedule fires on the default branch and checks that branch out. A dispatch runs even while
  `SQ2_REVIEW_ENABLED` is not `true`, for the pilot. Three jobs: `prepare` (reads the state issue),
  `analyze` (codex on a read-only copy of the tree; no checkout, no GitHub token), `publish`
  (issues, the state, the budget check).

Two concurrency groups, neither ever cancelled:

- `square2-gate-publish-<repo>`: one gate publication at a time. The gate only creates and updates
  finding issues and comments on the state issue (digest, overflow list); it never writes the state
  issue's body.
- `square2-review-<repo>`: one review at a time. The review is the only writer of the state issue's
  body (last reviewed commit, published runs): it re-reads the body right before writing and only
  moves it forward.

So a gate publication never waits for a review, and the state body has a single writer.

## 7. Variables and secrets

| Name | Kind | Value |
|---|---|---|
| `SQ2_GATE_ENABLED` | variable | `true` to run the gate |
| `SQ2_REVIEW_ENABLED` | variable | `true` to run the scheduled review |
| `SQ2_AZURE_OPENAI_ENDPOINT` | variable | `https://<resource>.openai.azure.com/` |
| `SQ2_REVIEW_MODEL` | variable | deployment name of the primary reviewer |
| `SQ2_REVIEW_FALLBACK_MODEL` | variable | optional second deployment, same family |
| `SQ2_AZURE_OPENAI_API_KEY` | secret | the Azure OpenAI key (see [auth.md](auth.md)) |

Set the secret from stdin so it never lands in a file or shell history:
`gh secret set SQ2_AZURE_OPENAI_API_KEY` (paste, then Ctrl-D).

## 8. Pilot

1. Vendor, write rules and fixtures, grow the baseline, and make `check` pass locally.
2. Push the workflows with `SQ2_GATE_ENABLED=true` and `SQ2_REVIEW_ENABLED=false`.
3. First test publication: on a throwaway branch, commit one violation and push it with
   `git push --no-verify` (the local hook would rightly refuse it). Dispatch the gate on that branch
   with `test: true`: one `square2:test` issue and one digest appear, and the issue ends closed as
   not planned. Delete the branch.
4. Run the review locally on a fixed range, with outputs outside the repository:

   ```sh
   node tools/square2/bin/square2.mjs review prepare --from <a> --to <b> --out /tmp/sq2-review
   SQ2_AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/ SQ2_AZURE_OPENAI_API_KEY=... \
     node tools/square2/bin/square2.mjs review run --context /tmp/sq2-review --out /tmp/sq2-analysis
   node tools/square2/bin/square2.mjs review validate --context /tmp/sq2-review --analysis /tmp/sq2-analysis --out /tmp/sq2-review.json
   ```

   (Read the key from a password manager into the environment; do not type it into history.)
5. Set the secret and variables, dispatch the review once (it runs although
   `SQ2_REVIEW_ENABLED` is still false), read the issues, then set `SQ2_REVIEW_ENABLED=true`.

Rollback: set both variables to anything but `true`.
