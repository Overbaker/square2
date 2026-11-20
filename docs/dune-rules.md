# Gate rules

The gate turns architecture invariants into deterministic checks. It never calls a model. The same
command (`square2 check`) runs locally (pre-push hook) and in CI, so both give the same verdict.

## The five rules of the gate

1. **Invariants are code.** An invariant that matters is a rule in `.square2/rules/*.yaml`, run by an
   engine (`depcruise`, `eslint`, `ruff`, `suppressions`, `pattern`, `command`) on every push. A rule
   that lives only in a prompt or a wiki page is not enforced.
2. **Errors name the fix.** Every violation prints `[ID] path:line message — Instead: <what to do>`.
   The `instead` text is mandatory, so an agent can act on the error without asking.
3. **Only new violations fail.** Existing violations are recorded in `.square2/baseline.json` (by
   fingerprint, which survives line moves). The baseline only shrinks (`square2 baseline shrink`);
   growing it needs an entry in `.square2/approvals.yaml` from a listed approver
   (`square2 baseline grow --approval <id>`). CI checks the ratchet against the previous commit.
4. **Exceptions expire.** A deliberate exception goes into `.square2/exceptions.yaml` with its rule, a
   narrow scope, a reason, an owner, an ADR, and `created_at`/`expires_at` at most
   `max_exception_ttl_days` (default 90) apart. An expired exception covers nothing, and an expiry
   cannot be edited (renew with a new entry, `renews: <old id>`). Inline suppression comments are
   rules too (`suppressions` engine), for example "no suppression without a reason".
5. **Rules prove themselves.** Every enabled rule must fire on `.square2/fixtures/<id>/bad/` and stay
   silent on `good/`; `check` runs this self-test first and exits 2 if a rule is broken. A rule is
   admitted only from a real failure (below).

Each rule records a `dune_rule` class from 1 to 5 for hit statistics. square² does not interpret the
number; a consumer's batches can say which classes they cover (for example boundary rules as 2 and
suppression rules as 5).

## Failure-born admission

A rule may be enabled only when it was born from a real defect:

- `born_from: <sha>` names the commit that introduced the defect;
- `.square2/replay/<id>.json` shows the rule fires on that commit and not on its parent.

With `require_provenance: true` in `.square2/config.yaml`, `check` refuses a rule without both
(`[S2-CATALOGUE] <id> missing born_from replay`, exit 2). A rule nobody can tie to a real failure is
speculation, and speculative rules are the main source of gate noise.

## Replay

`square2 replay` runs one rule against history in a temporary git worktree; the working tree is never
touched.

- `square2 replay --rule <id> --commit <sha> --out .square2/replay/<id>.json`: does the rule fire newly
  on `<sha>` (violations its parent does not have) and not on the parent? Commit the report.
- `square2 replay --rule <id> --since 90`: every commit in the window the rule fires on, each with
  `grade: null`. Grade the firings (real problem or noise) before enabling the rule; a rule whose
  firings are mostly noise stays disabled.

The review bot proposes candidate rules for confirmed review findings (closed as completed and marked
mechanizable). A candidate is a `pattern` rule with `enabled: false`; it is posted only if its replay
fires on the finding's `born_from` and not on its parent. A human commits it to enable it.
