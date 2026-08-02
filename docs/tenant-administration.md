# Tenant administration and data governance

Tenant administration is a workspace-scoped control plane. Its durable records are kept in `TenantAdministrationTable` with `workspaceId` as the partition key and a fixed record key for each aggregate component:

- `PROFILE`: owner, region, locale, default invitation role, and lifecycle status
- `ENTITLEMENT`: plan, features, seat limit, usage quota, and grace period
- `USAGE`: active seats and the current metering period
- `USAGE_RECEIPT#<digest>`: expiring request-metering idempotency receipts
- `BILLING#<period-start>`: invoice-ready metered units and active-seat high-water mark
- `GOVERNANCE`: audit retention, legal hold, residency, and key ownership policy
- `RETENTION_JOB`: resumable audit-TTL reconciliation progress
- `OPERATION#<id>` plus `ACTIVE_OPERATION`: canonical export and closure workflow state
- `OPERATION_HISTORY#<requested-at>#<id>`: newest-first operation history retained after the active lock is released

Every state mutation uses an optimistic revision condition. The active-operation lock is created with the operation in one DynamoDB transaction, so a tenant cannot start two export or closure workflows concurrently. Tenant records never contain encryption keys, credentials, or export contents; those remain owned by their respective storage and secret adapters.

The administration route resolves the active Workspace owner from membership on every snapshot request. Existing tenant profiles reconcile an owner transfer under profile and governance revision conditions and append an immutable audit event, rather than trusting a caller-supplied owner identifier.

When a Workspace invitation omits its role, the server initializes or reads the tenant aggregate from authoritative active membership and applies `PROFILE.defaultPolicy.defaultMemberRole`. External-collaborator and MFA controls remain owned by Enterprise Identity policy so the UI does not expose duplicate, inert tenant settings.

## Server-side entitlement and billing enforcement

Commercial entitlement changes are system-administrator-only and are read-only in the Workspace UI. Feature checks are applied after server-side Workspace resolution on Documents, Analytics, Automation, Developer Platform, SSO, and SCIM routes, including SSO discovery/start/exchange and the domain/provider/group-mapping administration paths. Opaque public Document shares are also resolved to their server-owned Workspace before the Documents entitlement is checked. Public API credentials and inbound Automation webhooks are checked after their tenant has been resolved, so omitting the browser UI does not bypass the policy. Inbound webhooks reach metering only after content-type, body, signature, and payload validation.

Mutating feature requests reserve usage under entitlement and usage revision conditions before entering the feature handler. When an `Idempotency-Key` is supplied, the server scopes it to the concrete method, route, query, conditional header, and payload digest before the same transaction stores a SHA-256-keyed receipt without the raw key; matching retries return the committed usage instead of charging twice, while reuse for another request cannot suppress metering. Request bodies are hashed incrementally with a 10 MiB bound instead of being cloned into unbounded memory. Public API requests are metered only after credential rate-limit admission. Receipts expire logically and through DynamoDB TTL after 35 days. Entitlement updates condition-check current usage, while usage and seat activations condition-check current entitlement, closing concurrent limit-change races in both directions.

Active-seat changes are prepared by the tenant adapter and committed in the same DynamoDB transaction as invitation acceptance, administrator activation/deactivation, and SCIM provisioning/deprovisioning. A concurrent seat-limit change or membership write therefore fails closed instead of drifting the usage counter. Every usage or seat mutation also updates the tenant's UTC billing-period record. The management snapshot returns the newest 13 invoice aggregates with metered units and the highest concurrent seat count; older records remain tenant-partitioned in the table.

Lazy initialization reads authoritative active Workspace membership. If a legacy tenant already has more than the starter plan's five-seat default, its initial seat limit is raised to that existing count so initialization never creates an already-over-limit aggregate; further seat activation remains blocked until the system control plane assigns additional capacity. A release from a zero seat counter is treated as corrupt state and fails closed instead of hiding membership drift.

Quota and grace-period checks live in the tenant domain. A new grace deadline is created only by the server. Seat release remains available after grace expiry, while feature mutations are rejected once the server-created grace period has ended.

## Residency and encryption

Tenant residency and encryption settings describe controls that the deployed data plane can actually enforce. Production composition binds residency to the configured AWS region and binds encryption to the AWS-managed keys used by the deployed stores. Mismatched regions and unsupported customer-managed-key requests fail before persistence; the UI displays these fields as read-only enforcement state.

## Audit history

