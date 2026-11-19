import { useState } from 'react'
import {
  createDefaultDueDateWorkItemSchedule,
  createDefaultUnscheduledWorkItemSchedule,
  type CreateWorkItemInput,
} from '@mukuroji/contracts'
import { createTeamIssue } from '../../issues/api/workItems'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { getWorkItemConfiguration } from '../../work-items/api/configuration'
import {
  resolveCreatableWorkItemTypeId,
  resolveCreateWorkflowStatuses,
  resolveWorkItemTypes,
} from '../../work-items/model/workItemDisplay'
import type {
  ChecklistItemSource,
  ChecklistWorkItemInput,
} from '../model/checklistWorkItems'
import { createCanonicalWorkItemId } from '../model/relations'

/**
 * Options for creating Work Items from Document checklist items.
 */
export type UseChecklistWorkItemCreationOptions = {
  /** Workspace API token; omission makes every create fail. */
  accessToken?: string
  /** Localized message thrown when the Work Item cannot be created. */
  errorMessage: string
}

/**
 * Creates Work Items from Document checklist items.
 *
 * Retries share an idempotency context only for the same source item, so a
 * lost response is recovered for that item and never reused by another item
 * with the same values.
 *
 * @param options - API token and the failure message.
 * @returns The create action.
 */
export function useChecklistWorkItemCreation({
  accessToken,
  errorMessage,
}: UseChecklistWorkItemCreationOptions) {
  const [mutationRunner] = useState(createMutationRequestRunner)

  /**
   * Creates a Work Item assigned to a Project for one checklist item.
   *
   * Like the quick create form, the Work Item is captured into a backlog
   * status when the Team has one, so required custom fields can be filled in
   * later.
   *
   * @param source - Document checklist item the Work Item is created from.
   * @param input - Team, Project, title, owner, and optional deadline.
   * @returns Canonical ID of the created Work Item.
   */
  const createWorkItem = async (
    source: ChecklistItemSource,
    input: ChecklistWorkItemInput,
  ): Promise<string> => {
    if (!accessToken) throw new Error(errorMessage)
    const configuration = await getWorkItemConfiguration(accessToken, {
      kind: 'team',
      teamId: input.teamId,
    }).catch(() => undefined)
    const workItemTypeId = configuration
      ? resolveCreatableWorkItemTypeId(resolveWorkItemTypes(configuration))
      : undefined
    const backlogStatus = resolveCreateWorkflowStatuses(
      configuration,
      workItemTypeId,
    ).find((status) => status.category === 'backlog')
    const request: CreateWorkItemInput = {
      assignedProjectId: input.projectId,
      assigneeUserId: input.assigneeUserId,
      priority: 'medium',
      schedule: input.dueDate
        ? createDefaultDueDateWorkItemSchedule(input.dueDate)
        : createDefaultUnscheduledWorkItemSchedule(),
      title: input.title,
      ...(workItemTypeId ? { workItemTypeId } : {}),
      ...(backlogStatus
        ? { quickCapture: true, workflowStatusId: backlogStatus.id }
        : {}),
    }
    const issue = await mutationRunner.run(
      `issue:create:document-checklist:${JSON.stringify([
        source.documentId,
        source.blockId,
        source.itemId,
      ])}`,
      JSON.stringify([input.teamId, request]),
      (context) => createTeamIssue(input.teamId, accessToken, request, context),
    )
    const workItemId = createCanonicalWorkItemId(issue.teamId, issue.id)
    if (!workItemId) throw new Error(errorMessage)
    return workItemId
  }

  return { createWorkItem }
}
