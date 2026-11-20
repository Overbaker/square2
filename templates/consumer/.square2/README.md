# square² in this repository

square² has two parts here:

- **Gate** (`.github/workflows/square2-gate.yml`, `.githooks/pre-push`): deterministic rules from
  `.square2/rules/`, a ratcheting baseline and expiring exceptions. A new violation prints
  `[ID] path:line message — Instead: <the fix>`.
- **Review** (`.github/workflows/square2-review.yml`): once a day, a model from a different family
  than the commits' authors reviews the new commits on the integration branch. Findings become issues.

## Status: advisory

Nothing here blocks a merge or a push on the server. A red gate run does not revert or stop anything;
its effect comes from the finding issues it opens and from the local pre-push hook. Review findings
never fail a job.

The local hook runs `square2 check --rev <commit>` on every commit being pushed (in a temporary
worktree, writing nothing into the repository) and rejects the push on a non-zero exit. It is activated with `git config core.hooksPath .githooks` (CONSUMER: or your
package manager's `prepare` script). `git push --no-verify` skips it; the server-side gate still
records the violation as an issue.

## Kill switches

Repository variables `SQ2_GATE_ENABLED` and `SQ2_REVIEW_ENABLED`: anything other than `true` turns the
workflow off. Removing files is not needed.

## Threat model

- `tools/square2/` is a vendored, hash-locked copy (`.square2/lock.json`); a hand edit makes every
  command exit 2 with `[S2-VENDOR-TAMPERED]`. This catches accidents, not a committer who changes
  policy on purpose: review of the commit must catch that.
- The review model reads commit messages, code and issue text, all untrusted. It runs with no GitHub
  token and no checkout, in a read-only sandbox, with only the LLM key. Its output is validated
  against a schema and fully escaped before it is published; the worst case is a misleading issue.
- Only the gate's and the review's publish jobs hold an issues token. The gate only opens and updates
  finding issues and comments on the state issue; only the review writes the state issue's body, one
  review at a time (its own concurrency group), re-reading it first and moving it forward only.
- The LLM key lives only in the `SQ2_AZURE_OPENAI_API_KEY` secret and reaches only the analyze job.

## Changing rules

A rule is admitted only from a real past defect: `born_from: <sha>` plus `.square2/replay/<id>.json`
showing it fires on that commit and not on its parent (`square2 replay --rule <id> --commit <sha>`).
See square²'s `docs/dune-rules.md`.
