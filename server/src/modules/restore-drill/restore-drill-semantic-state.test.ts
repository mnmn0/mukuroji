import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import { describe, expect, test } from 'bun:test'
import {
  AwsRestoreDrillStateStore,
} from './restore-drill-orchestrator'
import {
  createRestoreDrillSemanticAuditCandidateClaims,
  createRestoreDrillSemanticItemClaims,
  type RestoreDrillSemanticClaim,
} from './restore-drill-semantic-claims'

const DIGEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => 32 - index)
const DRILL_ID = '20260801T000000000Z-123e4567-e89b-42d3-a456-426614174000'

/** Installs a deterministic in-memory document client on one production state adapter. */
function installSemanticDocument(
  state: AwsRestoreDrillStateStore,
  loseCollisionResponse = false,
  loseAuditResponse = false,
): { readonly collisionTransactions: () => number } {
  const records = new Map<string, Record<string, unknown>>()
  let collisionTransactionCount = 0
  let auditResponseLost = false
  Object.defineProperty(state, 'document', {
    value: {
      async send(command: unknown) {
        if (command instanceof GetCommand) {
          const recordKey = command.input.Key?.recordKey
          return typeof recordKey === 'string' && records.has(recordKey)
            ? { Item: records.get(recordKey) }
            : {}
        }
        if (command instanceof PutCommand) {
          const item = command.input.Item
          const recordKey = item?.recordKey
          if (!item || typeof recordKey !== 'string') throw new Error('invalid fake Put')
          const existing = records.get(recordKey)
          if (
            command.input.ConditionExpression?.includes('attribute_not_exists') &&
            existing !== undefined
          ) throw conditionalConflict()
          const expectedJson = command.input.ExpressionAttributeValues?.[':expectedJson']
          if (
            command.input.ConditionExpression?.includes('#payloadJson') &&
            existing?.payloadJson !== expectedJson
          ) throw conditionalConflict()
          records.set(recordKey, { ...item })
          if (
            loseAuditResponse &&
            !auditResponseLost &&
            recordKey.startsWith('VERIFY_SEMANTIC_AUDIT_LATEST#')
          ) {
            auditResponseLost = true
            throw new Error('audit response lost')
          }
          return {}
        }
        if (command instanceof TransactWriteCommand) {
          collisionTransactionCount += 1
          const condition = command.input.TransactItems?.[0]?.ConditionCheck
          const put = command.input.TransactItems?.[1]?.Put
          const ownerKey = condition?.Key?.recordKey
          const failureKey = put?.Item?.recordKey
          const expectedOwnerJson = condition?.ExpressionAttributeValues?.[':ownerJson']
          if (
            typeof ownerKey !== 'string' ||
            typeof failureKey !== 'string' ||
            !put?.Item ||
            records.get(ownerKey)?.payloadJson !== expectedOwnerJson
          ) throw conditionalConflict()
          records.set(failureKey, { ...put.Item })
          if (loseCollisionResponse) throw new Error('response lost')
          return {}
        }
        if (command instanceof QueryCommand) {
          const prefix = command.input.ExpressionAttributeValues?.[':recordPrefix']
          if (typeof prefix !== 'string') throw new Error('invalid fake Query')
          const items = [...records.entries()]
            .filter(([recordKey]) => recordKey.startsWith(prefix))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, item]) => item)
          return command.input.Select === 'COUNT'
            ? { Count: Math.min(items.length, command.input.Limit ?? items.length) }
            : { Items: items.slice(0, command.input.Limit) }
        }
        throw new Error('unexpected fake semantic command')
      },
    },
  })
  return { collisionTransactions: () => collisionTransactionCount }
}

/** Creates a conditional-check-shaped fake AWS error. */
function conditionalConflict(): Error {
  const error = new Error('conditional conflict')
  error.name = 'ConditionalCheckFailedException'
  return error
}

/** Creates one lifecycle candidate for the same logical Audit resource. */
function auditCandidate(
  eventOrder: string,
  historical: boolean,
  originToken: string,
): RestoreDrillSemanticClaim {
  const claims = createRestoreDrillSemanticAuditCandidateClaims({
    kind: 'audit-reference',
    referencedWorkspaceId: 'workspace-1',
    resourceId: 'team-1',
    resourceType: 'team',
    teamId: null,
    workspaceId: 'workspace-1',
  }, historical, eventOrder, 'workspace-1/team/team-1', DIGEST_KEY, originToken, originToken)
  const candidate = claims.find((claim) => claim.kind === 'audit-candidate')
  if (!candidate) throw new Error('Audit candidate missing')
  return candidate
}

