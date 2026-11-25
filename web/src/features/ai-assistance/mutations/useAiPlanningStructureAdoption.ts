import { useState } from 'react'
import { useSWRConfig } from 'swr'
import {
  createDefaultUnscheduledWorkItemSchedule,
  type CreateWorkItemInput,
  type PlanningSnapshot,
  type ScheduleDependencyType,
  type WorkItemDependencyEndpoint,
  type WorkItemPriority,
  type WorkItemTypeDefinition,
} from '@mukuroji/contracts'
import { createTeamIssue, getTeamIssueDetail } from '../../../issues/api/workItems'
import { isWorkspaceOrProjectWorkItemListKey } from '../../../issues/queries/useWorkItems'
import { getPlanningSnapshot } from '../../../planning/api/snapshot'
import { createWorkItemScheduleDependency } from '../../../planning/api/workItemDependencies'
import {
  createMutationRequestRunner,
  type MutationRequestRunner,
} from '../../../shared/api/mutationHeaders'
import { getWorkItemConfiguration } from '../../../work-items/api/configuration'
import { replaceWorkItemParent } from '../../../work-items/api/relations'
import { createWorkItemDependencyMutationId } from '../../../work-items/model/workItemDependencies'
import {
  resolveCreateWorkflowStatuses,
  resolveWorkItemTypes,
} from '../../../work-items/model/workItemDisplay'

/** Work Item that receives the adopted children; the generation source of the Planning draft. */
export type AiPlanningStructureParent = {
  /** Team that owns the parent Work Item. */
  teamId: string
  /** Team-local parent Work Item ID. */
  workItemId: string
  /** Work Item Type of the parent, whose allowed child types limit the children. */
  workItemTypeId: string
  /** Project the children are assigned to, the same as the parent's. */
  assignedProjectId?: string
  /** Assignee given to each child, the parent's assignee. */
  assigneeUserId: string
}

/** One proposed child Work Item as the reviewer edited it. */
export type AiPlanningStructureChildInput = {
  /** Row identifier within the generation, used to make the create idempotent. */
  rowId: string
  /** Child title. */
  title: string
  /** Optional child description. */
  description?: string
  /** Child priority. */
  priority: WorkItemPriority
  /** Optional planned effort in whole minutes. */
  plannedEffortMinutes?: number
}

/** One proposed dependency between visible Work Items. */
export type AiPlanningStructureDependencyInput = {
  /** Row identifier within the generation. */
  rowId: string
  /** Work Item whose schedule drives the dependency. */
  predecessor: WorkItemDependencyEndpoint
  /** Work Item whose schedule is constrained. */
  successor: WorkItemDependencyEndpoint
  /** Start/finish boundary relationship. */
  type: ScheduleDependencyType
  /** Signed calendar-day lead or lag. */
  lagDays: number
}

/** Selection the reviewer adopts in one operation. */
export type AiPlanningStructureAdoptionInput = {
  /** Approved generation the rows come from. */
  generationId: string
  /** Work Item Type used for every child; it must be allowed under the parent's type. */
  childWorkItemTypeId: string
  /** Children to create under the parent. */
  children: readonly AiPlanningStructureChildInput[]
  /** Dependencies to add. */
  dependencies: readonly AiPlanningStructureDependencyInput[]
}

/** Outcome of one adoption, by row. */
export type AiPlanningStructureAdoptionResult = {
  /** Created or recovered child Work Item IDs by row ID. */
  childWorkItemIds: Readonly<Record<string, string>>
  /** Dependency rows that now exist, including ones that already existed. */
  dependencyRowIds: readonly string[]
}

/** Failure raised when the selection cannot be adopted as reviewed. */
export class AiPlanningStructureAdoptionError extends Error {
  /** Stable reason the adoption stopped. */
  readonly reason: 'child-type-denied' | 'missing-token'

  /**
   * Creates a typed adoption failure.
   *
   * @param reason - Stable reason the adoption stopped.
   */
  constructor(reason: AiPlanningStructureAdoptionError['reason']) {
    super(reason)
    this.name = 'AiPlanningStructureAdoptionError'
    this.reason = reason
  }
}

