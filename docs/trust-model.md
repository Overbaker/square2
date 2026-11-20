# Trust model

## Status: advisory

square² reports; it does not enforce on the server. On plans without branch protection nothing can
make a check required, and square² does not try: its effect comes from finding issues and from the
local pre-push hook (which `git push --no-verify` skips). Review findings never fail a job.

## Credential split

| Where | Has | Does not have |
|---|---|---|
| gate `check` job | `contents: read` | any issues token, any secret |
| gate `publish` job | `issues: write` (GITHUB_TOKEN, one step); comments only on the state issue | secrets |
| review `prepare` | `contents: read`, `issues: read` | the LLM key |
| review `analyze` | the LLM key (`SQ2_AZURE_OPENAI_API_KEY`), `permissions: {}` | a checkout, `.git`, any GitHub token |
| review `publish` | `contents: read`, `issues: write`, `actions: read` | the LLM key |
| pre-push hook | the developer's machine | nothing square² adds |

`analyze` runs `square2 review guard-env` first: it exits 1 if `GITHUB_TOKEN`, `GH_TOKEN` or
`ACTIONS_RUNTIME_TOKEN` is set. `review run` then starts codex with an allow-listed environment, a
fresh `CODEX_HOME`, `--sandbox read-only`, and the extracted tree archive (no `.git`) as its working
directory.

## Untrusted inputs

Commit messages, code, comments, issue text and pull request text can carry prompt injection. They
reach the model only as fenced evidence, and nothing the model writes is trusted:

- The analysis artifact is reduced to the result JSON (per call), the model that answered (per call)
  and token counts. Every other field is ignored; the same-family decision and `--allow-same-family`
  come from the publish step itself.
- Results are validated against `schemas/review.v1.json`, stage consistency and caps. Findings must
  anchor to a changed line the model was shown; others are demoted or kept as digest notes.
- Every published string is escaped as plain Markdown text (no links, images, HTML, mentions, issue
  references or fences) and rejected when it looks like a secret, after Unicode normalisation.
- Any model output containing the LLM key, in any common encoding, aborts the run before anything is
  written.

The worst case is a misleading issue, which a human closes.

## The vendored copy

`tools/square2/` is pinned by `.square2/lock.json`; any edit makes every command exit 2. This detects
accidental and drive-by edits. It does not stop a committer who changes the policy or the copy on
purpose (they can update the lock too); review of that commit has to catch it. Upgrades are explicit
(`node tools/square2/bin/square2.mjs vendor --from https://github.com/<owner>/square2 --ref <tag>`)
and show up as one reviewable diff. The lock is always `<repo root>/.square2/lock.json`, whatever
`SQUARE2_DIR` says.

## Publisher

Every write carries a marker for its run, so a retry after a partial failure recognises its own
earlier writes. Markers count only in comments written by the token's own login.

The state issue's body (`last_reviewed_sha`, published runs) has one writer: the review's publish
job, one review at a time (concurrency group `square2-review-<repo>`). It re-reads the body right
before writing and never moves `last_reviewed_sha` backward; explicit and pull request ranges never
move it. The gate (group `square2-gate-publish-<repo>`) only creates and updates finding issues and
comments on the state issue, so it can run while a review does. When both create the state issue on
their very first run, both adopt the lower-numbered one.
