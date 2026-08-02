import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createAuditFieldDiff,
  createAuditTransactPut,
  createMutationAuditContext,
  createWorkspaceMemberAuditEntityId,
} from '../../../audit'
import type { TenantAdministrationAuditWriter } from '../../application/ports/tenant-administration-port'
import { TenantAdministrationError } from '../../domain/tenant-administration'

/** Tenant state fields whose raw member identifiers must not enter immutable audit diffs. */
const TENANT_AUDIT_REDACT_FIELDS = [
  'memberKey',
  'ownerMemberKey',
  'requestedBy',
  'updatedBy',
] as const

/**
 * Creates the append-only audit transaction contributor used by tenant mutations.
 *
 * @param auditTableName - Immutable audit event table name.
 * @param auditPseudonymKey - Fixed HMAC key used for member audit identifiers.
 * @returns A writer that contributes one conditional audit Put per mutation.
 */
export function createDynamoDbTenantAdministrationAuditWriter(
  auditTableName: string,
  auditPseudonymKey?: string,
): TenantAdministrationAuditWriter {
  const normalizedTableName = auditTableName.trim()
  if (!normalizedTableName) {
    throw new TenantAdministrationError(
      503,
      'TenantAuditUnavailable',
      'Tenant audit persistence is unavailable.',
    )
  }
  return {
    createTransactionItem(event) {
      const actorKind = event.actorMemberKey.startsWith('meter:') ||
        event.actorMemberKey.startsWith('executor:') ||
        event.actorMemberKey.startsWith('system:')
        ? 'service'
        : 'user'
      const context = createMutationAuditContext({
        workspaceId: event.workspaceId,
        actor: { id: event.actorMemberKey, kind: actorKind },
        idempotencyKey: event.idempotencyKey,
        occurredAt: event.occurredAt,
        request: {
          method: event.requestMethod,
          path: event.path,
          ...(event.after ? { body: event.after } : {}),
        },
        source: {
          kind: event.requestMethod === 'INTERNAL' ? 'system' : 'api',
          route: event.path,
        },
      })
      const auditEvent = createAuditEvent({
        context,
        eventType: event.eventType,
        entity: event.privateMemberKey
          ? {
              type: 'member',
              id: createTenantMemberAuditEntityId(
                event.workspaceId,
                event.privateMemberKey,
                auditPseudonymKey,
              ),
            }
          : { type: 'tenant', id: event.entityId },
        action: event.action,
        changes: createAuditFieldDiff(event.before, event.after, {
          redactFields: TENANT_AUDIT_REDACT_FIELDS,
        }),
        ...(event.legalHold
          ? { retentionSuspended: true }
          : { expiresAt: calculateAuditExpiresAt(event.occurredAt, event.retentionDays) }),
        ...(event.metadata ? { metadata: event.metadata } : {}),
      })
      return createAuditTransactPut(normalizedTableName, auditEvent)
    },
  }
}

/**
 * Creates a PII-free member audit entity ID and fails closed on missing key material.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param memberKey - Private Workspace member key.
 * @param auditPseudonymKey - Fixed environment HMAC key.
 * @returns A scoped member pseudonym safe for immutable audit storage.
 */
function createTenantMemberAuditEntityId(
  workspaceId: string,
  memberKey: string,
  auditPseudonymKey?: string,
): string {
  if (!auditPseudonymKey) {
    throw new TenantAdministrationError(
      503,
      'TenantAuditPseudonymKeyMissing',
      'Tenant audit pseudonym key is required.',
    )
  }
  try {
    return createWorkspaceMemberAuditEntityId(
      workspaceId,
      memberKey,
      auditPseudonymKey,
    )
  } catch {
    throw new TenantAdministrationError(
      503,
      'TenantAuditPseudonymKeyInvalid',
      'Tenant audit pseudonym key is invalid.',
    )
  }
}
