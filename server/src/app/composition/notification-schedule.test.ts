import { expect, spyOn, test } from 'bun:test'
import { createRetentionAwareNotificationScheduleHandler } from './notification-schedule'

test('delivers notifications even when the Customer retention sweep fails', async () => {
  const notificationEvents: unknown[] = []
  const retentionError = new Error('retention unavailable')
  const consoleError = spyOn(console, 'error').mockImplementation(() => undefined)
  const handler = createRetentionAwareNotificationScheduleHandler(
    {
      sweepExpiredRetention: async () => {
        throw retentionError
      },
    },
    async (event) => {
      notificationEvents.push(event)
      return {
        scannedItems: 0,
        emittedEvents: 0,
        duplicateEvents: 0,
        skippedItems: 0,
        scannedPages: 0,
      }
    },
  )

  try {
    await expect(handler({ id: 'schedule-1' })).rejects.toBe(retentionError)
    expect(notificationEvents).toEqual([{ id: 'schedule-1' }])
    expect(consoleError).toHaveBeenCalled()
  } finally {
    consoleError.mockRestore()
  }
})
