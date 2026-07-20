import { describe, expect, test } from 'bun:test'
import {
  processAuditProjectionBatch,
} from './audit-projection'
import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../../../../infrastructure/aws/dynamodb-stream'

describe('combined audit projection handler', () => {
  test('runs every projection and returns each failed stream record once', async () => {
    const event: DynamoStreamEvent = {
      Records: [
        {
          eventID: 'event-1',
          eventName: 'INSERT',
          dynamodb: { SequenceNumber: 'sequence-1' },
        },
        {
          eventID: 'event-2',
          eventName: 'INSERT',
          dynamodb: { SequenceNumber: 'sequence-2' },
        },
      ],
    }
    const receivedEvents: DynamoStreamEvent[] = []
    const processor = (
      failures: string[],
    ) => async (received: DynamoStreamEvent): Promise<BatchResponse> => {
      receivedEvents.push(received)
      return {
        batchItemFailures: failures.map((itemIdentifier) => ({
          itemIdentifier,
        })),
      }
    }

    await expect(processAuditProjectionBatch(event, [
      processor(['sequence-1']),
      processor([]),
      processor(['sequence-1', 'sequence-2']),
    ])).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: 'sequence-1' },
        { itemIdentifier: 'sequence-2' },
      ],
    })
    expect(receivedEvents).toEqual([event, event, event])
  })
})
