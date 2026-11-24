import {
  createScheduledJobsDispatcher,
  type ScheduledJob,
} from '../app/composition/scheduled-jobs'
import { isSoftwareFactoryDeployed } from '../infrastructure/config/software-factory'
import { handler as agentRunTriageHandler } from './agent-run-triage-handler'
import { handler as analyticsScheduleHandler } from './analytics-schedule-handler'
import { handler as automationScheduleHandler } from './automation-schedule-handler'
import { handler as cycleScheduleHandler } from './cycle-schedule-handler'
import { handler as emailNotificationHandler } from './email-notifications-handler'
import { handler as inboxDigestWorkerHandler } from './inbox-digest-worker-handler'
import { handler as japanesePublicHolidaySyncHandler } from './japanese-public-holiday-sync-handler'
import { handler as memberAccessExpiryHandler } from './member-access-expiry-handler'
import { handler as notificationScheduleHandler } from './notification-schedule-handler'
import { handler as slackNotificationHandler } from './slack-notifications-handler'
import { handler as triageScheduleHandler } from './triage-schedule-handler'

/**
 * Periodic jobs that share one Lambda and one every-minute EventBridge rule.
 *
 * Each entry keeps its own runtime-control guard and the retry count its former Lambda
 * had. Slack and Email delivery are tried once so a failure never sends a message twice.
 */
export const scheduledJobs: readonly ScheduledJob[] = Object.freeze([
  { name: 'automation-schedule', everyMinutes: 1, attempts: 3, run: automationScheduleHandler },
  { name: 'triage-schedule', everyMinutes: 1, attempts: 3, run: triageScheduleHandler },
  { name: 'agent-run-triage', everyMinutes: 1, attempts: 3, run: () => agentRunTriageHandler() },
  { name: 'slack-notifications', everyMinutes: 1, attempts: 1, run: () => slackNotificationHandler() },
  { name: 'email-notifications', everyMinutes: 1, attempts: 1, run: () => emailNotificationHandler() },
  { name: 'analytics-schedule', everyMinutes: 5, attempts: 3, run: analyticsScheduleHandler },
  { name: 'notification-schedule', everyMinutes: 60, attempts: 3, run: notificationScheduleHandler },
  { name: 'cycle-schedule', everyMinutes: 60, attempts: 3, run: cycleScheduleHandler },
  // Sign-in is refused the moment an expiry passes; this run writes the deactivation (ADR 0095).
  { name: 'member-access-expiry', everyMinutes: 60, attempts: 3, run: () => memberAccessExpiryHandler() },
  // Daily and weekly digests fall due at UTC midnight; a quarter-hour run delivers them soon
  // after. The worker keeps failed recipients in its own checkpoints and retries them on the
  // next run, so one try avoids racing its own 90-second shard lease.
  { name: 'inbox-digest', everyMinutes: 15, attempts: 1, run: () => inboxDigestWorkerHandler() },
  // Runs every six hours but fetches only once a month; a failed fetch waits for the next run.
  {
    name: 'japanese-public-holiday-sync',
    everyMinutes: 360,
    attempts: 2,
    run: () => japanesePublicHolidaySyncHandler(),
  },
])

/** Jobs that belong to the Software factory module and stop when it is not deployed. */
const SOFTWARE_FACTORY_JOB_NAMES: ReadonlySet<string> = new Set(['agent-run-triage'])

/**
 * Lists the jobs this deployment runs.
 *
 * Without Software factory the stack grants the Agent Run triage job no table access, so the
 * job is left out instead of failing every minute.
 *
 * @param jobs - Every job the Lambda owns.
 * @param softwareFactoryDeployed - Whether the deployment includes Software factory.
 * @returns Jobs to dispatch, in their original order.
 */
export function selectDeployedScheduledJobs(
  jobs: readonly ScheduledJob[],
  softwareFactoryDeployed: boolean,
): readonly ScheduledJob[] {
  return softwareFactoryDeployed
    ? jobs
    : jobs.filter((job) => !SOFTWARE_FACTORY_JOB_NAMES.has(job.name))
}

/** Runs the jobs due at the scheduled minute of an EventBridge event. */
export const handler = createScheduledJobsDispatcher(
  selectDeployedScheduledJobs(scheduledJobs, isSoftwareFactoryDeployed()),
)
