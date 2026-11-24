import type {
  CreateCustomerContactInput,
  CreateCustomerInput,
  Customer,
  CustomerContact,
  CustomerDetail,
  CustomerRequest,
  CustomerRequestWorkItemLink,
  UpdateCustomerContactInput,
  UpdateCustomerInput,
  UpdateCustomerRequestInput,
} from '@mukuroji/contracts'
import { parseWorkItemKey } from '@mukuroji/contracts'
import { useCallback, useMemo, useState } from 'react'
import {
  createCustomer,
  createCustomerContact,
  createCustomerRequest,
  deleteCustomerContact,
  linkCustomerRequestProject,
  linkCustomerRequestWorkItem,
  mergeCustomer,
  unlinkCustomerRequestProject,
  unlinkCustomerRequestWorkItem,
  updateCustomer,
  updateCustomerContact,
  updateCustomerRequest,
  type CreateCustomerRequestBody,
} from '../api/customers'
import { getWorkItemByKey } from '../../issues/api/workItems'
import {
  readCustomerMutationFailure,
  resolveCustomerMutationErrorKey,
  shouldRefreshAfterCustomerMutationFailure,
} from '../model/customerMutationErrors'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'

/** Inputs required by the Customer editing controller. */
export type UseCustomerEditingInput = {
  /** Bearer token used by the Customer API. */
  accessToken?: string
  /** Whether the member may change Customer records. */
  enabled: boolean
  /** Reloads the Customer directory and the selected Customer after a change. */
  refresh: () => Promise<unknown>
  /** Reloads only the Customer directory. Used after a merge, when the selected Customer no longer exists. */
  refreshDirectory: () => Promise<unknown>
}

/** Customer editing state and operations exposed to the Customer page. */
export type CustomerEditingController = {
  /** Whether a change is being sent. */
  isSaving: boolean
  /** Message for the latest failed change, when any. */
  errorKey?: MessageKey
  /** Creates a Customer and returns it, or undefined when it failed. */
  createCustomer: (input: CreateCustomerInput) => Promise<Customer | undefined>
  /** Updates a Customer. */
  updateCustomer: (customerId: string, input: UpdateCustomerInput) => Promise<boolean>
  /** Merges a duplicate Customer into the Customer to keep and returns the kept Customer, or undefined when it failed. */
  mergeCustomer: (source: Customer, target: Customer) => Promise<CustomerDetail | undefined>
  /** Adds a contact to a Customer. */
  createContact: (customerId: string, input: CreateCustomerContactInput) => Promise<boolean>
  /** Updates a contact. */
  updateContact: (contact: CustomerContact, input: UpdateCustomerContactInput) => Promise<boolean>
  /** Deletes a contact. */
  deleteContact: (contact: CustomerContact) => Promise<boolean>
  /** Records a Customer Request by hand. */
  createRequest: (input: CreateCustomerRequestBody) => Promise<boolean>
  /** Updates a Customer Request. */
  updateRequest: (request: CustomerRequest, input: UpdateCustomerRequestInput) => Promise<boolean>
  /** Links a Customer Request to the Work Item a key such as `PT-12` names. */
  linkWorkItem: (request: CustomerRequest, workItemKey: string) => Promise<boolean>
  /** Removes a Customer Request-to-Work-Item link. */
  unlinkWorkItem: (request: CustomerRequest, link: CustomerRequestWorkItemLink) => Promise<boolean>
  /** Links a Customer Request directly to a Project. */
  linkProject: (request: CustomerRequest, projectId: string) => Promise<boolean>
  /** Removes a direct Customer Request-to-Project link. */
  unlinkProject: (request: CustomerRequest, projectId: string) => Promise<boolean>
}

/** Thrown before any request when a Work Item key is malformed. */
class InvalidWorkItemKeyError extends Error {}

/**
 * Owns Customer, contact, and Customer Request changes: retry identity, failure messages, and cache refresh.
 *
 * @param input API credentials, permission, and cache refresh callback.
 * @returns Editing state and the operations the Customer page wires into its view.
 */