describe('restore drill durable semantic state', () => {
  test('selects a final historical Audit event independent of page order and replay', async () => {
    const oldCurrent = auditCandidate(
      '2026-08-01T00:00:00.000Z#event-old',
      false,
      'a'.repeat(64),
    )
    const finalDelete = auditCandidate(
      '2026-08-01T00:01:00.000Z#event-delete',
      true,
      'b'.repeat(64),
    )
    for (const pages of [[oldCurrent, finalDelete], [finalDelete, oldCurrent]]) {
      const state = new AwsRestoreDrillStateStore('restore-drill-state', 'ap-northeast-1')
      installSemanticDocument(state)
      try {
        for (const claim of pages) {
          await state.writeVerificationSemanticClaims(DRILL_ID, [claim], DIGEST_KEY)
        }
        await state.writeVerificationSemanticClaims(DRILL_ID, [finalDelete], DIGEST_KEY)
        await expect(state.readVerificationSemanticRequirementPage(
          DRILL_ID,
          'audit',
          undefined,
          25,
        )).resolves.toEqual({ requirements: [] })
      } finally {
        state.close()
      }
    }
  })

  test('serializes same-resource Audit candidates and adopts a lost CAS response', async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => auditCandidate(
      `2026-08-01T00:${String(index).padStart(2, '0')}:00.000Z#event-${index}`,
      index === 11,
      index.toString(16).repeat(64),
    ))
    for (const claims of [candidates, [...candidates].reverse()]) {
      const state = new AwsRestoreDrillStateStore('restore-drill-state', 'ap-northeast-1')
      installSemanticDocument(state, false, true)
      try {
        await expect(state.writeVerificationSemanticClaims(
          DRILL_ID,
          claims,
          DIGEST_KEY,
        )).resolves.toBeUndefined()
        await expect(state.writeVerificationSemanticClaims(
          DRILL_ID,
          claims,
          DIGEST_KEY,
        )).resolves.toBeUndefined()
        await expect(state.readVerificationSemanticRequirementPage(
          DRILL_ID,
          'audit',
          undefined,
          25,
        )).resolves.toEqual({ requirements: [] })
      } finally {
        state.close()
      }
    }
  })

  test('atomically records a unique-owner collision and adopts a lost response', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', 'ap-northeast-1')
    const fake = installSemanticDocument(state, true)
    const owner: RestoreDrillSemanticClaim = {
      duplicateFailureCode: 'DUPLICATE_RECORD',
      kind: 'unique',
      originToken: 'c'.repeat(64),
      uniqueToken: 'd'.repeat(64),
    }
    const collision: RestoreDrillSemanticClaim = {
      ...owner,
      originToken: 'e'.repeat(64),
    }
    try {
      await state.writeVerificationSemanticClaims(DRILL_ID, [owner], DIGEST_KEY)
      await expect(state.writeVerificationSemanticClaims(
        DRILL_ID,
        [collision],
        DIGEST_KEY,
      )).resolves.toBeUndefined()
      expect(fake.collisionTransactions()).toBe(1)
      await expect(state.hasVerificationSemanticFailures(DRILL_ID)).resolves.toBe(true)
    } finally {
      state.close()
    }
  })

  test('stores and replays multiple File versions expanded from the same physical row', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', 'ap-northeast-1')
    installSemanticDocument(state)
    const claims: RestoreDrillSemanticClaim[] = []
    for (const version of ['version-1', 'version-2']) {
      claims.push(...createRestoreDrillSemanticItemClaims({
        contentType: 'text/plain',
        fileId: 'file-1',
        kind: 'file-metadata',
        objectKey: 'workspaces/workspace-1/files/file-1',
        objectVersionId: `object-${version}`,
        scanStatus: 'available',
        sizeBytes: 1,
        targetId: 'item-1',
        targetType: 'work-item',
        teamId: 'team-1',
        versionId: version,
        workspaceId: 'workspace-1',
      }, DIGEST_KEY, 'f'.repeat(64)))
      claims.push(...createRestoreDrillSemanticItemClaims({
        contentType: 'text/plain',
        fileId: 'file-1',
        kind: 'file-object',
        objectKey: 'workspaces/workspace-1/files/file-1',
        objectVersionId: `object-${version}`,
        scanStatus: 'available',
        sizeBytes: 1,
        versionId: version,
        workspaceId: 'workspace-1',
      }, DIGEST_KEY, 'f'.repeat(64)))
    }
    try {
      await expect(state.writeVerificationSemanticClaims(
        DRILL_ID,
        claims,
        DIGEST_KEY,
      )).resolves.toBeUndefined()
      await expect(state.writeVerificationSemanticClaims(
        DRILL_ID,
        claims,
        DIGEST_KEY,
      )).resolves.toBeUndefined()
      await expect(state.hasVerificationSemanticFailures(DRILL_ID)).resolves.toBe(false)
    } finally {
      state.close()
    }
  })
})
