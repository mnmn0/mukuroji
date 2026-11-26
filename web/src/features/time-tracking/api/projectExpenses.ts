import {
  parseProjectExpense,
  type DecideProjectExpenseRequest,
  type ProjectExpense,
  type ProjectExpenseInput,
  type ProjectExpenseListResponse,
} from '@mukuroji/contracts'
import { isRecord } from '../../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import {
  createInvalidTimeTrackingResponseError,
  createTeamTimeTrackingUrl,
  requestTimeTrackingJson,
} from './timeTrackingRequest'

/**
 * Builds the path of a Project's expenses below its Team.
 *
 * @param projectId - Project identifier.
 * @param suffix - Path after the collection, such as `/<id>/decision`.
 * @returns Path below the Team.
 */
function expensesPath(projectId: string, suffix = ''): string {
  return `/projects/${encodeURIComponent(projectId)}/expenses${suffix}`
}

/**
 * Builds the path of one expense.
 *
 * @param projectId - Project identifier.
 * @param expenseId - Expense identifier.
 * @param suffix - Path after the expense.
 * @returns Path below the Team.
 */
function expensePath(projectId: string, expenseId: string, suffix = ''): string {
  return expensesPath(projectId, `/${encodeURIComponent(expenseId)}${suffix}`)
}

/**
 * Reads every expense of a Project; only its managers may.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The validated list.
 * @throws TimeTrackingApiError when the request fails or the response is malformed.
 */
export async function listProjectExpenses(accessToken: string, teamId: string, projectId: string): Promise<ProjectExpenseListResponse> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, expensesPath(projectId)), accessToken)
  const list = readProjectExpenseList(data)
  if (!list || list.teamId !== teamId || list.projectId !== projectId) throw createInvalidTimeTrackingResponseError('Project expenses')
  return list
}

/**
 * Submits a new expense.
 *
 * @param accessToken - Bearer token.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param input - Expense fields.
 * @param context - Idempotency context shared with retries.
 * @returns The stored expense.
 */
export async function createProjectExpense(
  accessToken: string,
  teamId: string,
  projectId: string,
  input: ProjectExpenseInput,
  context: MutationRequestContext,
): Promise<ProjectExpense> {
  return readExpenseResponse(await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, expensesPath(projectId)), accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify(input),
  }))
}

/**
 * Approves or rejects a submitted expense.
 *
 * @param accessToken - Bearer token.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param expenseId - Expense identifier.
 * @param request - Outcome, note, and the revision read.
 * @param context - Idempotency context shared with retries.
 * @returns The decided expense.
 */
export async function decideProjectExpense(
  accessToken: string,
  teamId: string,
  projectId: string,
  expenseId: string,
  request: DecideProjectExpenseRequest,
  context: MutationRequestContext,
): Promise<ProjectExpense> {
  return readExpenseResponse(await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, expensePath(projectId, expenseId, '/decision')), accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify(request),
  }))
}

/**
 * Deletes an expense that is not approved.
 *
 * @param accessToken - Bearer token.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param expense - Expense read by the client.
 * @param context - Idempotency context shared with retries.
 */
export async function deleteProjectExpense(
  accessToken: string,
  teamId: string,
  projectId: string,
  expense: Pick<ProjectExpense, 'id' | 'revision'>,
  context: MutationRequestContext,
): Promise<void> {
  await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, expensePath(projectId, expense.id)), accessToken, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify({ expectedRevision: expense.revision }),
  })
}

/**
 * Validates the expense list response.
 *
 * @param value - Unknown JSON.
 * @returns The list, or undefined when malformed.
 */
export function readProjectExpenseList(value: unknown): ProjectExpenseListResponse | undefined {
  if (!isRecord(value)) return undefined
  const { teamId, projectId, viewerMemberId, expenses } = value
  if (typeof teamId !== 'string' || typeof projectId !== 'string' || typeof viewerMemberId !== 'string' || !Array.isArray(expenses)) return undefined
  const parsed = expenses.map(parseProjectExpense)
  const valid = parsed.filter((expense): expense is ProjectExpense => expense !== undefined)
  if (valid.length !== parsed.length) return undefined
  return { teamId, projectId, viewerMemberId, expenses: valid }
}

/**
 * Validates a single-expense response.
 *
 * @param value - Unknown JSON.
 * @returns The expense.
 * @throws TimeTrackingApiError when malformed.
 */
function readExpenseResponse(value: unknown): ProjectExpense {
  const expense = isRecord(value) ? parseProjectExpense(value.expense) : undefined
  if (!expense) throw createInvalidTimeTrackingResponseError('Project expense')
  return expense
}
