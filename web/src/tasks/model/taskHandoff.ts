import type { CanonicalWorkItem, WorkItemConfiguration } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createTeamIssuesPath } from '../../shared/routing/paths'
import { resolveWorkItemWorkflowStatusLabel } from '../../work-items/model/workItemDisplay'

/** Inputs for a brief containing only the currently visible saved Work Item. */
export type TaskHandoffInput = {
  /** Canonical snapshot already loaded by the selected task detail. */
  task: CanonicalWorkItem
  /** Loaded workflow configuration used to pair a human-readable label with the status ID. */
  configuration?: WorkItemConfiguration
  /** Whether the current detail layout exposes the saved description. */
  includeDescription: boolean
  /** Localized labels and workflow guidance. */
  t: (key: MessageKey) => string
}

/** Reason an agent should not start the Work Item yet, as shown in the handoff brief. */
export type TaskHandoffBlockReason = 'noAcceptanceCriteria' | 'closed' | 'started' | 'blockedBy'

/**
 * Lists why an agent should not start the saved Work Item from this handoff alone.
 * Blocker targets stay out: only the number of recorded `blockedBy` relations is used.
 * @param task - Saved canonical snapshot.
 * @returns Reasons in display order; empty when the snapshot allows a start.
 */
export function resolveTaskHandoffBlockReasons(task: CanonicalWorkItem): TaskHandoffBlockReason[] {
  const reasons: TaskHandoffBlockReason[] = []
  if ((task.acceptanceCriteria?.length ?? 0) === 0) reasons.push('noAcceptanceCriteria')
  if (task.statusCategory === 'completed' || task.statusCategory === 'canceled') reasons.push('closed')
  if (task.statusCategory === 'started') reasons.push('started')
  if (countBlockedByRelations(task) > 0) reasons.push('blockedBy')
  return reasons
}

/**
 * Counts recorded `blockedBy` relations without exposing their targets.
 * @param task - Saved canonical snapshot.
 * @returns Number of `blockedBy` relation IDs.
 */
function countBlockedByRelations(task: CanonicalWorkItem): number {
  return task.relationIds.filter((relationId) => relationId.startsWith('blockedBy:')).length
}

const blockReasonKeys: Record<TaskHandoffBlockReason, MessageKey> = {
  noAcceptanceCriteria: 'agents.handoff.brief.blocked.noAcceptanceCriteria',
  closed: 'agents.handoff.brief.blocked.closed',
  started: 'agents.handoff.brief.blocked.started',
  blockedBy: 'agents.handoff.brief.blocked.blockedBy',
}

/**
 * Creates a copyable handoff without fetching hidden context or mutating task state.
 * @param input - Visible canonical snapshot, description visibility, and translator.
 * @returns A plain-text brief with canonical identity, a saved snapshot, and workflow guidance.
 */
export function createTaskHandoffBrief({ task, configuration, includeDescription, t }: TaskHandoffInput): string {
  const fields: Array<[MessageKey, string | number]> = [
    ['agents.handoff.brief.task', task.title],
    ['agents.handoff.brief.taskId', task.id],
    ['agents.handoff.brief.teamId', task.teamId],
    ['agents.handoff.brief.projectId', task.assignedProjectId || t('agents.handoff.brief.unset')],
    ['agents.handoff.brief.assigneeId', task.assigneeUserId || t('agents.handoff.brief.unset')],
    ['agents.handoff.brief.assignee', task.assigneeName || task.assigneeUserId || t('agents.handoff.brief.unset')],
    ['agents.handoff.brief.revision', task.revision],
    ['agents.handoff.brief.statusLabel', resolveWorkItemWorkflowStatusLabel(task, configuration)],
    ['agents.handoff.brief.status', task.workflowStatusId],
    ['agents.handoff.brief.category', task.statusCategory],
    ['agents.handoff.brief.priority', task.priority],
    ['agents.handoff.brief.dueDate', task.dueDate || t('agents.handoff.brief.unset')],
    ['agents.handoff.brief.updatedAt', task.updatedAt],
    ['agents.handoff.brief.path', createTeamIssuesPath(task.teamId, task.id)],
  ]
  const criteria = task.acceptanceCriteria ?? []
  const blockReasons = resolveTaskHandoffBlockReasons(task)
  const blockerCount = countBlockedByRelations(task)
  const checklist: MessageKey[] = [
    'agents.handoff.brief.checkContext',
    'agents.handoff.brief.checkImplementation',
    'agents.handoff.brief.checkVerification',
    'agents.handoff.brief.checkReview',
  ]
  const workflow: MessageKey[] = [
    'agents.handoff.brief.read',
    'agents.handoff.brief.start',
    'agents.handoff.brief.progress',
    'agents.handoff.brief.finish',
    'agents.handoff.brief.retry',
  ]
  return [
    `# ${t('agents.handoff.brief.title')}`,
    '',
    t('agents.handoff.brief.scope'),
    '',
    ...fields.map(([label, value]) => `${t(label)}: ${String(value).replace(/[\r\n]+/gu, ' ')}`),
    '',
    `## ${t('agents.handoff.brief.description')}`,
    includeDescription
      ? task.description?.trim() || t('agents.handoff.brief.noDescription')
      : t('agents.handoff.brief.descriptionOmitted'),
    '',
    `## ${t('agents.handoff.brief.acceptanceCriteria')}`,
    ...(criteria.length > 0
      ? criteria.map((criterion) => `- [${criterion.satisfied ? 'x' : ' '}] ${criterion.text.replace(/[\r\n]+/gu, ' ')}`)
      : [t('agents.handoff.brief.noAcceptanceCriteria')]),
    '',
    `## ${t('agents.handoff.brief.readiness')}`,
    blockReasons.length === 0 ? t('agents.handoff.brief.ready') : t('agents.handoff.brief.notReady'),
    ...blockReasons.map((reason) => `- ${t(blockReasonKeys[reason]).replace('{count}', String(blockerCount))}`),
    '',
    `## ${t('agents.handoff.brief.checklist')}`,
    ...checklist.map((key) => `- [ ] ${t(key)}`),
    '',
    `## ${t('agents.handoff.brief.workflow')}`,
    ...workflow.map((key, index) => `${index + 1}. ${t(key)}`),
    '',
    t('agents.handoff.brief.contextOnly'),
  ].join('\n')
}
