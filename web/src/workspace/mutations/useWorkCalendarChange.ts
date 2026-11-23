import { useRef, useState } from 'react'
import type {
  WorkCalendarChangeImpact,
  SaveWorkCalendarInput,
  WorkCalendarChangeInput,
  WorkCalendarChangeResult,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createMutationRequestContext, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { previewWorkCalendarChange, saveWorkCalendar } from '../api/workCalendar'
import { WorkspaceAccessApiError } from '../api/errors'

/** Preview and save state of a Team or Project calendar change. */
export type WorkCalendarChangeController = {
  /** Impact of the drafted change, once previewed. */
  impact: WorkCalendarChangeImpact | undefined
  /** Result of the latest save. */
  result: WorkCalendarChangeResult | undefined
  /** Message key of the latest failed preview or save. */
  errorKey: MessageKey | undefined
  /** Whether a preview or save is running. */
  isBusy: boolean
  /** Previews a change without saving it. */
  preview: (teamId: string, input: WorkCalendarChangeInput) => Promise<void>
  /** Saves the previewed change; reports whether it was saved. */
  save: (teamId: string, input: SaveWorkCalendarInput) => Promise<boolean>
  /** Drops the preview, result, and error, and any reply still on its way. */
  reset: () => void
}

/**
 * Previews and saves a Team or Project calendar change, then revalidates the calendar read (ADR 0058).
 *
 * A retried save keeps its idempotency key until it succeeds or the outcome is reset, and a reply to a
 * request made before the last reset is dropped.
 *
 * @param accessToken - Session access token.
 * @param revalidate - Revalidates the calendar query after a save.
 * @returns The change controller.
 */
export function useWorkCalendarChange(
  accessToken: string,
  revalidate: () => Promise<unknown>,
): WorkCalendarChangeController {
  const [impact, setImpact] = useState<WorkCalendarChangeImpact>()
  const [result, setResult] = useState<WorkCalendarChangeResult>()
  const [errorKey, setErrorKey] = useState<MessageKey>()
  const [isBusy, setIsBusy] = useState(false)
  const saveContext = useRef<MutationRequestContext | undefined>(undefined)
  /** Changes whenever the outcome is reset, so a reply to an earlier request is dropped. */
  const requestGeneration = useRef(0)

  /** Drops the outcome. */
  function reset() {
    requestGeneration.current += 1
    setImpact(undefined)
    setResult(undefined)
    setErrorKey(undefined)
    saveContext.current = undefined
  }

  /**
   * Previews a change.
   *
   * @param teamId - Team of the calendar.
   * @param input - Drafted change.
   */
  async function preview(teamId: string, input: WorkCalendarChangeInput) {
    const generation = requestGeneration.current
    setIsBusy(true)
    setErrorKey(undefined)
    try {
      const previewed = await previewWorkCalendarChange(accessToken, teamId, input)
      if (generation === requestGeneration.current) setImpact(previewed)
    } catch (error) {
      if (generation === requestGeneration.current) setErrorKey(readWorkCalendarErrorKey(error))
    } finally {
      setIsBusy(false)
    }
  }

  /**
   * Saves a change.
   *
   * @param teamId - Team of the calendar.
   * @param input - Previewed change with the revision it was drafted from.
   * @returns Whether it was saved.
   */
  async function save(teamId: string, input: SaveWorkCalendarInput): Promise<boolean> {
    const generation = requestGeneration.current
    setIsBusy(true)
    setErrorKey(undefined)
    saveContext.current ??= createMutationRequestContext()
    try {
      const saved = await saveWorkCalendar(accessToken, teamId, input, saveContext.current)
      // The calendar was saved either way, so the read is refreshed even after a reset.
      await revalidate()
      // A reply to a save made before the last reset must not change the reset draft.
      if (generation !== requestGeneration.current) return false
      saveContext.current = undefined
      setResult(saved)
      setImpact(undefined)
      return true
    } catch (error) {
      if (generation === requestGeneration.current) setErrorKey(readWorkCalendarErrorKey(error))
      return false
    } finally {
      setIsBusy(false)
    }
  }

  return { impact, result, errorKey, isBusy, preview, save, reset }
}

/**
 * Picks the message of a failed calendar request.
 *
 * @param error - Thrown error.
 * @returns The message key for the member.
 */
export function readWorkCalendarErrorKey(error: unknown): MessageKey {
  if (error instanceof WorkspaceAccessApiError) {
    if (error.status === 409) return 'workspace.workCalendar.error.conflict'
    if (error.status === 413) return 'workspace.workCalendar.error.tooLarge'
    if (error.status === 403) return 'workspace.workCalendar.error.forbidden'
  }
  return 'workspace.workCalendar.error.failed'
}
