import {
  hasWorkItemAcceptanceCriteria,
  type AgentSettings,
  type CanonicalWorkItem,
  type WorkflowStatusDefinition,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import { resolveAllowedWorkflowStatuses } from './workItemDisplay'

/** Agent settings fields that decide whether `get_next_task` may offer a Work Item. */
export type AgentReadySettings = Pick<AgentSettings, 'readyStatusIds' | 'requireAcceptanceCriteria' | 'acceptanceCriteriaFieldId'>

/** Why a Work Item cannot be offered to an agent, even after a status change. */
export type AgentReadyBlockReason =
  | 'closed'
  | 'started'
  | 'activeRun'
  | 'noAcceptanceCriteria'
  | 'noTransition'

/**
 * Outcome of checking whether one action can make a Work Item an agent candidate.
 * `blockedBy` relations are not decided here, because only the server can read blockers the viewer may not see.
 */
export type AgentReadyTransition =
  | {
    /** The Work Item is already in a status `get_next_task` offers. */
    kind: 'alreadyReady'
  }
  | {
    /** One status change makes the Work Item a candidate. */
    kind: 'canMove'
    /** Target status: the first Ready status the workflow allows from the current status. */
    status: WorkflowStatusDefinition
  }
  | {
    /** The Work Item cannot become a candidate with a status change alone. */
    kind: 'blocked'
    /** Reasons in display order. */
    reasons: AgentReadyBlockReason[]
  }

/** Inputs for {@link resolveAgentReadyTransition}. */
export type AgentReadyTransitionInput = {
  /** Saved Work Item snapshot. */
  task: Pick<CanonicalWorkItem, 'workflowStatusId' | 'statusCategory' | 'workItemTypeId' | 'acceptanceCriteria' | 'customFieldValues'>
  /** Team Agent settings. */
  settings: AgentReadySettings
  /** Work Item configuration that defines the workflow of the Work Item Type. */
  configuration: WorkItemConfiguration | undefined
  /** Whether an Agent Run currently claims the Work Item. */
  hasActiveRun: boolean
}

/** Status categories `get_next_task` offers for a new start; other categories are never offered. */
const candidateCategories = new Set<string>(['backlog', 'unstarted'])

/**
 * Decides whether the Work Item is an agent candidate, can become one with one status change, or why not.
 * Mirrors the `get_next_task` checks that do not need hidden data: status category, Ready statuses, and
 * required acceptance criteria. The workflow transitions decide which Ready status is reachable.
 * @param input - Saved Work Item, Team Agent settings, configuration, and Agent Run state.
 * @returns The transition outcome.
 */
export function resolveAgentReadyTransition({ task, settings, configuration, hasActiveRun }: AgentReadyTransitionInput): AgentReadyTransition {
  const reasons: AgentReadyBlockReason[] = []
  if (task.statusCategory === 'completed' || task.statusCategory === 'canceled') reasons.push('closed')
  else if (task.statusCategory === 'started') reasons.push('started')
  if (hasActiveRun) reasons.push('activeRun')
  if (settings.requireAcceptanceCriteria && !hasWorkItemAcceptanceCriteria(task, settings.acceptanceCriteriaFieldId)) {
    reasons.push('noAcceptanceCriteria')
  }
  const readyStatusIds = new Set(settings.readyStatusIds)
  const isReadyStatus = (statusId: string) => readyStatusIds.size === 0 || readyStatusIds.has(statusId)
  const inCandidateStatus = candidateCategories.has(task.statusCategory) && isReadyStatus(task.workflowStatusId)
  if (reasons.length > 0) return { kind: 'blocked', reasons }
  // With no Ready status chosen, any backlog or unstarted status is a candidate, and those are the
  // only categories left once nothing above blocked, so only a chosen Ready status can be missing here.
  if (inCandidateStatus) return { kind: 'alreadyReady' }
  const target = configuration
    ? resolveAllowedWorkflowStatuses(task.workflowStatusId, configuration, task.workItemTypeId).find((status) =>
      status.id !== task.workflowStatusId && readyStatusIds.has(status.id) && candidateCategories.has(status.category))
    : undefined
  return target ? { kind: 'canMove', status: target } : { kind: 'blocked', reasons: ['noTransition'] }
}
