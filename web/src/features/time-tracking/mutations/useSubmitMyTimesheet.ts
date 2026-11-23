import type { MyTimesheetSubmitRequest } from '@mukuroji/contracts'
import { useCallback, useState } from 'react'
import { createMutationRequestRunner } from '../../../shared/api/mutationHeaders'
import { submitMyTimesheet } from '../api/myTimesheet'
import type { MyTimesheetSubmitNotice } from '../model/myTimesheetSubmitNotice'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/**
 * Submits the caller's drafts of every Team in a period, once at a time, and reports the outcome.
 *
 * A retry after a lost connection reuses the same idempotency key for each batch. With nothing to
 * submit, no request is sent. Every time tracking query is refreshed afterwards, whether the
 * submission succeeded or not.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @returns Submission state, outcome, and the submit and clear actions.
 */
export function useSubmitMyTimesheet(accessToken: string | undefined) {
  const refresh = useRefreshTimeTrackingQueries()
  const [runner] = useState(createMutationRequestRunner)
  const [isSubmitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<MyTimesheetSubmitNotice>()
  const submit = useCallback(async (request: MyTimesheetSubmitRequest) => {
    if (!accessToken || isSubmitting) return
    if (request.entries.length === 0) {
      setNotice({ kind: 'nothing' })
      return
    }
    setSubmitting(true)
    setNotice(undefined)
    try {
      // The server takes at most 500 entries per request, so larger weeks go in batches. Each
      // batch keeps its own retry identity, and a failed batch counts its entries as failed.
      let count = 0
      let failed = 0
      let partialFailure = false
      let failedBatches = 0
      const batches = splitIntoBatches(request.entries, MY_TIMESHEET_SUBMIT_BATCH_SIZE)
      for (const [index, entries] of batches.entries()) {
        const batch = { from: request.from, to: request.to, entries }
        try {
          const result = await runner.run(
            `my-timesheet:submit:${index}`,
            JSON.stringify(batch),
            (context) => submitMyTimesheet(accessToken, batch, context),
          )
          count += result.count
          // A Team that could not be processed lists every entry it was sent as failed.
          failed += result.failedEntryIds.length
          partialFailure ||= result.partialFailure
        } catch {
          failedBatches += 1
          failed += entries.length
          partialFailure = true
        }
      }
      setNotice(failedBatches === batches.length
        ? { kind: 'error' }
        : partialFailure
          ? { kind: 'partial', count, failed }
          : count === 0 ? { kind: 'nothing' } : { kind: 'submitted', count })
    } catch {
      setNotice({ kind: 'error' })
    } finally {
      // Stay busy until the timesheet is read again, so a second click cannot send the entries
      // just submitted at their old revisions.
      try {
        await refresh()
      } finally {
        setSubmitting(false)
      }
    }
  }, [accessToken, isSubmitting, refresh, runner])
  const clearNotice = useCallback(() => setNotice(undefined), [])
  return { isSubmitting, notice, submit, clearNotice }
}

/** Most entries one cross-Team submit request may name, matching the server limit. */
const MY_TIMESHEET_SUBMIT_BATCH_SIZE = 500

/**
 * Splits items into consecutive batches of at most a given size.
 *
 * @param items - Items to split.
 * @param size - Largest batch size.
 * @returns The batches in order.
 */
function splitIntoBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size))
  return batches
}
