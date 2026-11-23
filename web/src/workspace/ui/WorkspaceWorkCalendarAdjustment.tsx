import { useMemo } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { useWorkspaceWorkCalendarAdjustment } from '../mutations/useWorkspaceWorkCalendarAdjustment'
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
  const controller = useWorkspaceWorkCalendarAdjustment(accessToken)

  return (
    <section className="workbench-panel grid gap-3 p-5" data-testid="workspace-work-calendar-adjustment">
      <header className="grid gap-1">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">
          {t('workspace.workCalendar.workspaceTitle')}
        </h2>
        <p className="text-sm text-[var(--workbench-muted)]">{t('workspace.workCalendar.workspaceDescription')}</p>
      </header>
      {controller.loadFailed ? (
        <div
          className="flex flex-wrap items-center gap-2 text-sm text-[var(--workbench-danger)]"
          data-testid="workspace-work-calendar-load-error"
          role="alert"
        >
          <span>{t('workspace.workCalendar.error.load')}</span>
          <button className="workbench-button-secondary" onClick={controller.retryLoad} type="button">
            {t('workspace.workCalendar.retry')}
          </button>
        </div>
      ) : null}
      <WorkCalendarAdjustmentFields
        adjustment={controller.adjustment}
        disabled={controller.isBusy}
        onChange={controller.changeAdjustment}
        t={t}
      />
      <div className="flex flex-wrap gap-2">
        <button
          className="workbench-button-secondary"
          data-testid="workspace-work-calendar-preview"
          disabled={controller.isBusy || !controller.canPreview}
          onClick={() => void controller.requestPreview()}
          type="button"
        >
          {t('workspace.workCalendar.preview')}
        </button>
        <button
          className="workbench-button-primary"
          data-testid="workspace-work-calendar-apply"
          disabled={controller.isBusy || !controller.impact}
          onClick={() => void controller.apply()}
          type="button"
        >
          {t('workspace.workCalendar.apply')}
        </button>
      </div>
      {controller.failed ? (
        <p className="text-sm text-[var(--workbench-danger)]" role="alert">{t('workspace.workCalendar.error.failed')}</p>
      ) : null}
      {controller.impact ? <WorkCalendarImpactSummary impact={controller.impact} t={t} /> : null}
      {controller.result ? <WorkCalendarResultSummary result={controller.result} t={t} /> : null}
    </section>
  )
}
