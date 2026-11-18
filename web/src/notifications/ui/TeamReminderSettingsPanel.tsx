import { useState } from 'react'
import {
  NOTIFICATION_REMINDER_DAY_FIELDS,
  type TeamNotificationReminderSettings,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { TeamReminderSettingsController } from '../mutations/useTeamReminderSettings'
import { createReminderDaysDraft, readReminderDaysDraft } from '../model/reminderDays'
import { ReminderDaysFields } from './ReminderDaysFields'

/** Props of {@link TeamReminderSettingsPanel}. */
export type TeamReminderSettingsPanelProps = {
  /** Loaded settings and save action. */
  controller: TeamReminderSettingsController
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Shows a Team's reminder day settings. Team managers edit them; other members see them
 * read-only. A blank field uses the deployment default named in its placeholder.
 *
 * @param props - Controller and translator.
 * @returns The panel.
 */
export function TeamReminderSettingsPanel({ controller, t }: TeamReminderSettingsPanelProps) {
  const settings = controller.settings
  if (controller.isLoading) {
    return (
      <section aria-label={t('workspace.teamReminders.title')} className="workbench-panel p-5" role="status">
        <div className="h-5 w-48 animate-pulse rounded bg-slate-200" />
        <div className="mt-4 h-24 animate-pulse rounded-lg bg-slate-100" />
      </section>
    )
  }
  if (controller.hasLoadError || !settings) {
    return (
      <section className="workbench-panel grid justify-items-start gap-3 p-5">
        <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{t('workspace.teamReminders.title')}</h2>
        <p className="text-sm font-medium text-fg-red-700">{t('workspace.teamReminders.loadError')}</p>
        <button
          className="workbench-button-secondary min-h-10 px-4"
          onClick={() => void controller.refresh()}
          type="button"
        >
          {t('workspace.teamReminders.retry')}
        </button>
      </section>
    )
  }
  return (
    <TeamReminderSettingsForm
      controller={controller}
      key={`${settings.teamId}:${settings.revision}`}
      settings={settings}
      t={t}
    />
  )
}

/**
 * Editable form for one loaded revision; it remounts when a save or reload changes the revision.
 *
 * @param props - Controller, loaded settings, and translator.
 * @returns The form.
 */
function TeamReminderSettingsForm({
  controller,
  settings,
  t,
}: TeamReminderSettingsPanelProps & { settings: TeamNotificationReminderSettings }) {
  const [draft, setDraft] = useState(() => createReminderDaysDraft(NOTIFICATION_REMINDER_DAY_FIELDS, settings.days))
  const [isInvalid, setIsInvalid] = useState(false)
  const status = isInvalid
    ? { className: 'text-fg-red-700', key: 'workspace.reminders.invalid' as const }
    : controller.saveResult === 'conflict'
      ? { className: 'text-fg-red-700', key: 'workspace.teamReminders.conflict' as const }
      : controller.saveResult === 'error'
        ? { className: 'text-fg-red-700', key: 'workspace.teamReminders.saveError' as const }
        : controller.saveResult === 'saved'
          ? { className: 'text-fg-emerald-700', key: 'workspace.teamReminders.saved' as const }
          : undefined

  return (
    <form
      className="workbench-panel overflow-hidden"
      data-testid="team-reminder-settings"
      onSubmit={(event) => {
        event.preventDefault()
        const days = readReminderDaysDraft(NOTIFICATION_REMINDER_DAY_FIELDS, draft)
        setIsInvalid(!days)
        if (days) void controller.save(days)
      }}
    >
      <div className="grid gap-2 border-b border-[var(--workbench-border)] px-5 py-5">
        <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{t('workspace.teamReminders.title')}</h2>
        <p className="max-w-[720px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('workspace.teamReminders.description')}
        </p>
        {settings.canManage ? null : (
          <p className="text-sm font-semibold text-[var(--workbench-muted)]">{t('workspace.teamReminders.readOnly')}</p>
        )}
      </div>
      <div className="px-5 py-5">
        <ReminderDaysFields
          disabled={!settings.canManage}
          draft={draft}
          fields={NOTIFICATION_REMINDER_DAY_FIELDS}
          placeholderFor={(field) =>
            t('workspace.reminders.defaultValue').replace('{days}', String(settings.defaults[field]))}
          t={t}
          testIdPrefix="team-reminder"
          onChange={(field, value) => setDraft((current) => ({ ...current, [field]: value }))}
        />
      </div>
      {settings.canManage ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <p aria-live="polite" className="text-sm font-semibold">
            {status ? <span className={status.className}>{t(status.key)}</span> : null}
          </p>
          <button
            className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
            data-testid="team-reminder-settings-save"
            disabled={controller.isSaving}
            type="submit"
          >
            {t(controller.isSaving ? 'workspace.teamReminders.saving' : 'workspace.teamReminders.save')}
          </button>
        </div>
      ) : null}
    </form>
  )
}
