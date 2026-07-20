import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import type {
  NotificationChannels,
  NotificationFrequency,
  NotificationPreferences,
} from '../api'
import type { NotificationPreferencesController } from '../mutations/useNotifications'

const notificationChannelKeys = ['inApp', 'email', 'push'] as const satisfies readonly (keyof NotificationChannels)[]
const notificationFrequencyOptions = ['instant', 'hourly', 'daily', 'weekly'] as const satisfies readonly NotificationFrequency[]

/**
 * NotificationSettingsPanel の props です。
 */
export type NotificationSettingsPanelProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 保存済み設定と保存 action をまとめた controller です。
   */
  controller: NotificationPreferencesController
}

/**
 * channel、frequency、quiet hours を永続化する通知設定 UI です。
 */
export function NotificationSettingsPanel({
  controller,
  locale,
}: NotificationSettingsPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [draft, setDraft] = useState<NotificationPreferences | undefined>(
    controller.preferences ? clonePreferences(controller.preferences) : undefined,
  )

  if (controller.isLoading) {
    return (
      <section aria-label={t('workspace.settings.notificationTitle')} className="workbench-panel p-5" role="status">
        <div className="h-5 w-48 animate-pulse rounded bg-slate-200" />
        <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-slate-100" />
        <div className="mt-6 grid gap-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="h-14 animate-pulse rounded-lg bg-slate-100" key={index} />
          ))}
        </div>
      </section>
    )
  }

  if (controller.hasLoadError || !draft) {
    return (
      <section className="workbench-panel grid justify-items-start gap-3 p-5">
        <h2 className="text-lg font-semibold text-[var(--workbench-text)]">
          {t('workspace.settings.notificationTitle')}
        </h2>
        <p className="text-sm font-medium text-red-700">
          {t('workspace.settings.notifications.loadError')}
        </p>
        <button
          className="workbench-button-secondary min-h-10 px-4"
          onClick={() => void controller.refresh()}
          type="button"
        >
          {t('workspace.settings.notifications.retry')}
        </button>
      </section>
    )
  }

  return (
    <form
      className="workbench-panel overflow-hidden"
      data-testid="notification-settings"
      onSubmit={(event) => {
        event.preventDefault()
        void controller.save(draft)
      }}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-[var(--workbench-border)] px-5 py-5">
        <div className="min-w-0 max-w-[680px]">
          <p className="workbench-eyebrow">{t('workspace.settings.notifications.eyebrow')}</p>
          <h2 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
            {t('workspace.settings.notificationTitle')}
          </h2>
          <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workspace.settings.notificationDescription')}
          </p>
        </div>
        <span className="workbench-badge-primary">
          {t('workspace.settings.notifications.version').replace('{version}', String(draft.version))}
        </span>
      </div>

      <div className="grid gap-0 divide-y divide-[var(--workbench-border)]">
        <fieldset className="grid gap-4 px-5 py-5">
          <legend className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('workspace.settings.notifications.channelsTitle')}
          </legend>
          <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workspace.settings.notifications.channelsDescription')}
          </p>
          <div className="grid gap-2">
            {notificationChannelKeys.map((channel) => (
              <label
                className="flex min-w-0 items-center justify-between gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3 transition hover:border-[#99d7cf]"
                key={channel}
              >
                <span className="min-w-0">
                  <strong className="block text-sm font-semibold text-[var(--workbench-text)]">
                    {t(`workspace.settings.notifications.channel.${channel}`)}
                  </strong>
                  <span className="mt-1 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                    {t(`workspace.settings.notifications.channel.${channel}Description`)}
                  </span>
                </span>
                <input
                  checked={draft.channels[channel]}
                  className="h-5 w-5 flex-none accent-[var(--workbench-primary)]"
                  data-testid={`notification-channel-${channel}`}
                  type="checkbox"
                  onChange={(event) => setDraft((current) => current ? {
                    ...current,
                    channels: {
                      ...current.channels,
                      [channel]: event.target.checked,
                    },
                  } : current)}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <label className="flex min-w-0 flex-wrap items-center justify-between gap-4 px-5 py-5">
          <span className="min-w-0 max-w-[640px]">
            <strong className="block text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.settings.notifications.frequencyTitle')}
            </strong>
            <span className="mt-1 block text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t('workspace.settings.notifications.frequencyDescription')}
            </span>
          </span>
          <select
            className="workbench-input min-h-10 min-w-[180px] px-3"
            data-testid="notification-frequency"
            value={draft.frequency}
            onChange={(event) => setDraft((current) => current ? {
              ...current,
              frequency: readNotificationFrequency(event.target.value),
            } : current)}
          >
            {notificationFrequencyOptions.map((frequency) => (
              <option key={frequency} value={frequency}>
                {t(`workspace.settings.notifications.frequency.${frequency}`)}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="grid gap-4 px-5 py-5">
          <legend className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('workspace.settings.notifications.quietHoursTitle')}
          </legend>
          <label className="flex min-w-0 items-center justify-between gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3">
            <span className="min-w-0">
              <strong className="block text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.settings.notifications.quietHoursToggle')}
              </strong>
              <span className="mt-1 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {t('workspace.settings.notifications.quietHoursDescription')}
              </span>
            </span>
            <input
              checked={draft.quietHours.enabled}
              className="h-5 w-5 flex-none accent-[var(--workbench-primary)]"
              data-testid="notification-quiet-hours-enabled"
              type="checkbox"
              onChange={(event) => setDraft((current) => current ? {
                ...current,
                quietHours: {
                  ...current.quietHours,
                  enabled: event.target.checked,
                },
              } : current)}
            />
          </label>
          <div className="grid grid-cols-[repeat(2,minmax(130px,180px))_minmax(220px,1fr)] gap-3 max-[760px]:grid-cols-1">
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {t('workspace.settings.notifications.quietHoursStart')}
              <input
                className="workbench-input min-h-10 px-3 normal-case tracking-normal disabled:bg-slate-100"
                data-testid="notification-quiet-hours-start"
                disabled={!draft.quietHours.enabled}
                type="time"
                value={draft.quietHours.start}
                onChange={(event) => updateQuietHours(setDraft, 'start', event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {t('workspace.settings.notifications.quietHoursEnd')}
              <input
                className="workbench-input min-h-10 px-3 normal-case tracking-normal disabled:bg-slate-100"
                data-testid="notification-quiet-hours-end"
                disabled={!draft.quietHours.enabled}
                type="time"
                value={draft.quietHours.end}
                onChange={(event) => updateQuietHours(setDraft, 'end', event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              {t('workspace.settings.notifications.timeZone')}
              <input
                className="workbench-input min-h-10 px-3 normal-case tracking-normal disabled:bg-slate-100"
                data-testid="notification-time-zone"
                disabled={!draft.quietHours.enabled}
                placeholder="Asia/Tokyo"
                type="text"
                value={draft.quietHours.timeZone}
                onChange={(event) => updateQuietHours(setDraft, 'timeZone', event.target.value)}
              />
            </label>
          </div>
        </fieldset>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
        <p aria-live="polite" className="text-sm font-semibold">
          {controller.hasSaveError ? (
            <span className="text-red-700">{t('workspace.settings.notifications.saveError')}</span>
          ) : controller.didSave ? (
            <span className="text-emerald-700">{t('workspace.settings.notifications.saved')}</span>
          ) : (
            <span className="text-[var(--workbench-muted)]">{t('workspace.settings.notifications.saveHint')}</span>
          )}
        </p>
        <button
          className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="notification-settings-save"
          disabled={controller.isSaving}
          type="submit"
        >
          {t(controller.isSaving
            ? 'workspace.settings.notifications.saving'
            : 'workspace.settings.notifications.save')}
        </button>
      </div>
    </form>
  )
}

function clonePreferences(preferences: NotificationPreferences): NotificationPreferences {
  return {
    ...preferences,
    channels: { ...preferences.channels },
    quietHours: { ...preferences.quietHours },
  }
}

function readNotificationFrequency(value: string): NotificationFrequency {
  return notificationFrequencyOptions.find((frequency) => frequency === value) ?? 'instant'
}

function updateQuietHours(
  setDraft: Dispatch<SetStateAction<NotificationPreferences | undefined>>,
  key: 'end' | 'start' | 'timeZone',
  value: string,
) {
  setDraft((current) => current ? {
    ...current,
    quietHours: {
      ...current.quietHours,
      [key]: value,
    },
  } : current)
}
