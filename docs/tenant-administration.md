# Tenant administration and data governance

Tenant administration is a workspace-scoped control plane. Its durable records are kept in `TenantAdministrationTable` with `workspaceId` as the partition key and a fixed record key for each aggregate component:

- `PROFILE`: owner, region, locale, and default policy
- `ENTITLEMENT`: plan, features, seat limit, usage quota, and grace period
- `USAGE`: active seats and the current metering period
- `GOVERNANCE`: audit retention, legal hold, residency, and key ownership policy
- `OPERATION#<id>` plus `ACTIVE_OPERATION`: export and closure workflow state

Every state mutation uses an optimistic revision condition. The active-operation lock is created with the operation in one DynamoDB transaction, so a tenant cannot start two export or closure workflows concurrently. Tenant records never contain encryption keys, credentials, or export contents; those remain owned by their respective storage and secret adapters.

## Server-side enforcement

Entitlement, feature, quota, grace-period, retention, and legal-hold checks live in the tenant domain and are applied by the DynamoDB adapter. UI state is therefore advisory: changing the browser payload cannot bypass a failed server check. Usage reservations are persisted with a revision condition and emit a tenant audit event when the audit table is configured.

## Audit history

Profile, entitlement, governance, usage, and lifecycle transitions append an immutable event to the existing audit table in the same DynamoDB transaction as the tenant state mutation. Audit payloads are diffed through the shared redaction boundary and use the tenant's retention policy for TTL. While legal hold is active, new tenant audit events omit TTL so DynamoDB cannot expire them. Hold release requires the retention reconciliation job to restore TTL on held records before normal expiry resumes. Operation identifiers and evidence references are opaque; raw export data and secrets are never placed in the tenant table or audit metadata.

## Export and closure lifecycle

The administrator can request, pause, resume, and verify a workflow. Advancing a step is intentionally not an HTTP operation. The trusted executor must call the application port with a proof containing the exact current step and an immutable evidence reference. A step cannot become complete without matching proof, and closure verification requires every closure step to be durably complete. This prevents a UI user from claiming that data was exported, anonymized, or deleted without execution evidence.

The executor boundary is deliberately separate from the HTTP adapter so that object-store export, member anonymization, secret revocation, and tenant deletion can each be implemented with their own capability-scoped adapter and retry policy.
