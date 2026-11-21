import { randomInt } from 'node:crypto'
import { normalizeAuditEvent, type AuditEventV1 } from '../../../audit'
import type {
  BatchResponse,
  DynamoAttributeValue,
  DynamoStreamEvent,
} from '../../../../infrastructure/aws/dynamodb-stream'
import {
  ANALYTICS_HISTORY_OVERFLOW_RECHECK_SECONDS,
  createEmptyAnalyticsWorkItemHistoryRow,
  hasAnalyticsWorkItemHistoryGap,
  mergeAnalyticsWorkItemHistoryEntries,
  readAnalyticsWorkItemHistoryEvent,
  type AnalyticsWorkItemHistoryEntry,
  type AnalyticsWorkItemHistoryKey,
  type AnalyticsWorkItemHistoryRow,
  type AnalyticsWorkItemHistoryRowRead,
  type AnalyticsWorkItemHistoryStore,
} from '../../analytics-work-item-history'

/** Attempts of the read-merge-write cycle before the record is retried by Lambda. */
const HISTORY_WRITE_MAX_ATTEMPTS = 4

/** Exclusive upper bound of a new row's random starting version (the largest `randomInt` range). */
const ANALYTICS_HISTORY_ROW_GENERATION_RANGE = 2 ** 48

/** Audit timeline of one Work Item, read to rebuild its history row. */
export type AnalyticsWorkItemTimeline = {
  /** Audit events of the Work Item entity in occurrence order. */
  events: AuditEventV1[]
  /** False when the timeline was longer than the reader's page limit. */
  complete: boolean
}

/** Dependencies of the Analytics history projection. */
export type AnalyticsWorkItemHistoryProjectionDependencies = {
  /** History row store on the Analytics table. */
  store: AnalyticsWorkItemHistoryStore
  /** Reads the audit timeline of one Work Item entity. */
  readWorkItemTimeline(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ): Promise<AnalyticsWorkItemTimeline>
  /** Clock used to drop entries past their audit retention; defaults to the system clock. */
  now?: () => Date
}

/**
 * Keeps the per-Work-Item Analytics history rows in step with the AuditEvents stream.
 *
 * It runs inside the audit projection fan-out so the stream keeps two readers (ADR 0008). INSERT
 * adds an event and MODIFY refreshes its retention expiry. A missing row or a revision gap is
 * rebuilt from the Work Item's audit timeline. A Work Item delete removes its row. Readers use a
 * row only when it covers the canonical revision, so a row that falls behind is never wrong,
 * only unused.
 *
 * A failed update deletes the Work Item's row instead of failing the batch, so this optimization
 * rarely holds back the other projections of the fan-out; the record is retried only when the
 * delete fails too.
 *
 * @param event - AuditEvents stream batch.
 * @param dependencies - History store, audit timeline reader, and clock.
 * @returns The failed stream checkpoint when a row could be neither updated nor deleted.
 */
export async function processAnalyticsWorkItemHistoryProjectionBatch(
  event: DynamoStreamEvent,
  dependencies: AnalyticsWorkItemHistoryProjectionDependencies,
): Promise<BatchResponse> {
  for (const record of event.Records ?? []) {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue
    const image = record.dynamodb?.NewImage
    if (!image) continue
    const auditEvent = readStreamAuditEvent(image)
    if (!auditEvent) continue
    const input = readAnalyticsWorkItemHistoryEvent(auditEvent)
    if (!input) continue
    const key = {
      workspaceId: auditEvent.workspaceId,
      teamId: input.teamId,
      workItemId: input.workItemId,
    }
    try {
      if (input.deleted) {
        await dependencies.store.deleteRow(key)
      } else {
        await upsertHistoryEntry(key, input.entry, record.eventName === 'INSERT', dependencies)
      }
    } catch (error) {
      console.error('Analytics history projection failed.', {
        correlationId: auditEvent.correlationId,
        code: readErrorText(error, 'code') ?? 'AnalyticsHistoryProjectionFailed',
        name: readErrorText(error, 'name') ?? 'Error',
      })
      // A failed update cannot be left in place: a retention change keeps the revision, so a row
      // with the old expiry would still look current. Deleting the row sends the Work Item to the
      // audit timeline until its next event rebuilds it. Only when that also fails is the record
      // retried, which re-runs the whole fan-out.
      try {
        await dependencies.store.deleteRow(key)
      } catch {
        const sequenceNumber = record.dynamodb?.SequenceNumber
        if (!sequenceNumber) throw error
        return { batchItemFailures: [{ itemIdentifier: sequenceNumber }] }
      }
    }
  }
  return { batchItemFailures: [] }
}