/** Options for adopting the child Work Items and dependencies of a Planning draft. */
export type UseAiPlanningStructureAdoptionOptions = {
  /** Workspace member bearer token. */
  accessToken?: string
  /** Parent Work Item that receives the children. */
  parent: AiPlanningStructureParent
}

/**
 * Lists the active Work Item Types that the parent's type allows as children.
 *
 * @param workItemTypes - Work Item Types of the parent's Team.
 * @param parentWorkItemTypeId - Work Item Type of the parent.
 * @returns The allowed active child types in configuration order.
 */
export function resolveAllowedChildWorkItemTypes(
  workItemTypes: readonly WorkItemTypeDefinition[],
  parentWorkItemTypeId: string,
): WorkItemTypeDefinition[] {
  const parentType = workItemTypes.find((type) => type.id === parentWorkItemTypeId)
  if (!parentType) return []
  return workItemTypes.filter((type) =>
    type.status === 'active' && parentType.allowedChildTypeIds.includes(type.id))
}

/** Work Item, hierarchy, and Planning API calls the adoption makes; replaceable in tests. */
export type AiPlanningStructureApi = {
  /** Reads the Team Work Item configuration. */
  getWorkItemConfiguration: typeof getWorkItemConfiguration
  /** Creates one Work Item. */
  createTeamIssue: typeof createTeamIssue
  /** Reads a Work Item with its relations and the Team relation graph revision. */
  getTeamIssueDetail: typeof getTeamIssueDetail
  /** Sets a Work Item's parent. */
  replaceWorkItemParent: typeof replaceWorkItemParent
  /** Reads the Planning snapshot and its revision. */
  getPlanningSnapshot: typeof getPlanningSnapshot
  /** Adds one Work Item schedule dependency. */
  createWorkItemScheduleDependency: typeof createWorkItemScheduleDependency
}

/** API calls used outside tests. */
const defaultAiPlanningStructureApi: AiPlanningStructureApi = {
  createTeamIssue,
  createWorkItemScheduleDependency,
  getPlanningSnapshot,
  getTeamIssueDetail,
  getWorkItemConfiguration,
  replaceWorkItemParent,
}

/** State one adoption session keeps between attempts. */
export type AiPlanningStructureAdoptionSession = {
  /** Retains idempotency keys for retried requests. */
  runner: MutationRequestRunner
  /**
   * Children created in this session by generation and row. A retry after a later step failed
   * reuses them even when the reviewer edited the row in between, so no second child is created.
   */
  createdChildren: Map<string, string>
  /**
   * First create request sent for each generation and row. When a create's outcome is unknown
   * (its response was lost), the retry sends this same request with the same idempotency key, so
   * the server returns the child it made instead of creating a second one; edits made after that
   * first attempt do not reach the child.
   */
  attemptedChildren: Map<string, CreateWorkItemInput>
  /** API calls to make. */
  api: AiPlanningStructureApi
}

/**
 * Creates the state of one adoption session.
 *
 * @param api - API calls to make; the real ones by default.
 * @returns A fresh session.
 */
export function createAiPlanningStructureAdoptionSession(
  api: AiPlanningStructureApi = defaultAiPlanningStructureApi,
): AiPlanningStructureAdoptionSession {
  return { api, attemptedChildren: new Map(), createdChildren: new Map(), runner: createMutationRequestRunner() }
}

/**
 * Creates the child Work Items, parent links, and dependencies of an approved Planning draft.
 *
 * Each child is created with an idempotency key made from the generation and row, so sending the
 * same selection again returns the children already created instead of adding new ones. A child is
 * linked to the parent only when its relations do not already show that parent, and a
 * dependency is added only when the Planning graph does not already hold it, so a retry after a
 * partial failure finishes the remaining steps. The child type is checked against the parent's
 * allowed child types before anything is created, so a refused parent link cannot leave orphaned
 * children behind.
 *
 * @param session - Idempotency runner, created children, and API calls.
 * @param accessToken - Workspace member bearer token.
 * @param parent - Parent Work Item that receives the children.
 * @param input - Generation, child type, and the selected rows.
 * @returns Child IDs by row and the dependency rows that exist afterwards.
 * @throws AiPlanningStructureAdoptionError when the child type is not allowed.
 */