Profile, entitlement, governance, usage, billing, seat, retention, and lifecycle transitions append an immutable event to the existing audit table in the same DynamoDB transaction as the tenant state mutation. Audit payloads are diffed through the shared redaction boundary and use the tenant's retention policy for TTL. While legal hold is active, new tenant audit events omit TTL so DynamoDB cannot expire them.

Initial tenant setup and every later retention or legal-hold change create `RETENTION_JOB` with the aggregate transaction. The tenant-operation Lambda processes at most 22 historical audit rows per invocation, removes TTL under legal hold, restores the policy-derived TTL after release, and persists a cursor, processed count, and immutable progress/completion audit event. The same worker consumes new audit-event inserts and applies the current tenant policy under a governance-revision condition, so concurrent policy changes fail and retry instead of leaving a stale TTL. DynamoDB Streams continue each page; retry exhaustion goes to a retained DLQ with an alarm. A second governance change is rejected while reconciliation is active.

Operation identifiers and evidence references are opaque; raw export data, member identifiers from an export artifact, raw idempotency keys, and secrets are never placed in the tenant table or audit metadata.

Every requested, running, paused, failed, completed, and verified operation revision is written to canonical state and operation history in the same transaction. A capability can report only a bounded uppercase failure code for its current step; raw exceptions are neither persisted nor logged. The management snapshot returns the ten newest operations so progress, evidence digests, and terminal failures remain visible after completion.

Seat audit events use the same Workspace-scoped HMAC member pseudonym contract as Workspace access history. Raw member keys are not stored as audit entity IDs or metadata, and owner/requester fields are redacted from immutable state diffs at write time.

## Export and closure lifecycle

The administrator can request, pause, resume, and verify a workflow. Export and closure requests derive their operation identifier from the tenant, administrator, operation kind, and hashed `Idempotency-Key`, so a response-loss retry returns the original operation without creating another workflow. A DynamoDB Stream invokes the stream-only tenant-operation Lambda to start newly requested workflows and reconcile retention; direct invocation of that handler is rejected.

Advancing or failing a step is intentionally not an HTTP operation. CDK publishes six IAM-addressable proof-ingress functions for export, access revocation, member anonymization, data deletion, secret deletion, and closure verification. Each function binds an immutable executor identity and disjoint allowed-step set in its environment, rejects stream-shaped invocations, accepts exactly one proof or safe failure code, and has only tenant-state and audit-table access. A resource-owning executor must be granted permission to invoke only its matching function ARN. The proof must name the exact current step and a content-addressed `evidence:sha256:<digest>` reference. Matching proof retries return the already-committed step; a mutable object location, stale step, out-of-order proof, caller-supplied executor identity, or browser-supplied proof cannot complete a step.

Export uses `snapshot`, `prepare-artifact`, and `verify-artifact`. Closure requires `export`, `revoke-access`, `anonymize-members`, `delete-data`, `delete-secrets`, and `verify`. The anonymization capability is responsible for replacing deleted-user identity data while preserving domain-owned business history. Data and secret deletion are separate steps so their capability owners and evidence cannot be conflated. Closure verification is accepted only after every step is durably complete.

Requesting closure atomically changes the profile from `active` to `closing`, creates the operation and history row, and acquires the single-operation lock. Normal authenticated APIs then reject access while `/api/tenant/*` remains available to inspect evidence and pause, resume, or verify the workflow. A terminal capability failure releases the lock and reopens the profile to `active`; a completed workflow keeps the lock until an administrator verifies it. Verification atomically writes `closedAt` and `closedByOperationId`, changes the profile to `closed`, and releases the lock. The closed state continues to block normal APIs. Pause leaves the current step and evidence history intact; resume continues that exact step. A legal hold activated after closure was requested blocks start, resume, step completion, and terminal verification, with a governance-revision condition in the same transition transaction to close concurrent policy changes.

The executor boundary remains separate from the HTTP adapter so object-store export, member anonymization, data deletion, and secret revocation can run with disjoint IAM capabilities and retry policies. The control plane records progress and evidence; it never grants one generic worker unrestricted access to every tenant store.

## Support and emergency access

Tenant administration does not expose a support impersonation endpoint. Emergency support uses the existing Enterprise break-glass flow: a `security.manage` principal pre-registers an MFA-ready recovery member (the approval), the registered member activates only their own short-lived session with a reason and recent MFA, and activation, use, revocation, and deactivation carry the normal immutable mutation audit context. This preserves an attributable principal instead of replacing the tenant user's identity.
