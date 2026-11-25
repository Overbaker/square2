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
  one that writes most commits (author families come from the author trailers, below).
- `review.author_trailers`: the commit trailers whose values name the writers (default
  `[Co-Authored-By]`, keys compared case-insensitively; a value may list several writers separated
  by commas). The author families are the union over every listed trailer: with
  `[Co-Authored-By, X-Writers]`, a commit carrying `Co-Authored-By: Claude …` and `X-Writers: codex`
  has the families `anthropic` and `openai`. The name map: `claude`, `anthropic` → anthropic;
  `codex`, `gpt*`, `openai` → openai; `gemini`, `antigravity`, `agy` → google. A consistent setup for
  such commits lists a reviewer of a third family after the primary, both served by the endpoint:

  ```yaml
  reviewers:
    - family: openai
      provider: azure
      model: gpt-review      # SQ2_REVIEW_MODEL=gpt-review
    - family: google
      provider: azure
      model: gemini-review
  review:
    author_trailers:
      - Co-Authored-By
      - X-Writers
  ```

  A range with only anthropic writers is reviewed by `gpt-review`; a range that also has
  `X-Writers: codex` is reviewed by `gemini-review`. `SQ2_REVIEW_MODEL` and
  `SQ2_REVIEW_FALLBACK_MODEL` apply only when they name a deployment of the selected reviewer's
  family; otherwise `review run` ignores them (with a note) and uses the selected reviewer's model, so
  the variable never forces the primary back in. With only the openai reviewer configured, that range
  is reviewed same-family and the digest says so.
- `review.change_id_trailers`: trailers whose value is a change id (default none). A commit carrying
  one, for example `X-Change: add-cache`, joins the group `change:add-cache` even when it touches no
  `openspec/changes/<id>/` path. The trailer wins over paths and message mentions. A value counts
  only if it is lowercase words joined by single dashes (at most 16 words, 64 characters) and does
  not look like a secret; any other value is ignored, never used as a group id and never shown.
- `review.provenance_trailers`: further trailers shown on escape records (default none). List your
  reviewer trailer here, for example `X-Reviewers`, so an escape shows who reviewed the change.
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
what is pushed and writes nothing into the repository. In a checkout without
`tools/square2/bin/square2.mjs` (an older branch, or a linked worktree sharing `core.hooksPath`) it
prints `square² not present in this checkout; skipping` and lets the push proceed.

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

### Escape records (experimental, off by default)

Escape records are experimental in v0.1.1 and disabled unless `.square2/config.yaml` sets:

```yaml
escapes:
  enabled: true
```

With the default `false`, `prepare` detects nothing and writes no escape data into its context, and
`publish` creates, updates and credits nothing for escapes; the digest has no escape section. The
design is being reworked for v0.1.2 (see [trust-model.md](trust-model.md)). When enabled, the
daily review's `prepare` step also looks for fix commits in the reviewed range (non-merge
commits on the branch whose subject matches `^(fix|hotfix|revert)(\(|:|\s)` or the words
`regression`, `hotfix` or `revert`, or that carry a `Fixes-Commit: <sha>` trailer with a 7 to 40
character hex sha; any other `Fixes-Commit` value is ignored). This is plain pattern matching; no
model is called. Commits that touch only paths excluded from the review are ignored. Escapes are
found even when no group fits the input budget, and are published then too. Pull request reviews
and `--test` publications record no escapes; their digests still list the open unclassified ones.

`publish` then turns each fix commit into one issue labelled `square2:escape`, keyed by
`<!-- square2:escape:<fix sha> -->`, so re-runs never duplicate it. The issue records the fix sha,
the introducing sha (from `Fixes-Commit`, else `unknown`), the changed files, `layer: unclassified`
and every allow-listed trailer the commit carries: those named in `review.author_trailers`,
`review.change_id_trailers` and `review.provenance_trailers`, plus `Fixes-Commit`. The subject and
every trailer value are escaped; a value that looks like a secret anywhere in its full text is shown
as `<redacted>` (checked before anything is truncated). New escapes count against
`max_new_issues_per_run` together with the review's findings (escapes first, including those a
retried run already created); those over the cap are listed in the overflow note on the state
issue, which shows the configured cap and what remained of it for findings.

A fix that closes a caught finding is not an escape. That needs a GitHub closing keyword (`Closes`,
`Fixes`, `Resolves` and their forms) followed by `#<n>` with only spaces between them, in prose
(fenced blocks with any indentation, also inside quotes and list items, indented code, and inline
code spans of any backtick-run length never count), without an `owner/repo` prefix, where `#<n>` is a `square2:gate` or `square2:review` issue that is
not a `square2:test` issue and was not closed as not planned or duplicate. That issue gets one
`credited` comment naming the fix commit. A bare mention (`See #42`) never credits. The decision is
recorded the first time: an escape issue, or the credit comment. Later runs follow it even if the
issue's labels or state change. Escapes are found by their marker on any issue square² itself
opened (the token's login), whatever its labels, so relabelling or classifying one never duplicates
it (missing `square2` and `square2:escape` labels are added back); a marker in an issue or comment by
anyone else is ignored, and only square²'s own gate and review issues can be credited. Trailer
values are allow-listed and redacted before the prepare step writes its context.

Classify an escape by adding one `layer:<name>` label (for example `layer:gate`, `layer:tests`,
`layer:review` or `layer:human`) and record the follow-up (a rule, a test, review context or a process
change). square² never sets these labels. Every review digest lists the open escapes without a
`layer:*` label under "Escapes awaiting classification".

## 7. Variables and secrets

| Name | Kind | Value |
|---|---|---|
| `SQ2_GATE_ENABLED` | variable | `true` to run the gate |
| `SQ2_REVIEW_ENABLED` | variable | `true` to run the scheduled review |
| `SQ2_AZURE_OPENAI_ENDPOINT` | variable | `https://<resource>.openai.azure.com/` |
| `SQ2_REVIEW_MODEL` | variable | deployment name of the primary reviewer (used only when its family is the selected reviewer's) |
| `SQ2_REVIEW_FALLBACK_MODEL` | variable | optional second deployment, same family (same rule) |
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