/**
 * Merges one entry into a Work Item's history row with optimistic concurrency.
 *
 * @param key - Row identity.
 * @param entry - Entry from the stream record.
 * @param inserted - Whether the stream record is the event's first write.
 * @param dependencies - History store and audit timeline reader.
 * @throws When the row keeps changing under concurrent writers.
 */
async function upsertHistoryEntry(
  key: AnalyticsWorkItemHistoryKey,
  entry: AnalyticsWorkItemHistoryEntry,
  inserted: boolean,
  dependencies: AnalyticsWorkItemHistoryProjectionDependencies,
) {
  for (let attempt = 0; attempt < HISTORY_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const current = await dependencies.store.getRow(key)
    const next = await buildNextRow(key, entry, inserted, current, dependencies)
    if (!next) return
    if (current.row && isSameHistoryContent(current.row, next)) return
    if (await dependencies.store.putRow(next, current)) return
  }
  throw Object.assign(new Error('Analytics history row kept changing during the update.'), {
    code: 'AnalyticsHistoryWriteConflict',
  })
}

/**
 * Builds the row to store after one entry.
 *
 * @param key - Row identity.
 * @param entry - Entry from the stream record.
 * @param inserted - Whether the stream record is the event's first write.
 * @param current - Row read for this attempt.
 * @param dependencies - Audit timeline reader and clock.
 * @returns The next row, or undefined when the timeline shows the Work Item was deleted.
 */
async function buildNextRow(
  key: AnalyticsWorkItemHistoryKey,
  entry: AnalyticsWorkItemHistoryEntry,
  inserted: boolean,
  current: AnalyticsWorkItemHistoryRowRead,
  dependencies: AnalyticsWorkItemHistoryProjectionDependencies,
): Promise<AnalyticsWorkItemHistoryRow | undefined> {
  const nowEpochSeconds = Math.floor((dependencies.now?.() ?? new Date()).getTime() / 1000)
  // An overflowed row past its expiry is measured again, as if TTL had already removed it.
  const currentRow = current.row?.overflow &&
      current.row.overflowExpiresAt !== undefined &&
      current.row.overflowExpiresAt <= nowEpochSeconds
    ? undefined
    : current.row
  // A new row starts its version at a random 48-bit value that acts as the row's generation
  // token, so a row deleted and written again does not repeat a version that a slower writer read
  // before the delete. Later writes add 1, which stays far below Number.MAX_SAFE_INTEGER.
  const base = currentRow ?? {
    ...createEmptyAnalyticsWorkItemHistoryRow(key),
    rowVersion: current.row?.rowVersion ??
      current.storedRowVersion ??
      randomInt(1, ANALYTICS_HISTORY_ROW_GENERATION_RANGE),
  }
  const startsHistory = inserted && entry.metadata?.afterRevision === 1
  const rebuild = currentRow
    ? hasAnalyticsWorkItemHistoryGap(currentRow, entry)
    : !startsHistory
  if (!rebuild) return mergeAnalyticsWorkItemHistoryEntries(base, [entry], nowEpochSeconds)

  const timeline = await dependencies.readWorkItemTimeline(
    key.workspaceId,
    key.teamId,
    key.workItemId,
  )
  if (!timeline.complete) {
    return {
      ...base,
      overflow: true,
      entries: [],
      rowVersion: base.rowVersion + 1,
      overflowExpiresAt: nowEpochSeconds + ANALYTICS_HISTORY_OVERFLOW_RECHECK_SECONDS,
    }
  }
  // The stored copies came from the stream and may already carry a retention MODIFY that the
  // eventually consistent index has not caught up with, so the timeline only adds missing events.
  // The triggering stream entry still replaces its own stored copy below.
  let storedEventIds = new Set(base.entries.map((stored) => stored.eventId))
  let row = base
  let entries: AnalyticsWorkItemHistoryEntry[] = []
  const entryAt = Date.parse(entry.occurredAt)
  for (const timelineEvent of timeline.events) {
    const timelineInput = readAnalyticsWorkItemHistoryEvent(timelineEvent)
    if (
      !timelineInput ||
      timelineInput.teamId !== key.teamId ||
      timelineInput.workItemId !== key.workItemId
    ) continue
    if (timelineInput.deleted) {
      // A delete after this event means the Work Item is gone. An earlier delete ended a
      // previous Work Item with the same ID, so its history is dropped and the rebuild goes on.
      if (!(Date.parse(timelineInput.entry.occurredAt) < entryAt)) return undefined
      row = { ...base, entries: [] }
      storedEventIds = new Set()
      entries = []
      continue
    }
    if (storedEventIds.has(timelineInput.entry.eventId)) continue
    entries.push(timelineInput.entry)
  }
  entries.push(entry)
  return mergeAnalyticsWorkItemHistoryEntries(row, entries, nowEpochSeconds)
}

