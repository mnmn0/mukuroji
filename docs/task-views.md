# Task views

Task views provide one permission-aware definition for Work Item result sets and their
presentation. A definition owns its surface and scope together with filters, ordered
sorts, grouping, columns, density, and display options. Saved definitions add the
personal, Team, or Workspace sharing lifecycle without turning route-local UI state
into a second persisted source of truth.

## Lifecycle and precedence

- The built-in route definition is always the permission-safe fallback.
- A readable Team default replaces the built-in definition.
- A personal default replaces the Team default.
- An explicitly selected saved view replaces either default.
- A validated URL override is layered over that baseline without modifying the
  saved definition.

Saved views can be favorited, pinned, duplicated, and shared by permalink. Create,
duplicate, update, and delete responses are reconciled into the Web cache before a
background refresh. Server-side sanitization removes inaccessible or deleted fields,
statuses, relations, Projects, and Teams and returns migration warnings with the
safe fallback.

## Surface support

Project, Team, and My Tasks currently bind their route state to the shared controller.
They use the same URL encoding, saved-view lifecycle, selection/focus reducer, and
canonical Work Item action registry. An action that a surface cannot safely execute
remains registered with an explicit unavailable reason, so click, context menu,
command menu, keyboard, and bulk entrances do not invent a weaker permission path.

The contract also reserves `focus` and `triage` surface identifiers. They are not
aliases for the existing Home and notification Inbox pages:

- Focus depends on the canonical attention-signal queue tracked by
  [#194](https://github.com/mnmn0/mukuroji/issues/194). Home's current summary queue
  does not provide Focus states, ranking reasons, freshness, or notification
  deduplication.
- Triage depends on the canonical intake-entry state machine tracked by
  [#191](https://github.com/mnmn0/mukuroji/issues/191). A pre-conversion intake entry
  is not a Work Item and must not be represented by a fabricated Work Item target.

The contracts reserve these surface identifiers, and the key-only selection reducer can
be reused without inventing a domain target. Focus can adopt the Work Item action context
only when its canonical entries resolve to readable Work Items. Triage requires its own
entry action context after #191; it must not use `WorkItemActionSelection`. Triage saved
views remain rejected until that Issue defines the queue's Team or Workspace ownership.
Until then, no production route presents Home or Inbox as a completed Focus or Triage
surface.

## Persistence and retry behavior

Task-view rows use a namespace separate from legacy Workspace Search saved views.
Revision-checked mutations and their idempotency receipts are committed atomically.
Update and delete receipts are retained for 24 hours through the Workspace Search
table TTL so a retry after a lost response returns the committed result instead of
reapplying the mutation. Deleted views leave a tombstone that prevents a previous
idempotency key or orphaned preference from attaching to a new lifecycle.

Personal and Team default markers include a generation value. Definition scope or
visibility changes remove obsolete markers in the same transaction, and lazy cleanup
conditions include the observed generation so a stale reader cannot delete a newer
default.

## Authorization boundary

The server derives readable and writable Workspace, Team, and Team-qualified Project
scopes from the authenticated principal. List responses return capabilities for the
exact requested surface and scope; the Web treats them as authoritative rather than
reconstructing Enterprise or Team permissions from a legacy role.

Definitions are sanitized on every create, read, update, duplicate, and replay path.
Relation filters are checked against current target authority with bounded,
request-local caching. Unknown relation forms are rejected; only canonical Team-local,
qualified Work Item, Team-qualified Project, and active Planning goal relations can be retained.
