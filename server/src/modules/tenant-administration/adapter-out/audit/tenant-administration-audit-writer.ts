import {
  calculateAuditExpiresAt,
  createAuditEvent,
  createAuditFieldDiff,
  createAuditTransactPut,
  createMutationAuditContext,
} from '../../../audit'
import type { TenantAdministrationAuditWriter } from '../../application/ports/tenant-administration-port'
import { TenantAdministrationError } from '../../domain/tenant-administration'

/**
 * Creates the append-only audit transaction contributor used by tenant mutations.
 *
 * @param auditTableName - Immutable audit event table name.
 * @returns A writer that contributes one conditional audit Put per mutation.
 */
export function createDynamoDbTenantAdministrationAuditWriter(
  auditTableName: string,
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
        event.actorMemberKey.startsWith('executor:')
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
        entity: { type: 'tenant', id: event.entityId },
        action: event.action,
        changes: createAuditFieldDiff(event.before, event.after),
        ...(event.legalHold
          ? { retentionSuspended: true }
          : { expiresAt: calculateAuditExpiresAt(event.occurredAt, event.retentionDays) }),
        ...(event.metadata ? { metadata: event.metadata } : {}),
      })
      return createAuditTransactPut(normalizedTableName, auditEvent)
    },
  }
}
