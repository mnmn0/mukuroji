import { useMemo } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import type { PushDeviceController } from '../mutations/usePushDevice'

/** Props of the push device settings card. */
export type PushDeviceSettingsProps = {
  /** Display locale. */
  locale: Locale
  /** Device status and actions. */
  controller: PushDeviceController
}

/**
 * Lets the member turn push notifications on or off for this device.
 *
 * The action button stays mounted and focusable while a request runs, and the outcome is
 * announced in a polite live region.
 *
 * @param props - Locale and controller.
 * @returns The settings card.
 */
export function PushDeviceSettings({ controller, locale }: PushDeviceSettingsProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { pending, result, status } = controller
  const canToggle = status === 'on' || status === 'off'

  return (
    <section
      aria-busy={status === 'loading' || pending}
      aria-labelledby="push-device-settings-title"
      className="workbench-panel grid gap-4 p-5"
      data-testid="push-device-settings"
    >
      <div className="min-w-0 max-w-[680px]">
        <h2 className="text-lg font-semibold text-[var(--workbench-text)]" id="push-device-settings-title">
          {t('workspace.settings.notifications.pushDevice.title')}
        </h2>
        <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('workspace.settings.notifications.pushDevice.description')}
        </p>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3">
        <p
          className={status === 'load-error' ? 'text-sm font-semibold text-fg-red-700' : 'text-sm font-semibold text-[var(--workbench-text)]'}
          data-testid="push-device-status"
          role={status === 'loading' ? 'status' : undefined}
        >
          {t(`workspace.settings.notifications.pushDevice.${status === 'load-error' ? 'loadError' : status}`)}
        </p>
        {canToggle ? (
          <button
            aria-disabled={pending}
            className={status === 'on'
              ? 'workbench-button-secondary min-h-10 px-4 aria-disabled:cursor-not-allowed aria-disabled:opacity-55'
              : 'workbench-button-primary min-h-10 px-4 aria-disabled:cursor-not-allowed aria-disabled:opacity-55'}
            data-testid="push-device-toggle"
            onClick={() => {
              if (pending) return
              if (status === 'on') controller.disable()
              else controller.enable()
            }}
            type="button"
          >
            {t(pending
              ? 'workspace.settings.notifications.pushDevice.pending'
              : status === 'on'
                ? 'workspace.settings.notifications.pushDevice.disable'
                : 'workspace.settings.notifications.pushDevice.enable')}
          </button>
        ) : status === 'load-error' ? (
          <button
            className="workbench-button-secondary min-h-10 px-4"
            onClick={controller.retry}
            type="button"
          >
            {t('workspace.settings.notifications.retry')}
          </button>
        ) : status === 'blocked' ? (
          // Permission is changed outside the app, so the person can check again after changing it.
          <button
            className="workbench-button-secondary min-h-10 px-4"
            data-testid="push-device-recheck"
            onClick={controller.retry}
            type="button"
          >
            {t('workspace.settings.notifications.pushDevice.recheck')}
          </button>
        ) : null}
      </div>

      <p aria-live="polite" className="min-h-5 text-sm font-semibold" data-testid="push-device-result">
        {result ? (
          <span className={result === 'enabled' || result === 'disabled' ? 'text-fg-emerald-700' : 'text-fg-red-700'}>
            {t(`workspace.settings.notifications.pushDevice.result.${result}`)}
          </span>
        ) : null}
      </p>
    </section>
  )
}
