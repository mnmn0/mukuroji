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
    `## ${t('agents.handoff.brief.checklist')}`,
    ...checklist.map((key) => `- [ ] ${t(key)}`),
    '',
    `## ${t('agents.handoff.brief.workflow')}`,
    ...workflow.map((key, index) => `${index + 1}. ${t(key)}`),
    '',
    t('agents.handoff.brief.contextOnly'),
  ].join('\n')
}
