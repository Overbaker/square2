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

Commit messages reach the context and the prompts with their subject and body, but in the trailer
block (a final paragraph of `Key: value` lines only) just the allow-listed trailers survive:
`review.author_trailers`, `review.change_id_trailers` (valid ids only) and
`review.provenance_trailers`, with secret-shaped values redacted. Every other trailer line
(`Signed-off-by`, ticket or internal trailers, `Fixes-Commit` unless listed) is removed first.

Threat model note: in a private repository, people who can read issues, Actions artifacts or model
prompts can already read the commit history and the code; redaction is defense in depth, not a
boundary.

Trailers are commit text too. `review.author_trailers` and `review.change_id_trailers` only steer
reviewer selection and grouping: a committer who writes a false `X-Writers` trailer can make the
review pick a same-family reviewer (marked same-family in the digest) or regroup commits, never skip
the review or publish anything. Escape records (experimental, off unless `escapes.enabled: true`) come from the same commit messages by fixed patterns,
in the `prepare` step, with no model call. Only allow-listed trailers (the configured author and
change-id trailers and `Fixes-Commit`) are shown; subjects and values pass the same secret check as
model text and are replaced by `<redacted>` when they look like a credential. The bot never sets
their `layer:*` classification. A credit needs a closing keyword on a real, non-test gate or review
issue, so a mention cannot silence an escape. Escape and credit markers count only on issues and
comments written by the token's own login, so a pasted marker cannot suppress one. The prepare
context stores escape trailers already allow-listed and redacted; change-id trailer values that are
not plain ids are dropped. A `--test` publication uses its own nonce-scoped run
id and issue keys, never writes the review state, and records no escapes.

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

## Open items for v0.1.2

Escape records stay off by default until these are redesigned:

- Escape credit via an explicit trailer only (no Markdown parsing of commit messages).
- Cap accounting across retries and issue updates (one ledger for findings and escapes).
- Stale branch detection (a range whose commits are no longer on the branch records nothing).
