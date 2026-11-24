import { expect, test } from 'bun:test'
import {
  InMemoryWorkCalendarStore,
  WorkCalendarAuthorizationChangedError,
  type WorkCalendarAuthorizationFence,
  type WorkCalendarWrite,
} from './work-calendars'

/** Team calendar save of every test. */
const write: WorkCalendarWrite = {
  scope: { kind: 'team', teamId: 'core-team' },
  overrides: { additionalHolidays: ['2026-12-09'] },
  changeAdjustment: 'keep-duration',
}

/** Fence on the saving member's authorization. */
const fence: WorkCalendarAuthorizationFence = {
  ConditionCheck: {
    TableName: 'access',
    Key: { recordKey: 'MEMBER#a' },
    ConditionExpression: 'version = :v',
    ExpressionAttributeValues: { ':v': 1 },
  },
}

test('refuses an in-memory save whose authorization fence no longer holds', async () => {
  const revoked = new InMemoryWorkCalendarStore(() => false)
  await expect(revoked.save('w', write, 0, 'user#a@example.com', '2026-11-23T00:00:00.000Z', [fence]))
    .rejects.toBeInstanceOf(WorkCalendarAuthorizationChangedError)
  expect(await revoked.get('w', write.scope)).toBeUndefined()

  const held = new InMemoryWorkCalendarStore((fences) => fences.length === 1)
  const saved = await held.save('w', write, 0, 'user#a@example.com', '2026-11-23T00:00:00.000Z', [fence])
  expect(saved).toMatchObject({ revision: 1 })
})