export async function adoptAiPlanningStructure(
  session: AiPlanningStructureAdoptionSession,
  accessToken: string,
  parent: AiPlanningStructureParent,
  input: AiPlanningStructureAdoptionInput,
): Promise<AiPlanningStructureAdoptionResult> {
  const childWorkItemIds = input.children.length === 0
    ? {}
    : await createChildren(session, accessToken, parent, input)
  const dependencyRowIds = input.dependencies.length === 0
    ? []
    : await createDependencies(session, accessToken, input)
  return { childWorkItemIds, dependencyRowIds }
}

/**
 * Connects the adoption to the signed-in member and refreshes the Team views afterwards.
 *
 * @param options - Bearer token and the parent Work Item.
 * @returns The adopt action and its pending state.
 */
export function useAiPlanningStructureAdoption({
  accessToken,
  parent,
}: UseAiPlanningStructureAdoptionOptions) {
  const [session] = useState(() => createAiPlanningStructureAdoptionSession())
  const [isPending, setIsPending] = useState(false)
  const { mutate } = useSWRConfig()

  /**
   * Adopts the reviewed selection.
   *
   * @param input - Generation, child type, and the selected rows.
   * @returns Child IDs by row and the dependency rows that exist afterwards.
   * @throws AiPlanningStructureAdoptionError when the token is missing or the child type is not allowed.
   */
  const adopt = async (
    input: AiPlanningStructureAdoptionInput,
  ): Promise<AiPlanningStructureAdoptionResult> => {
    if (!accessToken) throw new AiPlanningStructureAdoptionError('missing-token')
    setIsPending(true)
    try {
      const result = await adoptAiPlanningStructure(session, accessToken, parent, input)
      // Lists, details, hierarchies, and the Planning graph of the Team read the new children and
      // dependencies; a failed refresh leaves the created rows in place.
      // The Project and Workspace lists hold the children too, without the Team ID in their keys.
      await mutate(
        (key) => (Array.isArray(key) && (key.includes(parent.teamId) || key[0] === 'planning-snapshot')) ||
          isWorkspaceOrProjectWorkItemListKey(key, parent.assignedProjectId),
      ).catch(() => undefined)
      return result
    } finally {
      setIsPending(false)
    }
  }

  return { adopt, isPending }
}

/**
 * Creates the selected children and links each one to the parent.
 *
 * @param session - Idempotency runner, created children, and API calls.
 * @param token - Bearer token.
 * @param parent - Parent Work Item.
 * @param input - Reviewed selection.
 * @returns Child Work Item IDs by row ID.
 */
