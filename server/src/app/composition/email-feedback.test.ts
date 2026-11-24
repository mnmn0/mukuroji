import { describe, expect, test } from 'bun:test'
import { DeleteMessageBatchCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs'
import { createProductionEmailFeedbackHandler, createSqsEmailFeedbackQueue } from './email-feedback'

describe('SQS Email feedback queue', () => {
  test('receives bodies with their handles and deletes handled messages in one batch', async () => {
    const commands: Array<ReceiveMessageCommand | DeleteMessageBatchCommand> = []
    const queue = createSqsEmailFeedbackQueue({
      async send(command: ReceiveMessageCommand | DeleteMessageBatchCommand) {
        commands.push(command)
        if (command instanceof ReceiveMessageCommand) {
          return { Messages: [{ ReceiptHandle: 'h-1', Body: '{}' }, { ReceiptHandle: 'h-2' }, { Body: '{}' }] }
        }
        return { Failed: [] }
      },
    }, 'https://sqs.example.test/queue')
    const messages = await queue.receive(10)
    expect(messages).toEqual([{ handle: 'h-1', body: '{}' }])
    expect(commands[0]?.input).toMatchObject({ QueueUrl: 'https://sqs.example.test/queue', MaxNumberOfMessages: 10, WaitTimeSeconds: 0 })
    await queue.acknowledge(messages)
    expect(commands[1]?.input).toEqual({ QueueUrl: 'https://sqs.example.test/queue', Entries: [{ Id: '0', ReceiptHandle: 'h-1' }] })
  })
  test('reports a partial deletion so the run is retried', async () => {
    const queue = createSqsEmailFeedbackQueue({ send: async () => ({ Failed: [{ Id: '0' }] }) }, 'https://sqs.example.test/queue')
    await expect(queue.acknowledge([{ handle: 'h-1', body: '{}' }])).rejects.toThrow()
  })
  test('does nothing without a configured sender or feedback queue', async () => {
    const previous = { sender: process.env.NOTIFICATION_EMAIL_SENDER, queue: process.env.NOTIFICATION_EMAIL_FEEDBACK_QUEUE_URL }
    delete process.env.NOTIFICATION_EMAIL_SENDER
    process.env.NOTIFICATION_EMAIL_FEEDBACK_QUEUE_URL = 'https://sqs.example.test/queue'
    try {
      expect(await createProductionEmailFeedbackHandler()()).toBe(0)
    } finally {
      if (previous.sender === undefined) delete process.env.NOTIFICATION_EMAIL_SENDER
      else process.env.NOTIFICATION_EMAIL_SENDER = previous.sender
      if (previous.queue === undefined) delete process.env.NOTIFICATION_EMAIL_FEEDBACK_QUEUE_URL
      else process.env.NOTIFICATION_EMAIL_FEEDBACK_QUEUE_URL = previous.queue
    }
  })
})
