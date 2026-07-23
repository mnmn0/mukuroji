# Agent routing

Choose review agents from the changed-file set and risk, not from a fixed checklist.
The parent agent should classify the diff before fan-out and pass each child an
explicit perspective, model, and reasoning effort.

## Routing rules

- Empty, generated-only, or binary-only diff: do not launch a review agent.
- Docs, localization, lockfile, or Skill metadata only: launch `issue-fit` with
  `gpt-5.6-luna` and `low`; add `architecture` and `security` when policy-like
  instructions or permissions changed.
- `server/`: launch `issue-fit`, `business-correctness`, `testing`, and the matching
  `security`, `data-integrity`, `architecture`, or `operations` roles.
- `contracts/` or public HTTP/API changes: launch `issue-fit`, `api-contract`,
  `architecture`, and `testing`; add `security` for auth or public exposure.
- `web/`: launch `issue-fit`, `business-correctness`, `web-ui`, and `testing`; add
  `api-contract` when request/response behavior changes.
- `cdk/`: launch `issue-fit`, `cdk-deploy`, `security`, and `testing`; add
  `operations` for rollout, backup, alarms, or recovery changes.
- Migration, backfill, event, worker, schedule, or retry changes: always add
  `data-integrity` and `operations` at high tier when recovery or data loss is
  plausible.
- `AGENTS.md`, Skill instructions, or reviewer policy changes: add `security` and
  `architecture` even when the rest of the diff is documentation-only.

## Tiers

- `lite`: `gpt-5.6-luna`, `low` — intent fit, tests, docs, metadata, and low-risk UI.
- `standard`: `gpt-5.6-luna`, `xhigh` — business, architecture, API, Web UI, and
  normal operations.
- `high`: `gpt-5.6-sol`, `high` — security, data integrity, CDK, migration, and
  disaster recovery.

Use at most eight agents and four concurrent executions. If a diff matches several
roles, merge compatible low-risk roles rather than launching redundant agents. If a
required high-risk role cannot run because its model is unavailable, use the
configured default with `medium` effort and record the fallback in the review.

Track all returned agent IDs and close each child immediately after its final result.
On timeout or interruption, stop the child if possible, record the incomplete review,
and close the child before continuing. Do not leave completed agents open merely
because their result has already been read.
