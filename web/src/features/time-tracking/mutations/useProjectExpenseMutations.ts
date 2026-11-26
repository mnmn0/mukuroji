import type { DecideProjectExpenseRequest, ProjectExpense, ProjectExpenseInput } from '@mukuroji/contracts'
import { useCallback } from 'react'
import { completeProjectFileVersionUpload, createProjectFileUpload, putPresignedFile } from '../../../files/api/uploads'
import { createMutationRequestContext } from '../../../shared/api/mutationHeaders'
import { createProjectExpense, decideProjectExpense, deleteProjectExpense } from '../api/projectExpenses'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/** Expense mutations of one Project. */
export type ProjectExpenseMutations = {
  /**
   * Uploads the receipts to the Project's files and submits the expense with them.
   *
   * @param input - Expense fields without receipts.
   * @param receipts - Receipt files chosen by the manager.
   * @returns The stored expense.
   */
  submit(input: ProjectExpenseInput, receipts: readonly File[]): Promise<ProjectExpense>
  /**
   * Approves or rejects a submitted expense.
   *
   * @param expense - Expense read by the client.
   * @param request - Outcome and note.
   * @returns The decided expense.
   */
  decide(expense: ProjectExpense, request: Omit<DecideProjectExpenseRequest, 'expectedRevision'>): Promise<ProjectExpense>
  /**
   * Deletes an expense that is not approved.
   *
   * @param expense - Expense read by the client.
   */
  remove(expense: ProjectExpense): Promise<void>
}

/**
 * Creates the expense mutations of a Project. Each refreshes every time tracking query after it
 * settles, so the list and the budget report agree.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The mutations.
 */
export function useProjectExpenseMutations(accessToken: string | undefined, teamId: string, projectId: string): ProjectExpenseMutations {
  const refresh = useRefreshTimeTrackingQueries()
  const requireToken = useCallback(() => {
    if (!accessToken) throw new TimeTrackingApiError(401, 'Sign in again to change expenses.')
    return accessToken
  }, [accessToken])
  const submit = useCallback(async (input: ProjectExpenseInput, receipts: readonly File[]) => {
    const token = requireToken()
    try {
      const receiptFileIds: string[] = []
      for (const file of receipts) {
        const session = await createProjectFileUpload(teamId, projectId, token, {
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        }, createMutationRequestContext())
        await putPresignedFile(session.upload, file)
        await completeProjectFileVersionUpload(teamId, projectId, session.file.id, session.version.id, token, createMutationRequestContext())
        receiptFileIds.push(session.file.id)
      }
      return await createProjectExpense(token, teamId, projectId, { ...input, receiptFileIds }, createMutationRequestContext())
    } finally {
      await refresh()
    }
  }, [projectId, refresh, requireToken, teamId])
  const decide = useCallback(async (expense: ProjectExpense, request: Omit<DecideProjectExpenseRequest, 'expectedRevision'>) => {
    const token = requireToken()
    try {
      return await decideProjectExpense(token, teamId, projectId, expense.id, { ...request, expectedRevision: expense.revision }, createMutationRequestContext())
    } finally {
      await refresh()
    }
  }, [projectId, refresh, requireToken, teamId])
  const remove = useCallback(async (expense: ProjectExpense) => {
    const token = requireToken()
    try {
      await deleteProjectExpense(token, teamId, projectId, expense, createMutationRequestContext())
    } finally {
      await refresh()
    }
  }, [projectId, refresh, requireToken, teamId])
  return { submit, decide, remove }
}
