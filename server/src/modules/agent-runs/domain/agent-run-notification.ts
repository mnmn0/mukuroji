import type {
  AgentRunNotificationReason,
  AgentRunOutcome,
  AgentRunReportKind,
  AgentSettings,
} from '@mukuroji/contracts'
import type { StoredAgentRun } from './agent-run'

/** Assignee notification an Agent Run event carries. */
export type AgentRunAssigneeNotification = {
  /** Why the assignee is notified. */
  reason: AgentRunNotificationReason
  /** Project the Work Item is assigned to, if any; it scopes mutes and delivery checks. */
  projectId?: string
}

/** Notification titles per reason. */
const agentRunNotificationTitles = {
  'agent-run-blocker': 'Agent reported a blocker',
  'agent-run-handoff': 'Agent handed off the work',
  'agent-run-failed': 'Agent Run failed',
  'agent-run-stalled': 'Agent Run stalled',
} as const satisfies Record<AgentRunNotificationReason, string>

/**
 * Builds the audit metadata that sends an Agent Run notification to the run's assignee. It holds
 * only IDs, the reason, and a fixed title: never the instance ID, its hash, or the report text.
 *
 * @param run - Run the event is about.
 * @param notification - Reason and Project of the notification.
 * @returns Metadata fields to merge into the event.
 */
export function createAgentRunNotificationMetadata(
  run: Pick<StoredAgentRun, 'assigneeUserId'>,
  notification: AgentRunAssigneeNotification,
): Record<string, unknown> {
  return {
    ...(notification.projectId ? { projectId: notification.projectId } : {}),
    notificationTitle: agentRunNotificationTitles[notification.reason],
    notificationCandidates: [{ memberKey: run.assigneeUserId, reason: notification.reason }],
  }
}

/**
 * Chooses the assignee notification of a report, when the Team turned notifications on.
 *
 * @param settings - Team agent settings.
 * @param kind - Report kind.
 * @param projectId - Project of the Work Item, if any.
 * @returns The notification, or undefined when the report notifies nobody.
 */
export function selectAgentRunReportNotification(
  settings: Pick<AgentSettings, 'notifyAssigneeOfRunEvents'>,
  kind: AgentRunReportKind,
  projectId: string | undefined,
): AgentRunAssigneeNotification | undefined {
  if (!settings.notifyAssigneeOfRunEvents) return undefined
  const reason = kind === 'blocker' ? 'agent-run-blocker' : kind === 'handoff' ? 'agent-run-handoff' : undefined
  return reason ? { reason, ...(projectId ? { projectId } : {}) } : undefined
}

/**
 * Chooses the assignee notification of a finish, when the Team turned notifications on.
 *
 * @param settings - Team agent settings.
 * @param outcome - Finish outcome.
 * @param projectId - Project of the Work Item, if any.
 * @returns The notification, or undefined when the finish notifies nobody.
 */
export function selectAgentRunFinishNotification(
  settings: Pick<AgentSettings, 'notifyAssigneeOfRunEvents'>,
  outcome: AgentRunOutcome,
  projectId: string | undefined,
): AgentRunAssigneeNotification | undefined {
  if (!settings.notifyAssigneeOfRunEvents || outcome !== 'failed') return undefined
  return { reason: 'agent-run-failed', ...(projectId ? { projectId } : {}) }
}
