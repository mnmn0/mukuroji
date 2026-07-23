# Agent routing

Choose review agents from the changed-file set and risk, not from a fixed checklist.
The parent agent should classify the diff before fan-out and pass each child an
explicit perspective, model, and reasoning effort.

## Routing rules

- Only an empty diff requires no review agent. Every non-empty diff must select at
  least one perspective.
- Documentation changes select `issue-fit`.
- Localization resources and translated user-facing text select `web-ui`.
- Lockfiles, package or workspace manifests, generated files, binaries, symlinks,
  gitlinks, and file-mode-only changes select `dependency-integrity`.
- `AGENTS.md`, Skill instructions or metadata, permissions, hooks, reviewer
  configuration, and other policy-like changes select both `security` and
  `architecture`.
- `server/` selects the perspectives matched by the changed behavior from
  `issue-fit`, `business-correctness`, `testing`, `security`, `data-integrity`,
  `architecture`, and `operations`.
- `contracts/` or public HTTP/API changes select `issue-fit`, `api-contract`,
  `architecture`, and `testing`; add `security` for authentication, authorization,
  or public exposure.
- `web/` selects `issue-fit`, `business-correctness`, `web-ui`, and `testing`; add
  `api-contract` when request or response behavior changes.
- `cdk/` selects `issue-fit`, `cdk-deploy`, `security`, and `testing`; add
  `operations` for rollout, backup, alarms, or recovery changes and
  `dependency-integrity` for synthesized, packaged, or executable artifacts.
- Migration, backfill, event, worker, schedule, retry, persistence, or transaction
  changes select `data-integrity`; add `operations` at high tier when recovery or
  data loss is plausible.
- For any non-empty change not covered above, select `issue-fit` and add the closest
  technical perspective supported by the changed behavior.

## Selection and capacity

- In capability-enforced child mode, dispatch exactly one independent agent for each
  selected perspective. Never merge multiple perspectives into one child, even when
  they inspect the same evidence. In parent-only fallback, complete the same
  perspective checklists one at a time.
- Run every matched perspective. Rank high-tier perspectives first, then rank the
  remaining standard and lite perspectives by their concrete risk to this change.
  Do not use a fixed checklist order as a substitute for change-specific risk.
- Run agents in waves of `min(runtime's currently available child slots, 4)` and obey
  any stricter total-agent limit. If the runtime does not expose available capacity,
  use one concurrent child. In child mode, a selected perspective whose child is not
  started, does not return a final result, or is otherwise omitted makes the overall
  result `INCOMPLETE`. In parent-only fallback, a selected perspective without a
  separately recorded completed checklist has the same result.

## Models and fallback

| Tier | Model | Reasoning effort | Typical perspectives |
| --- | --- | --- | --- |
| lite | `gpt-5.6-terra` | `low` | issue fit, tests, documentation, low-risk UI |
| standard | `gpt-5.6-terra` | `xhigh` | business, architecture, API, Web UI, dependencies, normal operations |
| high | `gpt-5.6-sol` | `high` | security, data integrity, CDK, migration, recovery |

In capability-enforced child mode, use the recommended model and effort when the
runtime provides them. Otherwise:

1. Prefer a runtime-supported model of equivalent or greater capability and preserve
   the requested reasoning effort.
2. For lite or standard work, if the requested effort is unsupported, use the
   nearest supported effort at or below it and record the model and effort fallback.
3. For high-tier work, only an equivalent-or-stronger model at `high` or greater
   counts as completing the perspective. A lower-capability model or lower effort may
   provide supplemental evidence, but the overall result remains `INCOMPLETE`.
4. If no runtime-supported model can run a selected perspective, record it as omitted
   and set the overall result to `INCOMPLETE`.

Use child routing only when the runtime enforces the capability restrictions in the
main Skill. Set `fork_turns` to `"none"` for every child. Put
`review_mode: single-perspective`, the assigned perspective, matching reference,
pinned object IDs, direct user constraints, and sanitized evidence in a
self-contained trusted control block. Child prompts must not trigger the top-level
Skill workflow. Track child IDs, wait for final results, and interrupt active
children on timeout or cancellation when supported. Do not require or attempt a
separate close operation.

When capability-restricted children are unavailable, launch none. The parent applies
the same routing order and completes each selected reference checklist sequentially.
Concurrency routing is then not applicable. The parent must meet the strongest model
and reasoning tier selected by the change; if it does not, the overall result is
`INCOMPLETE`. Record the parent-only capability fallback and parent tier explicitly.
