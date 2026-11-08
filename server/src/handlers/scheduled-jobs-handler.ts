import {
  createScheduledJobsDispatcher,
  type ScheduledJob,
} from '../app/composition/scheduled-jobs'
import { handler as agentRunTriageHandler } from './agent-run-triage-handler'
import { handler as analyticsScheduleHandler } from './analytics-schedule-handler'
import { handler as automationScheduleHandler } from './automation-schedule-handler'
import { handler as notificationScheduleHandler } from './notification-schedule-handler'
import { handler as slackNotificationHandler } from './slack-notifications-handler'
import { handler as triageScheduleHandler } from './triage-schedule-handler'

/**
 * Periodic jobs that share one Lambda and one every-minute EventBridge rule.
 *
 * Each entry keeps its own runtime-control guard and the retry count its former Lambda
 * had. Slack delivery is tried once so a failure never sends a message twice.
 */
export const scheduledJobs: readonly ScheduledJob[] = Object.freeze([
  { name: 'automation-schedule', everyMinutes: 1, attempts: 3, run: automationScheduleHandler },
  { name: 'triage-schedule', everyMinutes: 1, attempts: 3, run: triageScheduleHandler },
  { name: 'agent-run-triage', everyMinutes: 1, attempts: 3, run: () => agentRunTriageHandler() },
  { name: 'slack-notifications', everyMinutes: 1, attempts: 1, run: () => slackNotificationHandler() },
  { name: 'analytics-schedule', everyMinutes: 5, attempts: 3, run: analyticsScheduleHandler },
  { name: 'notification-schedule', everyMinutes: 60, attempts: 3, run: notificationScheduleHandler },
])

/** Runs the jobs due at the scheduled minute of an EventBridge event. */
export const handler = createScheduledJobsDispatcher(scheduledJobs)
