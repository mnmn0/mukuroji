import { expect, test } from 'bun:test'
import { scheduledJobs } from './scheduled-jobs-handler'

test('keeps the cadence and retry policy each scheduled worker had as its own Lambda', () => {
  expect(scheduledJobs.map(({ name, everyMinutes, attempts }) => ({ name, everyMinutes, attempts })))
    .toEqual([
      { name: 'automation-schedule', everyMinutes: 1, attempts: 3 },
      { name: 'triage-schedule', everyMinutes: 1, attempts: 3 },
      { name: 'agent-run-triage', everyMinutes: 1, attempts: 3 },
      { name: 'slack-notifications', everyMinutes: 1, attempts: 1 },
      { name: 'analytics-schedule', everyMinutes: 5, attempts: 3 },
      { name: 'notification-schedule', everyMinutes: 60, attempts: 3 },
    ])
})

test('runs each job through its runtime-control guarded entrypoint', async () => {
  const source = (await Bun.file(`${import.meta.dir}/scheduled-jobs-handler.ts`).text())
    .replace(/\s+/gu, ' ')

  for (const entrypoint of [
    'agent-run-triage-handler',
    'analytics-schedule-handler',
    'automation-schedule-handler',
    'notification-schedule-handler',
    'slack-notifications-handler',
    'triage-schedule-handler',
  ]) {
    expect(source).toMatch(new RegExp(`import \\{ handler as \\w+ \\} from './${entrypoint}'`, 'u'))
  }
})
