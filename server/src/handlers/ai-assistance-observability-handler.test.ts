import { expect, test } from 'bun:test'
import { handler } from './ai-assistance-observability-handler'

test('returns the DynamoDB partial batch response shape for an empty batch', async () => {
  await expect(handler({ Records: [] })).resolves.toEqual({
    batchItemFailures: [],
  })
})
