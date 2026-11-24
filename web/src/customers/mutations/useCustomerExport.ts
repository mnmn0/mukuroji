import type { CustomerWorkspaceExport } from '@mukuroji/contracts'
import { useCallback, useState } from 'react'
import { getCustomerExport } from '../api/customers'
import {
  readCustomerMutationFailure,
  resolveCustomerMutationErrorKey,
} from '../model/customerMutationErrors'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Inputs required by the Customer export controller. */
export type UseCustomerExportInput = {
  /** Bearer token used by the Customer API. */
  accessToken?: string
  /** Whether the member may export the Workspace Customer data. */
  enabled: boolean
}

/** Customer export state exposed to the Customer page. */
export type CustomerExportController = {
  /** Whether the export is being prepared. */
  isExporting: boolean
  /** Message for the latest failed export, when any. */
  errorKey?: MessageKey
  /** Loads a fresh export. Resolves undefined when it failed or is not allowed. */
  exportCustomers: () => Promise<CustomerWorkspaceExport | undefined>
}

/**
 * Owns the on-demand Customer export request. The export is never cached, so each download is current.
 *
 * @param input API credentials and permission.
 * @returns Export state and the operation that loads one export.
 */
export function useCustomerExport(input: UseCustomerExportInput): CustomerExportController {
  const { accessToken, enabled } = input
  const [isExporting, setIsExporting] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey>()
  const exportCustomers = useCallback(async () => {
    if (!accessToken || !enabled) return undefined
    setIsExporting(true)
    setErrorKey(undefined)
    try {
      return await getCustomerExport(accessToken)
    } catch (error) {
      const failure = readCustomerMutationFailure(error)
      setErrorKey(failure.status === 403
        ? resolveCustomerMutationErrorKey(failure)
        : 'customers.export.error')
      return undefined
    } finally {
      setIsExporting(false)
    }
  }, [accessToken, enabled])
  return { errorKey, exportCustomers, isExporting }
}
