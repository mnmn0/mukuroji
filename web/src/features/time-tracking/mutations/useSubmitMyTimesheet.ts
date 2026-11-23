import type { MyTimesheetSubmitRequest } from '@mukuroji/contracts'
import { useCallback, useState } from 'react'
import { createMutationRequestRunner } from '../../../shared/api/mutationHeaders'
import { submitMyTimesheet } from '../api/myTimesheet'
import type { MyTimesheetSubmitNotice } from '../ui/MyTimesheetPanel'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/**
 * Submits the caller's drafts of every Team in a period, once at a time, and reports the outcome.
 *
 * A retry after a lost connection reuses the same idempotency key. With nothing to submit, no
 * request is sent. Every time tracking query is
 * refreshed afterwards, whether the submission succeeded or not.
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
      const result = await runner.run(
        'my-timesheet:submit',
        JSON.stringify(request),
        (context) => submitMyTimesheet(accessToken, request, context),
      )
      // A Team that could not be processed lists every entry it was sent as failed.
      setNotice(result.partialFailure
        ? { kind: 'partial', count: result.count, failed: result.failedEntryIds.length }
        : result.count === 0 ? { kind: 'nothing' } : { kind: 'submitted', count: result.count })
    } catch {
      setNotice({ kind: 'error' })
    } finally {
      setSubmitting(false)
      await refresh()
    }
  }, [accessToken, isSubmitting, refresh, runner])
  const clearNotice = useCallback(() => setNotice(undefined), [])
  return { isSubmitting, notice, submit, clearNotice }
}
