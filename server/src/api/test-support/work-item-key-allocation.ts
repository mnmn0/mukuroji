import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { deriveWorkItemKeyPrefix } from '../../modules/work-items/domain/work-item-key'

/** Partition key suffix of the Work Item key registry, mirrored from the adapter. */
const REGISTRY_PARTITION_SUFFIX = '#work-item-key-registry'

/** Sort key prefix of a Team counter row, mirrored from the adapter. */
const COUNTER_RECORD_PREFIX = 'team#'

/**
 * Wraps a fake DynamoDB document client so it answers Work Item key counter updates the way
 * DynamoDB would, numbering each Team's keys from 1 with the Team's derived prefix.
 *
 * Every other command reaches the wrapped fake unchanged, so tests that do not care about keys
 * can keep their own fake responses.
 *
 * @param client - Fake document client used by a test.
 * @returns The same client with key counter updates answered.
 */
export function withWorkItemKeyCounter(client: DynamoDBDocumentClient): DynamoDBDocumentClient {
  const counters = new Map<string, number>()
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'send') return Reflect.get(target, property, receiver)
      return async (command: unknown, ...rest: unknown[]) => {
        const counterRow = readCounterKey(command)
        if (!counterRow) return await Reflect.apply(target.send, target, [command, ...rest])
        const counterId = `${counterRow.directoryTeamId}\0${counterRow.issueId}`
        const lastNumber = (counters.get(counterId) ?? 0) + 1
        counters.set(counterId, lastNumber)
        return {
          Attributes: {
            ...counterRow,
            entryType: 'work-item-key-counter',
            directoryId: counterRow.directoryId,
            teamId: counterRow.teamId,
            keyPrefix: deriveWorkItemKeyPrefix(counterRow.teamId),
            lastNumber,
            registeredAt: '2026-01-01T00:00:00.000Z',
            lastAllocatedAt: '2026-01-01T00:00:00.000Z',
          },
        }
      }
    },
  })
}

/**
 * Reads the counter row a key allocation updates.
 *
 * @param command - Command sent to the fake client.
 * @returns The counter row identity, or `undefined` for any other command.
 */
function readCounterKey(command: unknown): {
  /** Registry partition key. */
  directoryTeamId: string
  /** Counter sort key. */
  issueId: string
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
} | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  if (Reflect.get(Reflect.get(command, 'constructor') ?? {}, 'name') !== 'UpdateCommand') {
    return undefined
  }
  const input: unknown = Reflect.get(command, 'input')
  const key: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, 'Key') : undefined
  if (typeof key !== 'object' || key === null) return undefined
  const directoryTeamId: unknown = Reflect.get(key, 'directoryTeamId')
  const issueId: unknown = Reflect.get(key, 'issueId')
  if (
    typeof directoryTeamId !== 'string' || !directoryTeamId.endsWith(REGISTRY_PARTITION_SUFFIX) ||
    typeof issueId !== 'string' || !issueId.startsWith(COUNTER_RECORD_PREFIX)
  ) {
    return undefined
  }
  return {
    directoryTeamId,
    issueId,
    directoryId: directoryTeamId.slice(0, -REGISTRY_PARTITION_SUFFIX.length),
    teamId: decodeURIComponent(issueId.slice(COUNTER_RECORD_PREFIX.length)),
  }
}