export function useCustomerEditing(input: UseCustomerEditingInput): CustomerEditingController {
  const { accessToken, enabled, refresh, refreshDirectory } = input
  const [mutationRunner] = useState(() => createMutationRequestRunner())
  const [isSaving, setIsSaving] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey>()

  /** Runs one change, refreshes Customer data, and turns failures into a message. */
  const run = useCallback(async <Result>(
    operation: (token: string) => Promise<Result>,
    refreshAfterSuccess: () => Promise<unknown> = refresh,
  ): Promise<{ ok: true; value: Result } | { ok: false }> => {
    if (!accessToken || !enabled) return { ok: false }
    setIsSaving(true)
    setErrorKey(undefined)
    try {
      const value = await operation(accessToken)
      // The change is saved; a failed reload must not report it as a failed save.
      await refreshAfterSuccess().catch(() => undefined)
      return { ok: true, value }
    } catch (error) {
      if (error instanceof InvalidWorkItemKeyError) {
        setErrorKey('customers.edit.issue.workItemKeyInvalid')
        return { ok: false }
      }
      const failure = readCustomerMutationFailure(error)
      setErrorKey(resolveCustomerMutationErrorKey(failure))
      if (shouldRefreshAfterCustomerMutationFailure(failure)) await refresh().catch(() => undefined)
      return { ok: false }
    } finally {
      setIsSaving(false)
    }
  }, [accessToken, enabled, refresh])

  /** Runs one create that the server de-duplicates by Idempotency-Key, reusing the key on retry. */
  const runIdempotent = useCallback(async <Result>(
    operationKey: string,
    body: unknown,
    operation: (token: string, context: MutationRequestContext) => Promise<Result>,
  ) => await run(async (token) => {
    const fingerprint = await createMutationFingerprint(operationKey, JSON.stringify(body))
    return await mutationRunner.run(operationKey, fingerprint, (context) => operation(token, context))
  }), [mutationRunner, run])

  return useMemo(() => ({
    isSaving,
    errorKey,
    createCustomer: async (customerInput) => {
      const result = await runIdempotent('customer.create', customerInput, (token, context) =>
        createCustomer(token, customerInput, context))
      return result.ok ? result.value : undefined
    },
    updateCustomer: async (customerId, update) =>
      (await run((token) => updateCustomer(token, customerId, update))).ok,
    mergeCustomer: async (source, target) => {
      const result = await run((token) => mergeCustomer(token, source.id, {
        targetCustomerId: target.id,
        sourceExpectedRevision: source.revision,
        targetExpectedRevision: target.revision,
      }), refreshDirectory)
      return result.ok ? result.value : undefined
    },
    createContact: async (customerId, contactInput) =>
      (await runIdempotent(`customer-contact.create:${customerId}`, contactInput, (token, context) =>
        createCustomerContact(token, customerId, contactInput, context))).ok,
    updateContact: async (contact, update) =>
      (await run((token) => updateCustomerContact(token, contact.customerId, contact.id, update))).ok,
    deleteContact: async (contact) =>
      (await run((token) => deleteCustomerContact(token, contact.customerId, contact.id, contact.revision))).ok,
    createRequest: async (requestInput) =>
      (await runIdempotent('customer-request.create', requestInput, (token, context) =>
        createCustomerRequest(token, requestInput, context))).ok,
    updateRequest: async (request, update) =>
      (await run((token) => updateCustomerRequest(token, request.id, update))).ok,
    linkWorkItem: async (request, workItemKey) =>
      (await run(async (token) => {
        const key = parseWorkItemKey(workItemKey)
        if (!key) throw new InvalidWorkItemKeyError()
        const location = await getWorkItemByKey(key.key, token)
        return await linkCustomerRequestWorkItem(token, request.id, {
          teamId: location.teamId,
          workItemId: location.workItemId,
        })
      })).ok,
    unlinkWorkItem: async (request, link) =>
      (await run((token) => unlinkCustomerRequestWorkItem(
        token,
        request.id,
        { teamId: link.teamId, workItemId: link.workItemId },
        request.revision,
      ))).ok,
    linkProject: async (request, projectId) =>
      (await run((token) => linkCustomerRequestProject(token, request.id, projectId))).ok,
    unlinkProject: async (request, projectId) =>
      (await run((token) => unlinkCustomerRequestProject(token, request.id, projectId, request.revision))).ok,
  }), [errorKey, isSaving, refreshDirectory, run, runIdempotent])
}
