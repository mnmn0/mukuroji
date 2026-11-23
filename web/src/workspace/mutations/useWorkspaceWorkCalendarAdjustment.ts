import { useRef, useState } from 'react'
import {
  DEFAULT_WORK_CALENDAR_ADJUSTMENT,
  type WorkCalendarAdjustment,
  type WorkCalendarChangeImpact,
  type WorkCalendarChangeResult,
  type WorkspaceCalendarSettings,
  type WorkspaceCalendarSettingsResponse,
} from '@mukuroji/contracts'
import { createMutationRequestContext, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { applyWorkspaceWorkCalendar, previewWorkspaceWorkCalendarChange } from '../api/workCalendar'
import { useWorkspaceCalendarSettings } from '../queries/useWorkspaceCalendarSettings'

/** Preview and apply state of the Workspace calendar adjustment. */
export type WorkspaceWorkCalendarAdjustmentController = {
  /** Chosen adjustment. */
  adjustment: WorkCalendarAdjustment
  /** Whether the saved Workspace calendar has loaded, so a preview can run. */
  canPreview: boolean
  /** Impact previewed for the current settings and adjustment. */
  impact: WorkCalendarChangeImpact | undefined
  /** Result of the latest apply. */
  result: WorkCalendarChangeResult | undefined
  /** Whether the latest preview or apply failed. */
  failed: boolean
  /** Whether the saved Workspace calendar could not be read, so nothing can be previewed. */
  loadFailed: boolean
  /** Reads the saved Workspace calendar again after a failed read. */
  retryLoad: () => void
  /** Whether a preview or apply is running. */
  isBusy: boolean
  /** Picks another adjustment and drops the outcome. */
  changeAdjustment: (adjustment: WorkCalendarAdjustment) => void
  /** Previews the adjustment against the saved Workspace calendar. */
  requestPreview: () => Promise<void>
  /** Applies the previewed adjustment. */
  apply: () => Promise<void>
}

/**
 * Previews and applies the saved Workspace calendar to the Work Items that follow it (ADR 0058).
 *
 * A preview stands only for the settings and adjustment it was made with, and a retried apply keeps
 * its idempotency key until it succeeds or the adjustment changes.
 *
 * @param accessToken - Session access token of a Workspace administrator.
 * @returns The adjustment controller.
 */
export function useWorkspaceWorkCalendarAdjustment(accessToken: string): WorkspaceWorkCalendarAdjustmentController {
  const calendar = useWorkspaceCalendarSettings(accessToken)
  const [adjustment, setAdjustment] = useState<WorkCalendarAdjustment>(DEFAULT_WORK_CALENDAR_ADJUSTMENT)
  const [preview, setPreview] = useState<PreviewedImpact>()
  const [result, setResult] = useState<WorkCalendarChangeResult>()
  const [failed, setFailed] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const applyContext = useRef<MutationRequestContext | undefined>(undefined)
  const currentKey = calendar.settings ? previewKey(calendar.settings, adjustment) : undefined
  // A preview only stands for the settings and adjustment it was made with.
  const impact = preview && preview.key === currentKey ? preview.impact : undefined

  /** Previews the adjustment against the saved Workspace calendar. */
  async function requestPreview() {
    const settings = calendar.settings
    if (!settings) return
    const key = previewKey(settings, adjustment)
    setIsBusy(true)
    setFailed(false)
    setResult(undefined)
    try {
      const previewed = await previewWorkspaceWorkCalendarChange(accessToken, {
        calendar: toWorkspaceCalendarSettings(settings),
        adjustment,
      })
      setPreview({ key, impact: previewed, calendar: toWorkspaceCalendarSettings(settings) })
    } catch {
      setFailed(true)
    } finally {
      setIsBusy(false)
    }
  }

  /** Applies the previewed adjustment. */
  async function apply() {
    // The server refuses the apply when the saved settings are no longer the previewed ones.
    const expectedCalendar = preview && preview.key === currentKey ? preview.calendar : undefined
    if (!expectedCalendar) return
    setIsBusy(true)
    setFailed(false)
    applyContext.current ??= createMutationRequestContext()
    try {
      setResult(await applyWorkspaceWorkCalendar(accessToken, { adjustment, expectedCalendar }, applyContext.current))
      applyContext.current = undefined
      setPreview(undefined)
    } catch {
      setFailed(true)
    } finally {
      setIsBusy(false)
    }
  }

  /**
   * Picks another adjustment and drops the outcome.
   *
   * @param next - Adjustment to use.
   */
  function changeAdjustment(next: WorkCalendarAdjustment) {
    setAdjustment(next)
    setPreview(undefined)
    setResult(undefined)
    applyContext.current = undefined
  }

  return {
    adjustment,
    canPreview: Boolean(calendar.settings),
    impact,
    result,
    failed,
    loadFailed: !calendar.settings && Boolean(calendar.error),
    retryLoad: calendar.retry,
    isBusy,
    changeAdjustment,
    requestPreview,
    apply,
  }
}

/** Preview of a Workspace calendar adjustment, bound to what it previewed. */
type PreviewedImpact = {
  /** Key of the settings and adjustment the preview was made with. */
  key: string
  /** Previewed impact. */
  impact: WorkCalendarChangeImpact
  /** Saved Workspace calendar settings the preview was made with. */
  calendar: WorkspaceCalendarSettings
}

/**
 * Builds the key that binds a preview to the saved settings, the synced national holidays, and the
 * chosen adjustment.
 *
 * @param settings - Saved Workspace calendar settings with the synced national holidays.
 * @param adjustment - Chosen adjustment.
 * @returns The key.
 */
function previewKey(settings: WorkspaceCalendarSettingsResponse, adjustment: WorkCalendarAdjustment): string {
  // The synced national holidays count too, since a Team or Project calendar may use them.
  return JSON.stringify([toWorkspaceCalendarSettings(settings), settings.nationalHolidayDates ?? null, adjustment])
}

/**
 * Drops the national holiday dates a settings response carries, leaving the stored settings.
 *
 * @param settings - Settings response.
 * @returns The Workspace calendar settings.
 */
function toWorkspaceCalendarSettings(settings: WorkspaceCalendarSettingsResponse): WorkspaceCalendarSettings {
  const { nationalHolidayDates, ...stored } = settings
  void nationalHolidayDates
  return stored
}
