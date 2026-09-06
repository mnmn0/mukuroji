import { expect, test } from 'bun:test'
import { SQSClient } from '@aws-sdk/client-sqs'
import { deliverStreamBatch, pollQueue, requireLocalOrigin } from './transport'

test('local workers reject remote, credentialed, and ambiguous AWS origins', () => {
  for (const value of ['https://localhost:4566', 'http://example.com', 'http://localhost.evil.test',
    'http://user:password@localhost:4566', 'http://localhost:4566/path', 'http://localhost:4566?target=remote']) {
    expect(() => requireLocalOrigin(value)).toThrow()
  }
  expect(requireLocalOrigin('http://127.0.0.1:4567/')).toBe('http://127.0.0.1:4567')
})

test('stream fan-out retains the batch after a partial failure and replays it before checkpointing', async () => {
  let checkpoint = '10'
  let calls = 0
  const event = { Records: [{ dynamodb: { SequenceNumber: '11' } }, { dynamodb: { SequenceNumber: '12' } }] }
  const first = async () => { calls += 1; return { batchItemFailures: [] } }
  await expect(deliverStreamBatch(event, [first, async () => ({ batchItemFailures: [{ itemIdentifier: '11' }] })])
    .then((value) => { checkpoint = value ?? checkpoint })).rejects.toThrow()
  expect(checkpoint).toBe('10')
  checkpoint = await deliverStreamBatch(event, [first, async () => ({ batchItemFailures: [] })]) ?? checkpoint
  expect(checkpoint).toBe('12')
  expect(calls).toBe(2)
})

for (const outcome of ['success', 'partial-failure', 'throw']) {
  test(`SQS ${outcome} acknowledges only successful processing`, async () => {
    const operations: string[] = []
    let handled = false
    const client = new SQSClient({
      region: 'us-east-1', endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: {
        /** Returns a synthetic AWS JSON response without opening a socket. */
        async handle(request: { /** AWS JSON protocol headers. */ headers: Record<string, string> }) {
          const operation = request.headers['x-amz-target'] ?? ''
          operations.push(operation)
          return { response: {
            statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.0' },
            body: new TextEncoder().encode(JSON.stringify(operation.endsWith('ReceiveMessage')
              ? { Messages: [{ MessageId: 'message-1', ReceiptHandle: 'receipt-1', Body: '{}', MD5OfBody: '99914b932bd37a50b983c5e7c90ae93b', Attributes: { ApproximateReceiveCount: '2' } }] }
              : {})),
          } }
        },
      },
    })
    const pending = pollQueue(client, 'http://localhost:4566/000000000000/test', async (event) => {
      handled = true
      expect(event.Records?.[0]?.attributes?.ApproximateReceiveCount).toBe('2')
      if (outcome === 'throw') throw new Error('simulated failure')
      return { batchItemFailures: outcome === 'partial-failure' ? [{ itemIdentifier: 'message-1' }] : [] }
    })
    if (outcome === 'success') expect(await pending).toBe(1)
    else await expect(pending).rejects.toThrow()
    expect(handled).toBe(true)
    expect(operations.some((operation) => operation.endsWith('DeleteMessage'))).toBe(outcome === 'success')
    client.destroy()
  })
}
