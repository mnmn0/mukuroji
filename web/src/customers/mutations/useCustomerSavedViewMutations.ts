import type { CreateCustomerSavedViewInput, CustomerSavedView } from '@mukuroji/contracts'
import { useCallback, useState } from 'react'
import { createCustomerSavedView } from '../api'
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

/** Saved Customer view mutation state exposed to the directory page. */
export type CustomerSavedViewMutations = {
  /** Whether a saved-view creation request is in progress. */
  isSaving: boolean
  /** Whether the most recent saved-view creation failed. */
  hasError: boolean
  /** Creates and refreshes one saved Customer directory view. */
  save: (input: CreateCustomerSavedViewInput) => Promise<CustomerSavedView | undefined>
}

/** Owns saved Customer view creation, retry identity, and cache refresh.
 *
 * @param input API credentials, authorization state, and cache refresh callback.
 * @returns Saved-view mutation state and the create operation.
 */
export function useCustomerSavedViewMutations(
  input: UseCustomerSavedViewMutationsInput,
): CustomerSavedViewMutations {
  const [mutationRunner] = useState(() => createMutationRequestRunner())
  const [isSaving, setIsSaving] = useState(false)
  const [hasError, setHasError] = useState(false)
  const save = useCallback(async (viewInput: CreateCustomerSavedViewInput) => {
    const accessToken = input.accessToken
    if (!accessToken || !input.enabled) return undefined
    setIsSaving(true)
    setHasError(false)
    try {
      const fingerprint = await createMutationFingerprint(
        'customer-saved-view.create',
        JSON.stringify(viewInput),
      )
      const savedView = await mutationRunner.run(
        'customer-saved-view.create',
        fingerprint,
        (context) => createCustomerSavedView(accessToken, viewInput, context),
      )
      await input.refresh()
      return savedView
    } catch {
      setHasError(true)
      return undefined
    } finally {
      setIsSaving(false)
    }
  }, [input, mutationRunner])

  return { hasError, isSaving, save }
}