async function createChildren(
  { api, attemptedChildren, createdChildren, runner }: AiPlanningStructureAdoptionSession,
  token: string,
  parent: AiPlanningStructureParent,
  input: AiPlanningStructureAdoptionInput,
): Promise<Record<string, string>> {
  const configuration = await api.getWorkItemConfiguration(token, { kind: 'team', teamId: parent.teamId })
  const allowed = resolveAllowedChildWorkItemTypes(
    resolveWorkItemTypes(configuration),
    parent.workItemTypeId,
  )
  if (!allowed.some((type) => type.id === input.childWorkItemTypeId)) {
    throw new AiPlanningStructureAdoptionError('child-type-denied')
  }
  // Like other quick creates, children start in a backlog status when the Team has one, so
  // required custom fields can be filled in later instead of refusing the create.
  const backlogStatus = resolveCreateWorkflowStatuses(configuration, input.childWorkItemTypeId)
    .find((status) => status.category === 'backlog')
  const childWorkItemIds: Record<string, string> = {}
  for (const child of input.children) {
    const createdKey = `${input.generationId}:${child.rowId}`
    const created = createdChildren.get(createdKey)
    if (created !== undefined) {
      childWorkItemIds[child.rowId] = created
      continue
    }
    const request: CreateWorkItemInput = attemptedChildren.get(createdKey) ?? {
      ...(parent.assignedProjectId ? { assignedProjectId: parent.assignedProjectId } : {}),
      assigneeUserId: parent.assigneeUserId,
      ...(child.description ? { description: child.description } : {}),
      priority: child.priority,
      schedule: createDefaultUnscheduledWorkItemSchedule(child.plannedEffortMinutes),
      title: child.title,
      workItemTypeId: input.childWorkItemTypeId,
      ...(backlogStatus ? { quickCapture: true, workflowStatusId: backlogStatus.id } : {}),
    }
    attemptedChildren.set(createdKey, request)
    const issue = await runner.run(
      `ai-planning:${input.generationId}:child:${child.rowId}`,
      JSON.stringify([parent.teamId, request]),
      (context) => api.createTeamIssue(parent.teamId, token, request, context),
    )
    createdChildren.set(createdKey, issue.id)
    childWorkItemIds[child.rowId] = issue.id
  }
  // Each child's own detail tells whether it already has this parent and gives the current Team
  // relation graph revision; unlike the Team hierarchy, it can be read in a Team of any size.
  for (const childWorkItemId of Object.values(childWorkItemIds)) {
    const detail = await api.getTeamIssueDetail(parent.teamId, childWorkItemId, token)
    const hasParent = detail.relations?.some((relation) =>
      relation.type === 'parent' && relation.targetWorkItemId === parent.workItemId) ?? false
    if (hasParent) continue
    const expectedGraphRevision = detail.relationGraphRevision ?? 0
    await runner.run(
      `ai-planning:${input.generationId}:parent:${childWorkItemId}`,
      JSON.stringify([parent.workItemId, expectedGraphRevision]),
      (context) => api.replaceWorkItemParent(
        parent.teamId,
        childWorkItemId,
        token,
        { parentWorkItemId: parent.workItemId, expectedGraphRevision },
        context,
      ),
    )
  }
  return childWorkItemIds
}

/**
 * Adds the selected dependencies that the Planning graph does not already hold.
 *
 * @param session - Idempotency runner and API calls.
 * @param token - Bearer token.
 * @param input - Reviewed selection.
 * @returns Dependency row IDs that exist afterwards.
 */
async function createDependencies(
  { api, runner }: AiPlanningStructureAdoptionSession,
  token: string,
  input: AiPlanningStructureAdoptionInput,
): Promise<string[]> {
  let snapshot: PlanningSnapshot = await api.getPlanningSnapshot(token)
  const rowIds: string[] = []
  for (const dependency of input.dependencies) {
    if (!hasDependency(snapshot, dependency)) {
      const expectedRevision = snapshot.revision
      snapshot = await runner.run(
        `ai-planning:${input.generationId}:dependency:${dependency.rowId}`,
        JSON.stringify([expectedRevision, dependency]),
        (context) => api.createWorkItemScheduleDependency(token, {
          expectedRevision,
          id: createWorkItemDependencyMutationId(context.idempotencyKey),
          lagDays: dependency.lagDays,
          predecessor: dependency.predecessor,
          successor: dependency.successor,
          type: dependency.type,
        }, context),
      )
    }
    rowIds.push(dependency.rowId)
  }
  return rowIds
}

/**
 * Checks whether the Planning graph already links the two Work Items in the same direction.
 *
 * @param snapshot - Current Planning snapshot.
 * @param dependency - Proposed dependency.
 * @returns Whether an equal predecessor-successor pair exists.
 */
function hasDependency(
  snapshot: PlanningSnapshot,
  dependency: AiPlanningStructureDependencyInput,
): boolean {
  return snapshot.workItemDependencies.some((existing) =>
    isSameEndpoint(existing.predecessor, dependency.predecessor) &&
    isSameEndpoint(existing.successor, dependency.successor))
}

/**
 * Compares two Team-qualified Work Item endpoints.
 *
 * @param left - First endpoint.
 * @param right - Second endpoint.
 * @returns Whether both name the same Work Item.
 */
function isSameEndpoint(left: WorkItemDependencyEndpoint, right: WorkItemDependencyEndpoint): boolean {
  return left.teamId === right.teamId && left.workItemId === right.workItemId
}
