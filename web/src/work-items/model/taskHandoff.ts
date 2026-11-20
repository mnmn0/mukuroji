import type { AgentRun, CanonicalWorkItem, WorkItemConfiguration } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createDocumentPath, createTeamIssuesPath } from '../../shared/routing/paths'
import { resolveWorkItemWorkflowStatusLabel } from './workItemDisplay'

/** Inputs for a brief containing only the currently visible saved Work Item. */
export type TaskHandoffInput = {
  /** Canonical snapshot already loaded by the selected task detail. */
  task: CanonicalWorkItem
  /** Loaded workflow configuration used to pair a human-readable label with the status ID. */
  configuration?: WorkItemConfiguration
  /** Whether the current detail layout exposes the saved description. */
  includeDescription: boolean
  /** Agent Run state read for this Work Item; omitted when the screen did not read it. */
  agentRuns?: TaskHandoffLoadState<TaskHandoffAgentRuns>
  /** Documents linked to this Work Item; omitted when the screen did not read them. */
  documents?: TaskHandoffLoadState<TaskHandoffDocuments>
  /** Localized labels and workflow guidance. */
  t: (key: MessageKey) => string
}

/**
 * Read state of supplementary context that the brief only includes once it has loaded.
 * `unavailable` covers both a failed read and a screen that cannot read it.
 */
export type TaskHandoffLoadState<Value> =
  | {
    /** The read is still pending. */
    status: 'loading' | 'unavailable'
  }
  | {
    /** The read finished. */
    status: 'loaded'
    /** Loaded value. */
    value: Value
  }

/** Active Agent Run fields the brief shows; heartbeat times stay out so the preview stays stable. */
export type TaskHandoffActiveRun = Pick<AgentRun, 'runId' | 'agentName' | 'runtime' | 'startedAt' | 'stalled'>

/** Agent Run state of the Work Item as the brief needs it. */
export type TaskHandoffAgentRuns = {
  /** Run that currently claims the Work Item, if any. */
  active?: TaskHandoffActiveRun
}

/** A Document linked to the Work Item that the viewer may read. */
export type TaskHandoffDocument = {
  /** Document ID. */
  documentId: string
  /** Document title at read time. */
  documentTitle: string
}

/** Linked Documents of the Work Item as the brief needs them. */
export type TaskHandoffDocuments = {
  /** First page of linked Documents the viewer may read. */
  items: readonly TaskHandoffDocument[]
  /** Whether more linked Documents exist beyond `items`. */
  hasMore: boolean
}

/** Reason an agent should not start the Work Item yet, as shown in the handoff brief. */
type TaskHandoffBlockReason = 'noAcceptanceCriteria' | 'closed' | 'started' | 'blockedBy' | 'activeRun' | 'stalledRun'

/**
 * Lists why an agent should not start the saved Work Item from this handoff alone.
 * Blocker targets stay out: only the number of recorded `blockedBy` relations is used.
 * @param task - Saved canonical snapshot.
 * @param activeRun - Run that currently claims the Work Item, when the runs were read.
 * @returns Reasons in display order; empty when the snapshot allows a start.
 */
function resolveTaskHandoffBlockReasons(task: CanonicalWorkItem, activeRun: TaskHandoffActiveRun | undefined): TaskHandoffBlockReason[] {
  const reasons: TaskHandoffBlockReason[] = []
  if ((task.acceptanceCriteria?.length ?? 0) === 0) reasons.push('noAcceptanceCriteria')
  if (task.statusCategory === 'completed' || task.statusCategory === 'canceled') reasons.push('closed')
  if (task.statusCategory === 'started') reasons.push('started')
  if (countBlockedByRelations(task) > 0) reasons.push('blockedBy')
  if (activeRun) reasons.push(activeRun.stalled ? 'stalledRun' : 'activeRun')
  return reasons
}

/**
 * Removes line breaks so a user-provided value stays on one brief line.
 * @param value - Value to show.
 * @returns Single-line text.
 */
function toSingleLine(value: string | number): string {
  return String(value).replace(/[\r\n]+/gu, ' ')
}

/**
 * Fills `{name}` placeholders of a localized message.
 * @param message - Localized message.
 * @param values - Placeholder values, written on one line each.
 * @returns Message with the placeholders replaced.
 */
function fillPlaceholders(message: string, values: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/gu, (placeholder, name: string) => {
    const value = values[name]
    return value === undefined ? placeholder : toSingleLine(value)
  })
}

