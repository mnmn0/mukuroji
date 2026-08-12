import { describe, expect, test } from 'bun:test'
import {
  AUDIT_REDACTED_VALUE,
  createWorkspaceMemberAuditEntityId,
} from '../../../audit'
import type { TenantAdministrationAuditEvent } from '../../application/ports/tenant-administration-port'
import { TenantAdministrationError } from '../../domain/tenant-administration'
import { createDynamoDbTenantAdministrationAuditWriter } from './tenant-administration-audit-writer'

const auditPseudonymKey = 'ab'.repeat(32)

describe('tenant administration audit writer', () => {
  test('pseudonymizes seat members and redacts member identifiers from state diffs', () => {
    const writer = createDynamoDbTenantAdministrationAuditWriter(
      'AuditEventsTable',
      auditPseudonymKey,
    )
    const transactionItem = writer.createTransactionItem(
      createTenantAuditEvent(),
    )
    const put = transactionItem && 'Put' in transactionItem
      ? transactionItem.Put
      : undefined
    if (!put || !isRecord(put.Item)) {
      throw new Error('Tenant audit Put was not created.')
    }

    expect(put.Item.entityId).toBe(createWorkspaceMemberAuditEntityId(
      'workspace-1',
      'member@example.com',
      auditPseudonymKey,
    ))
    expect(put.Item.entityType).toBe('member')
    expect(put.Item.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        after: AUDIT_REDACTED_VALUE,
        before: AUDIT_REDACTED_VALUE,
        field: 'ownerMemberKey',
        redacted: true,
      }),
      expect.objectContaining({
        after: AUDIT_REDACTED_VALUE,
        before: AUDIT_REDACTED_VALUE,
        field: 'requestedBy',
        redacted: true,
      }),
      expect.objectContaining({
        after: AUDIT_REDACTED_VALUE,
        before: AUDIT_REDACTED_VALUE,
        field: 'updatedBy',
        redacted: true,
      }),
    ]))
    const serialized = JSON.stringify(put.Item)
    expect(serialized).not.toContain('member@example.com')
    expect(serialized).not.toContain('previous-owner@example.com')
  })

  test('fails closed when a member pseudonym key is unavailable', () => {
    const writer = createDynamoDbTenantAdministrationAuditWriter(
      'AuditEventsTable',
    )

    expect(() => writer.createTransactionItem(
      createTenantAuditEvent(),
    )).toThrow(TenantAdministrationError)
    expect(() => writer.createTransactionItem(
      createTenantAuditEvent(),
    )).toThrow('Tenant audit pseudonym key is required.')
  })
})

/** Creates one seat audit event containing private identifiers at the adapter boundary. */
function createTenantAuditEvent(): TenantAdministrationAuditEvent {
  return {
    workspaceId: 'workspace-1',
    actorMemberKey: 'meter:seat',
    eventType: 'tenant.seat.assigned',
    entityId: 'workspace-1',
    privateMemberKey: 'member@example.com',
    action: 'assigned',
    path: '/internal/tenant/seats',
    requestMethod: 'INTERNAL',
    idempotencyKey: 'tenant-seat:opaque',
    before: {
      ownerMemberKey: 'previous-owner@example.com',
      requestedBy: 'previous-owner@example.com',
      updatedBy: 'previous-owner@example.com',
    },
    after: {
      ownerMemberKey: 'member@example.com',
      requestedBy: 'member@example.com',
      updatedBy: 'member@example.com',
    },
    metadata: { direction: 'activate' },
    retentionDays: 365,
    legalHold: false,
    occurredAt: '2026-08-02T00:00:00.000Z',
  }
}

/** Returns true when an unknown value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
