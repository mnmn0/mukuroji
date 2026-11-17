import {
  isWorkItemHierarchyRank,
  type TeamWorkItemHierarchyNode,
  type TeamWorkItemHierarchyResponse,
  type WorkflowStatusCategory,
  type WorkItemHierarchyRollup,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { WorkItemConfigurationApiError } from './errors'

const workItemsApiBaseUrl = resolveApiBaseUrl()

const defaultHierarchyErrorMessage = 'Unable to load the Work Item hierarchy.'

const statusCategories: readonly WorkflowStatusCategory[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]

/**
 * Reads a Team's Work Item hierarchy with WBS numbers and roll-ups.
 *
 * @param teamId - Team whose hierarchy is read.
 * @param accessToken - Access token sent as the bearer token.
 * @returns The validated hierarchy.
 * @throws WorkItemConfigurationApiError when the request fails or the response is malformed.
 */
export async function getTeamWorkItemHierarchy(
  teamId: string,
  accessToken: string,
): Promise<TeamWorkItemHierarchyResponse> {
  const response = await fetch(
    `${workItemsApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/hierarchy`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const data = await readJson(response)
  if (!response.ok) {
    const message = readStringProperty(data, 'message')?.trim()
    throw new WorkItemConfigurationApiError(
      response.status,
      message || defaultHierarchyErrorMessage,
      readStringProperty(data, 'code'),
    )
  }
  const hierarchy = parseTeamWorkItemHierarchyResponse(data)
  if (!hierarchy || hierarchy.teamId !== teamId) {
    throw new WorkItemConfigurationApiError(502, defaultHierarchyErrorMessage, 'InvalidWorkItemHierarchy')
  }
  return hierarchy
}

/**
 * Validates an untrusted hierarchy response.
 *
 * @param value - Parsed response body.
 * @returns The hierarchy, or `undefined` when any part is malformed.
 */
export function parseTeamWorkItemHierarchyResponse(
  value: unknown,
): TeamWorkItemHierarchyResponse | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.teamId !== 'string') return undefined
  if (!isNonNegativeInteger(value.graphRevision) || !Array.isArray(value.nodes)) return undefined
  const nodes: TeamWorkItemHierarchyNode[] = []
  for (const candidate of value.nodes) {
    const node = parseNode(candidate)
    if (!node) return undefined
    nodes.push(node)
  }
  return { schemaVersion: 1, teamId: value.teamId, graphRevision: value.graphRevision, nodes }
}

/**
 * Validates one hierarchy node.
 *
 * @param value - Untrusted node.
 * @returns The node, or `undefined` when malformed.
 */
function parseNode(value: unknown): TeamWorkItemHierarchyNode | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.workItemId)) return undefined
  if (value.parentWorkItemId !== null && !isNonEmptyString(value.parentWorkItemId)) return undefined
  if (value.parentHidden !== undefined && value.parentHidden !== true) return undefined
  if (!isNonNegativeInteger(value.depth)) return undefined
  if (typeof value.wbsNumber !== 'string' || !/^[1-9][0-9]*(\.[1-9][0-9]*)*$/u.test(value.wbsNumber)) {
    return undefined
  }
  if (!isWorkItemHierarchyRank(value.hierarchyRank)) return undefined
  if (!Array.isArray(value.childWorkItemIds) || !value.childWorkItemIds.every(isNonEmptyString)) {
    return undefined
  }
  const rollup = value.rollup === undefined ? undefined : parseRollup(value.rollup)
  if (value.rollup !== undefined && !rollup) return undefined
  return {
    workItemId: value.workItemId,
    parentWorkItemId: value.parentWorkItemId,
    ...(value.parentHidden ? { parentHidden: true } : {}),
    depth: value.depth,
    wbsNumber: value.wbsNumber,
    hierarchyRank: value.hierarchyRank,
    childWorkItemIds: [...value.childWorkItemIds],
    ...(rollup ? { rollup } : {}),
  }
}

/**
 * Validates one roll-up.
 *
 * @param value - Untrusted roll-up.
 * @returns The roll-up, or `undefined` when malformed.
 */
function parseRollup(value: unknown): WorkItemHierarchyRollup | undefined {
  if (!isRecord(value) || !isRecord(value.statusCategoryCounts)) return undefined
  const counts = value.statusCategoryCounts
  const statusCategoryCounts: Record<WorkflowStatusCategory, number> = {
    backlog: 0,
    unstarted: 0,
    started: 0,
    completed: 0,
    canceled: 0,
  }
  for (const category of statusCategories) {
    const count = counts[category]
    if (!isNonNegativeInteger(count)) return undefined
    statusCategoryCounts[category] = count
  }
  const numbers = [
    value.childCount,
    value.descendantCount,
    value.openDescendantCount,
    value.plannedEffortMinutes,
    value.estimatedDescendantCount,
    value.remainingEffortMinutes,
  ]
  if (!numbers.every(isNonNegativeInteger)) return undefined
  if (value.startDate !== undefined && !isCalendarDate(value.startDate)) return undefined
  if (value.endDate !== undefined && !isCalendarDate(value.endDate)) return undefined
  return {
    childCount: Number(value.childCount),
    descendantCount: Number(value.descendantCount),
    statusCategoryCounts,
    openDescendantCount: Number(value.openDescendantCount),
    plannedEffortMinutes: Number(value.plannedEffortMinutes),
    estimatedDescendantCount: Number(value.estimatedDescendantCount),
    remainingEffortMinutes: Number(value.remainingEffortMinutes),
    ...(typeof value.startDate === 'string' ? { startDate: value.startDate } : {}),
    ...(typeof value.endDate === 'string' ? { endDate: value.endDate } : {}),
  }
}

/**
 * Reads a JSON body without throwing on an empty or invalid body.
 *
 * @param response - Fetch response.
 * @returns The parsed body, or `undefined`.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Reads a string property of an untrusted value.
 *
 * @param value - Untrusted value.
 * @param key - Property name.
 * @returns The string, when present.
 */
function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const property = value[key]
  return typeof property === 'string' ? property : undefined
}

/**
 * Narrows an untrusted value to a plain record.
 *
 * @param value - Untrusted value.
 * @returns Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrows an untrusted value to a non-empty string.
 *
 * @param value - Untrusted value.
 * @returns Whether it is a non-empty string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Narrows an untrusted value to a non-negative safe integer.
 *
 * @param value - Untrusted value.
 * @returns Whether it is a non-negative safe integer.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Narrows an untrusted value to a `YYYY-MM-DD` date.
 *
 * @param value - Untrusted value.
 * @returns Whether it is a calendar date string.
 */
function isCalendarDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
}
