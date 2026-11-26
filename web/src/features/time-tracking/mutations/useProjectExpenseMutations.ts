import type { DecideProjectExpenseRequest, ProjectExpense, ProjectExpenseInput } from '@mukuroji/contracts'
import { useCallback, useState } from 'react'
import { completeProjectFileVersionUpload, createProjectFileUpload, putPresignedFile, type PresignedPutUpload } from '../../../files/api/uploads'
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

/** Upload of one receipt, kept so a retry continues it instead of uploading the file again. */
type ReceiptUpload = {
  /** File the upload session created. */
  fileId: string
  /** Version the upload session created. */
  versionId: string
  /** Presigned upload of the version body. */
  upload: PresignedPutUpload
  /** Whether the body was uploaded. */
  bodyUploaded: boolean
  /** Whether the version was completed, so the file is ready to attach. */
  completed: boolean
  /** Idempotency key and correlation ID the completion and its retries share. */
  completionContext: MutationRequestContext
}

/** Random identity of each chosen file, so two different files with the same metadata stay apart. */
const receiptIdentities = new WeakMap<File, string>()

/**
 * Identifies a chosen receipt file by the object the member chose, without reading its body.
 *
 * @param file - Receipt file.
 * @returns A key that stays the same while the member keeps the same file selected.
 */
function receiptKey(file: File) {
  let key = receiptIdentities.get(file)
  if (key === undefined) {
    key = globalThis.crypto.randomUUID()
    receiptIdentities.set(file, key)
  }
  return key
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
  // Receipt uploads started, so a retry after a failure continues them rather than starting over.
  const receiptUploads = new Map<string, ReceiptUpload>()
  // Idempotency context of each submission whose result is unknown, by its fingerprint.
  const pendingSubmissions = new Map<string, MutationRequestContext>()

  /**
   * Uploads one receipt, or finishes the upload a failed attempt left part done.
   *
   * @param accessToken - Bearer token.
   * @param teamId - Team that owns the Project.
   * @param projectId - Project identifier.
   * @param key - Scoped receipt key.
   * @param file - Receipt file.
   * @returns The uploaded file ID.
   */
  async function uploadReceipt(accessToken: string, teamId: string, projectId: string, key: string, file: File) {
    let state = receiptUploads.get(key)
    if (state === undefined) {
      const session = await createProjectFileUpload(teamId, projectId, accessToken, {
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      }, createMutationRequestContext())
      state = {
        fileId: session.file.id,
        versionId: session.version.id,
        upload: session.upload,
        bodyUploaded: false,
        completed: false,
        completionContext: createMutationRequestContext(),
      }
      receiptUploads.set(key, state)
    }
    try {
      if (!state.bodyUploaded) {
        await putPresignedFile(state.upload, file)
        state.bodyUploaded = true
      }
      if (!state.completed) {
        await completeProjectFileVersionUpload(teamId, projectId, state.fileId, state.versionId, accessToken, state.completionContext)
        state.completed = true
      }
    } catch (error) {
      // A definite rejection, such as an expired upload URL, starts a new upload next time.
      if (!isUncertainFailure(error)) receiptUploads.delete(key)
      throw error
    }
    return state.fileId
  }

  return {
    async submit(accessToken, teamId, projectId, input, receipts) {
      const scope = JSON.stringify([teamId, projectId])
      const keys = receipts.map((file) => `${scope}${receiptKey(file)}`)
      const fingerprint = await createMutationFingerprint(scope, JSON.stringify(input), ...keys)
      let context = pendingSubmissions.get(fingerprint)
      if (context === undefined) {
        context = createMutationRequestContext()
        pendingSubmissions.set(fingerprint, context)
      }
      try {
        const receiptFileIds: string[] = []
        for (const [index, file] of receipts.entries()) {
          receiptFileIds.push(await uploadReceipt(accessToken, teamId, projectId, keys[index] ?? `${scope}${receiptKey(file)}`, file))
        }
        const expense = await createProjectExpense(accessToken, teamId, projectId, { ...input, receiptFileIds }, context)
        pendingSubmissions.delete(fingerprint)
        for (const key of keys) receiptUploads.delete(key)
        return expense
      } catch (error) {
        // A definite rejection stored nothing, so the next attempt is a new request.
        if (!isUncertainFailure(error)) pendingSubmissions.delete(fingerprint)
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