/**
 * Describes the Agent Run state of the Work Item.
 * @param agentRuns - Read state of the runs; omitted when the screen did not read them.
 * @param t - Translator.
 * @returns Brief lines for the Agent Run section.
 */
function describeAgentRuns(agentRuns: TaskHandoffInput['agentRuns'], t: TaskHandoffInput['t']): string[] {
  if (agentRuns?.status !== 'loaded') {
    return [t(agentRuns?.status === 'loading' ? 'agents.handoff.brief.runLoading' : 'agents.handoff.brief.runUnavailable')]
  }
  const active = agentRuns.value.active
  if (!active) return [t('agents.handoff.brief.noActiveRun')]
  return [
    `${t('agents.handoff.brief.runState')}: ${t(active.stalled ? 'agents.handoff.brief.runStalled' : 'agents.handoff.brief.runRunning')}`,
    `${t('agents.handoff.brief.runId')}: ${toSingleLine(active.runId)}`,
    `${t('agents.handoff.brief.runAgent')}: ${toSingleLine(active.agentName)} (${toSingleLine(active.runtime)})`,
    `${t('agents.handoff.brief.runStartedAt')}: ${toSingleLine(active.startedAt)}`,
  ]
}

/**
 * Lists the linked Documents by title, ID, and application path, without their content.
 * @param documents - Read state of the linked Documents; omitted when the screen did not read them.
 * @param t - Translator.
 * @returns Brief lines for the related Documents section.
 */
function describeDocuments(documents: TaskHandoffInput['documents'], t: TaskHandoffInput['t']): string[] {
  if (documents?.status !== 'loaded') {
    return [t(documents?.status === 'loading' ? 'agents.handoff.brief.documentsLoading' : 'agents.handoff.brief.documentsUnavailable')]
  }
  const { items, hasMore } = documents.value
  if (items.length === 0) return [t('agents.handoff.brief.noDocuments')]
  return [
    ...items.map((document) => `- ${toSingleLine(document.documentTitle)} (${t('agents.handoff.brief.documentId')}: ${toSingleLine(document.documentId)}, ${t('agents.handoff.brief.documentPath')}: ${createDocumentPath(document.documentId)})`),
    ...(hasMore ? [t('agents.handoff.brief.moreDocuments')] : []),
    t('agents.handoff.brief.documentsContentOmitted'),
  ]
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
  activeRun: 'agents.handoff.brief.blocked.activeRun',
  stalledRun: 'agents.handoff.brief.blocked.stalledRun',
}

/**
 * Creates a copyable handoff without fetching hidden context or mutating task state.
 * @param input - Visible canonical snapshot, description visibility, and translator.
 * @returns A plain-text brief with canonical identity, a saved snapshot, and workflow guidance.
 */
export function createTaskHandoffBrief({ task, configuration, includeDescription, agentRuns, documents, t }: TaskHandoffInput): string {
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
  const activeRun = agentRuns?.status === 'loaded' ? agentRuns.value.active : undefined
  const blockReasons = resolveTaskHandoffBlockReasons(task, activeRun)
  const placeholderValues = {
    count: countBlockedByRelations(task),
    agentName: activeRun?.agentName ?? '',
    runId: activeRun?.runId ?? '',
  }
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
    ...fields.map(([label, value]) => `${t(label)}: ${toSingleLine(value)}`),
    '',
    `## ${t('agents.handoff.brief.description')}`,
    includeDescription
      ? task.description?.trim() || t('agents.handoff.brief.noDescription')
      : t('agents.handoff.brief.descriptionOmitted'),
    '',
    `## ${t('agents.handoff.brief.acceptanceCriteria')}`,
    ...(criteria.length > 0
      ? criteria.map((criterion) => `- [${criterion.satisfied ? 'x' : ' '}] ${toSingleLine(criterion.text)}`)
      : [t('agents.handoff.brief.noAcceptanceCriteria')]),
    '',
    `## ${t('agents.handoff.brief.readiness')}`,
    blockReasons.length === 0 ? t('agents.handoff.brief.ready') : t('agents.handoff.brief.notReady'),
    ...blockReasons.map((reason) => `- ${fillPlaceholders(t(blockReasonKeys[reason]), placeholderValues)}`),
    ...(agentRuns?.status === 'loaded' ? [] : [t('agents.handoff.brief.runUnchecked')]),
    '',
    `## ${t('agents.handoff.brief.agentRun')}`,
    ...describeAgentRuns(agentRuns, t),
    '',
    `## ${t('agents.handoff.brief.documents')}`,
    ...describeDocuments(documents, t),
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
