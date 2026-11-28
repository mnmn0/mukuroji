import { expect, test } from 'bun:test'
import { scheduledJobs, selectDeployedScheduledJobs } from './scheduled-jobs-handler'

test('keeps the cadence and retry policy each scheduled worker had as its own Lambda', () => {
  expect(scheduledJobs.map(({ name, everyMinutes, attempts }) => ({ name, everyMinutes, attempts })))
    .toEqual([
      { name: 'automation-schedule', everyMinutes: 1, attempts: 3 },
      { name: 'triage-schedule', everyMinutes: 1, attempts: 3 },
      { name: 'agent-run-triage', everyMinutes: 1, attempts: 3 },
      { name: 'slack-notifications', everyMinutes: 1, attempts: 1 },
      { name: 'email-notifications', everyMinutes: 1, attempts: 1 },
      { name: 'push-notifications', everyMinutes: 1, attempts: 1 },
      { name: 'email-feedback', everyMinutes: 1, attempts: 1 },
      { name: 'analytics-schedule', everyMinutes: 5, attempts: 3 },
      { name: 'notification-schedule', everyMinutes: 60, attempts: 3 },
      { name: 'cycle-schedule', everyMinutes: 60, attempts: 3 },
      { name: 'member-access-expiry', everyMinutes: 60, attempts: 3 },
      { name: 'inbox-digest', everyMinutes: 15, attempts: 1 },
      { name: 'japanese-public-holiday-sync', everyMinutes: 360, attempts: 2 },
      { name: 'agent-analytics-export', everyMinutes: 1_440, attempts: 2 },
    ])
})

test('runs each job through its runtime-control guarded entrypoint', async () => {
  const source = (await Bun.file(`${import.meta.dir}/scheduled-jobs-handler.ts`).text())
    .replace(/\s+/gu, ' ')

  for (const entrypoint of [
    'agent-analytics-export-handler',
    'agent-run-triage-handler',
    'analytics-schedule-handler',
    'automation-schedule-handler',
    'cycle-schedule-handler',
    'email-feedback-handler',
    'email-notifications-handler',
    'inbox-digest-worker-handler',
    'japanese-public-holiday-sync-handler',
    'member-access-expiry-handler',
    'notification-schedule-handler',
    'push-notifications-handler',
    'slack-notifications-handler',
    'triage-schedule-handler',
  ]) {
    expect(source).toMatch(new RegExp(`import \\{ handler as \\w+ \\} from './${entrypoint}'`, 'u'))
  }
})

test('leaves the Agent Run triage and analytics export jobs out when Software factory is not deployed', () => {
  expect(selectDeployedScheduledJobs(scheduledJobs, true)).toBe(scheduledJobs)
  expect(selectDeployedScheduledJobs(scheduledJobs, false).map(({ name }) => name)).toEqual([
    'automation-schedule',
    'triage-schedule',
    'slack-notifications',
    'email-notifications',
    'push-notifications',
    'email-feedback',
    'analytics-schedule',
    'notification-schedule',
    'cycle-schedule',
    'member-access-expiry',
    'inbox-digest',
    'japanese-public-holiday-sync',
  ])
})
