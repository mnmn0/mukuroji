import type {
  CreateCustomerSavedViewInput,
  CustomerSavedView,
  UpdateCustomerSavedViewInput,
} from '@mukuroji/contracts'
import { useCallback, useState } from 'react'
import {
  createCustomerSavedView,
  deleteCustomerSavedView,
  updateCustomerSavedView,
} from '../api/customers'
import {
  readCustomerMutationFailure,
  resolveCustomerMutationErrorKey,
  shouldRefreshAfterCustomerMutationFailure,
} from '../model/customerMutationErrors'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'

/** Inputs required by the saved Customer view mutation controller. */
export type UseCustomerSavedViewMutationsInput = {
  /** Bearer token used by the Customer API. */
  accessToken?: string
  /** Revalidates the SWR-owned saved-view collection after a successful mutation. */
  refresh: () => Promise<unknown>
  /** Whether the current Workspace route is authorized to load and mutate Customer data. */
  enabled: boolean
}

/** Replacement fields for one saved Customer view, without the revision fence the controller adds. */
export type CustomerSavedViewChanges = Omit<UpdateCustomerSavedViewInput, 'expectedRevision'>

/** Saved Customer view mutation state exposed to the directory page. */
export type CustomerSavedViewMutations = {
  /** Whether a saved-view request is in progress. */
  isSaving: boolean
  /** Message for the most recent failed saved-view change, when any. */
  errorKey?: MessageKey
  /** Creates and refreshes one saved Customer directory view. */
  save: (input: CreateCustomerSavedViewInput) => Promise<CustomerSavedView | undefined>
  /** Renames or replaces the filters of one saved view. Resolves true when it was saved. */
  update: (view: CustomerSavedView, changes: CustomerSavedViewChanges) => Promise<boolean>
  /** Deletes one saved view. Resolves true when it was deleted. */
  remove: (view: CustomerSavedView) => Promise<boolean>
}

/** Owns saved Customer view creation, editing, deletion, retry identity, and cache refresh.
 *
 * @param input API credentials, authorization state, and cache refresh callback.
 * @returns Saved-view mutation state and the create, update, and delete operations.
 */
export function useCustomerSavedViewMutations(
  input: UseCustomerSavedViewMutationsInput,
): CustomerSavedViewMutations {
  const { accessToken, enabled, refresh } = input
  const [mutationRunner] = useState(() => createMutationRequestRunner())
  const [isSaving, setIsSaving] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey>()

  /** Runs one saved-view change, refreshes the collection, and turns failures into a message. */
  const run = useCallback(async <Result>(
    operation: (token: string) => Promise<Result>,
    failureKey?: MessageKey,
  ): Promise<{ ok: true; value: Result } | { ok: false }> => {
    if (!accessToken || !enabled) return { ok: false }
    setIsSaving(true)
    setErrorKey(undefined)
    try {
      const value = await operation(accessToken)
      // The change is saved; a failed reload must not report it as a failed save.
      await refresh().catch(() => undefined)
      return { ok: true, value }
    } catch (error) {
      const failure = readCustomerMutationFailure(error)
      setErrorKey(failureKey ?? resolveCustomerMutationErrorKey(failure))
      if (shouldRefreshAfterCustomerMutationFailure(failure)) await refresh().catch(() => undefined)
      return { ok: false }
    } finally {
      setIsSaving(false)
    }
  }, [accessToken, enabled, refresh])

  const save = useCallback(async (viewInput: CreateCustomerSavedViewInput) => {
    const result = await run(async (token) => {
      const fingerprint = await createMutationFingerprint(
        'customer-saved-view.create',
        JSON.stringify(viewInput),
      )
      return await mutationRunner.run(
        'customer-saved-view.create',
        fingerprint,
        (context) => createCustomerSavedView(token, viewInput, context),
      )
    }, 'customers.filters.saveError')
    return result.ok ? result.value : undefined
  }, [mutationRunner, run])

  const update = useCallback(async (view: CustomerSavedView, changes: CustomerSavedViewChanges) =>
    (await run((token) => updateCustomerSavedView(token, view.id, {
      ...changes,
      expectedRevision: view.revision,
    }))).ok, [run])

  const remove = useCallback(async (view: CustomerSavedView) =>
    (await run((token) => deleteCustomerSavedView(token, view.id, view.revision))).ok, [run])

  return { errorKey, isSaving, remove, save, update }
}
