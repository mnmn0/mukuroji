import { afterEach, expect, test } from 'bun:test'
import { handler } from './inbox-digest-worker-handler'

/** Environment names this test overrides. */
const OVERRIDDEN_NAMES = ['INBOX_DIGEST_WORKER_ENABLED', 'DYNAMODB_ENDPOINT'] as const
/** Original values restored after each test. */
const originalValues = new Map(OVERRIDDEN_NAMES.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const [name, value] of originalValues) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('stays disabled without validating unrelated server settings', async () => {
  delete process.env.INBOX_DIGEST_WORKER_ENABLED
  process.env.DYNAMODB_ENDPOINT = 'https://dynamodb.example.com'

  expect(await handler()).toEqual({ processed: 0, delivered: 0, failed: 0, disabled: true })
})
