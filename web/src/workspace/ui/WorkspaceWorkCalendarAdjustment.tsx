import { useMemo, useRef, useState } from 'react'
import {
  DEFAULT_WORK_CALENDAR_ADJUSTMENT,
  type WorkCalendarAdjustment,
  type WorkCalendarChangeImpact,
  type WorkCalendarChangeResult,
  type WorkspaceCalendarSettings,
  type WorkspaceCalendarSettingsResponse,
} from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { createMutationRequestContext, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { applyWorkspaceWorkCalendar, previewWorkspaceWorkCalendarChange } from '../api/workCalendar'
import { useWorkspaceCalendarSettings } from '../queries/useWorkspaceCalendarSettings'
import {
  WorkCalendarAdjustmentFields,
  WorkCalendarImpactSummary,
  WorkCalendarResultSummary,
} from './WorkCalendarPanel'

/** Props of the Workspace calendar adjustment section. */
export type WorkspaceWorkCalendarAdjustmentProps = {
  /** Session access token of a Workspace administrator. */
  accessToken: string
  /** Locale of the section. */
  locale: Locale
}

/**
 * Adjusts the Work Items that follow the shared calendar to the saved Workspace calendar.
 *
 * After the Workspace calendar is saved, an administrator previews which Work Items change and
 * applies it, keeping either their working days or their end dates (ADR 0058).
 *
 * @param props - Authentication and locale.
 * @returns The adjustment section.
 */
export function WorkspaceWorkCalendarAdjustment({ accessToken, locale }: WorkspaceWorkCalendarAdjustmentProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const calendar = useWorkspaceCalendarSettings(accessToken)
  const [adjustment, setAdjustment] = useState<WorkCalendarAdjustment>(DEFAULT_WORK_CALENDAR_ADJUSTMENT)
  const [impact, setImpact] = useState<WorkCalendarChangeImpact>()
  const [result, setResult] = useState<WorkCalendarChangeResult>()
  const [failed, setFailed] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const applyContext = useRef<MutationRequestContext | undefined>(undefined)

  /** Previews the adjustment against the saved Workspace calendar. */
  async function preview() {
    const settings = calendar.settings
    if (!settings) return
    setIsBusy(true)
    setFailed(false)
    setResult(undefined)
    try {
      setImpact(await previewWorkspaceWorkCalendarChange(accessToken, {
        calendar: toWorkspaceCalendarSettings(settings),
        adjustment,
      }))
    } catch {
      setFailed(true)
    } finally {
      setIsBusy(false)
    }
  }

  /** Applies the previewed adjustment. */
  async function apply() {
    setIsBusy(true)
    setFailed(false)
    applyContext.current ??= createMutationRequestContext()
    try {
      setResult(await applyWorkspaceWorkCalendar(accessToken, { adjustment }, applyContext.current))
      applyContext.current = undefined
      setImpact(undefined)
    } catch {
      setFailed(true)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <section className="workbench-panel grid gap-3 p-5" data-testid="workspace-work-calendar-adjustment">
      <header className="grid gap-1">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">
          {t('workspace.workCalendar.workspaceTitle')}
        </h2>
        <p className="text-sm text-[var(--workbench-muted)]">{t('workspace.workCalendar.workspaceDescription')}</p>
      </header>
      <WorkCalendarAdjustmentFields
        adjustment={adjustment}
        disabled={isBusy}
        onChange={(next) => {
          setAdjustment(next)
          setImpact(undefined)
          setResult(undefined)
          applyContext.current = undefined
        }}
        t={t}
      />
      <div className="flex flex-wrap gap-2">
        <button
          className="workbench-button-secondary"
          data-testid="workspace-work-calendar-preview"
          disabled={isBusy || !calendar.settings}
          onClick={() => void preview()}
          type="button"
        >
          {t('workspace.workCalendar.preview')}
        </button>
        <button
          className="workbench-button-primary"
          data-testid="workspace-work-calendar-apply"
          disabled={isBusy || !impact}
          onClick={() => void apply()}
          type="button"
        >
          {t('workspace.workCalendar.apply')}
        </button>
      </div>
      {failed ? (
        <p className="text-sm text-[var(--workbench-danger)]" role="alert">{t('workspace.workCalendar.error.failed')}</p>
      ) : null}
      {impact ? <WorkCalendarImpactSummary impact={impact} t={t} /> : null}
      {result ? <WorkCalendarResultSummary result={result} t={t} /> : null}
    </section>
  )
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