/**
 * Returns whether two rows hold the same history, ignoring the concurrency counter.
 *
 * @param left - Stored row.
 * @param right - Candidate row.
 * @returns True when writing the candidate would not change the stored history.
 */
function isSameHistoryContent(
  left: AnalyticsWorkItemHistoryRow,
  right: AnalyticsWorkItemHistoryRow,
) {
  return JSON.stringify({ ...left, rowVersion: 0 }) === JSON.stringify({ ...right, rowVersion: 0 })
}

/**
 * Reads a schema v1 audit event from a stream image.
 *
 * Other shapes are skipped rather than failed: the history row is an optimization, and readers
 * fall back to the audit timeline for any Work Item it does not cover.
 *
 * @param image - DynamoDB stream NewImage.
 * @returns The normalized audit event, or undefined for another shape.
 */
function readStreamAuditEvent(image: Record<string, DynamoAttributeValue>) {
  if (image.schemaVersion?.N !== '1' || !image.eventId?.S || !image.directoryId?.S) {
    return undefined
  }
  try {
    return normalizeAuditEvent(unmarshalMap(image))
  } catch {
    return undefined
  }
}

/**
 * Converts a DynamoDB stream map into plain values.
 *
 * @param value - Stream attribute map.
 * @returns The plain object.
 */
function unmarshalMap(value: Record<string, DynamoAttributeValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, attribute]) => [key, unmarshalAttribute(attribute)]),
  )
}

/**
 * Converts one DynamoDB stream attribute into a plain value.
 *
 * @param value - Stream attribute.
 * @returns The plain value.
 */
function unmarshalAttribute(value: DynamoAttributeValue): unknown {
  if (value.S !== undefined) return value.S
  if (value.N !== undefined) return Number(value.N)
  if (value.BOOL !== undefined) return value.BOOL
  if (value.NULL) return null
  if (value.L) return value.L.map(unmarshalAttribute)
  if (value.M) return unmarshalMap(value.M)
  if (value.SS) return value.SS
  if (value.NS) return value.NS.map(Number)
  return undefined
}

/**
 * Reads a string property of a thrown value for logging.
 *
 * @param error - Thrown value.
 * @param property - Property name.
 * @returns The property when it is a string.
 */
function readErrorText(error: unknown, property: 'code' | 'name') {
  if (typeof error !== 'object' || error === null || !(property in error)) return undefined
  const value: unknown = Reflect.get(error, property)
  return typeof value === 'string' ? value : undefined
}
