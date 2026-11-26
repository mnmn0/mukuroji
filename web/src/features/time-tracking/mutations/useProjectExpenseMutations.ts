import type { DecideProjectExpenseRequest, ProjectExpense, ProjectExpenseInput } from '@mukuroji/contracts'
import { useCallback, useState } from 'react'
import { completeProjectFileVersionUpload, createProjectFileUpload, putPresignedFile } from '../../../files/api/uploads'
import { FilesApiError } from '../../../files/api/errors'
import { createMutationFingerprint, createMutationRequestContext, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
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

/** A submission whose result is unknown, kept so a retry of the same input is the same request. */
type PendingExpenseSubmission = {
  /** Digest of the Project, the input, and the receipts. */
  fingerprint: string
  /** Idempotency key and correlation ID the retry reuses. */
  context: MutationRequestContext
}

/**
 * Identifies a chosen receipt file without reading its body.
 *
 * @param file - Receipt file.
 * @returns A key that stays the same while the member keeps the same file selected.
 */
function receiptKey(file: File) {
  return JSON.stringify([file.name, file.size, file.lastModified, file.type])
}

/**
 * Tells whether a failed request may still have been stored, so its retry must reuse the key.
 *
 * @param error - Failure of an upload or of the expense request.
 * @returns True for a network failure or a server error, false for a definite rejection.
 */
function isUncertainFailure(error: unknown) {
  const status = error instanceof TimeTrackingApiError || error instanceof FilesApiError ? error.status : 0
  return status === 0 || status >= 500
}

/** Submits expenses, keeping what a retry of the same input needs after an uncertain failure. */
export type ProjectExpenseSubmitter = {
  /**
   * Uploads the receipts not yet uploaded and submits the expense with them. After a network or
   * server failure, a retry with the same input reuses the receipts already uploaded and the same
   * idempotency key, so the server returns the expense it may already have stored.
   *
   * @param accessToken - Bearer token.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project identifier.
   * @param input - Expense fields without receipts.
   * @param receipts - Receipt files chosen by the manager.
   * @returns The stored expense.
   */
  submit(accessToken: string, teamId: string, projectId: string, input: ProjectExpenseInput, receipts: readonly File[]): Promise<ProjectExpense>
}

/**
 * Creates an expense submitter that remembers uploaded receipts and an unanswered submission.
 *
 * @returns The submitter.
 */
export function createProjectExpenseSubmitter(): ProjectExpenseSubmitter {
  // Receipts already uploaded, so a retry after a failure does not upload them again.
  const uploadedReceipts = new Map<string, string>()
  let pendingSubmission: PendingExpenseSubmission | undefined
  return {
    async submit(accessToken, teamId, projectId, input, receipts) {
      const scope = JSON.stringify([teamId, projectId])
      const keys = receipts.map((file) => `${scope}${receiptKey(file)}`)
      const fingerprint = await createMutationFingerprint(scope, JSON.stringify(input), ...keys)
      const pending = pendingSubmission?.fingerprint === fingerprint
        ? pendingSubmission
        : { fingerprint, context: createMutationRequestContext() }
      pendingSubmission = pending
      try {
        const receiptFileIds: string[] = []
        for (const [index, file] of receipts.entries()) {
          const key = keys[index] ?? receiptKey(file)
          let fileId = uploadedReceipts.get(key)
          if (fileId === undefined) {
            const session = await createProjectFileUpload(teamId, projectId, accessToken, {
              fileName: file.name,
              contentType: file.type || 'application/octet-stream',
              sizeBytes: file.size,
            }, createMutationRequestContext())
            await putPresignedFile(session.upload, file)
            await completeProjectFileVersionUpload(teamId, projectId, session.file.id, session.version.id, accessToken, createMutationRequestContext())
            fileId = session.file.id
            uploadedReceipts.set(key, fileId)
          }
          receiptFileIds.push(fileId)
        }
        const expense = await createProjectExpense(accessToken, teamId, projectId, { ...input, receiptFileIds }, pending.context)
        if (pendingSubmission === pending) pendingSubmission = undefined
        for (const key of keys) uploadedReceipts.delete(key)
        return expense
      } catch (error) {
        // A definite rejection stored nothing, so the next attempt is a new request.
        if (!isUncertainFailure(error) && pendingSubmission === pending) pendingSubmission = undefined
        throw error
      }
    },
  }
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
  const [submitter] = useState(createProjectExpenseSubmitter)
  const submit = useCallback(async (input: ProjectExpenseInput, receipts: readonly File[]) => {
    const token = requireToken()
    try {
      return await submitter.submit(token, teamId, projectId, input, receipts)
    } finally {
      await refresh()
    }
  }, [projectId, refresh, requireToken, submitter, teamId])
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
