import { useState } from 'react'
import type { TeamWorkItemKeyPrefixSettings } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { readWorkItemKeyPrefixInput } from '../model/workItemKeys'

/** Outcome of the last prefix change. */
export type WorkItemKeyPrefixSaveResult = 'saved' | 'taken' | 'conflict' | 'error'

/** Team the panel can switch to. */
export type WorkItemKeyPrefixTeamOption = {
  /** Team ID. */
  id: string
  /** Team name. */
  name: string
}

/** Props of {@link WorkItemKeyPrefixPanel}. */
export type WorkItemKeyPrefixPanelProps = {
  /** Teams the operator can pick. */
  teams: readonly WorkItemKeyPrefixTeamOption[]
  /** Selected Team ID. */
  teamId: string | undefined
  /** Switches the selected Team. */
  onSelectTeam: (teamId: string) => void
  /** Loaded setting of the selected Team. */
  settings?: TeamWorkItemKeyPrefixSettings
  /** Whether the setting is loading. */
  isLoading: boolean
  /** Whether the setting failed to load. */
  hasLoadError: boolean
  /** Reloads the setting. */
  onRetry: () => void
  /** Prefix choices made from the Team's Project codes. */
  projectCodeChoices: readonly string[]
  /** Whether a change is running. */
  isSaving: boolean
  /** Outcome of the last change of the selected Team. */
  saveResult?: WorkItemKeyPrefixSaveResult
  /** Saves a new prefix against the loaded one. */
  onSave: (keyPrefix: string) => void
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Shows and changes the key prefix of a Team's new Work Items. Team managers change it; other
 * members see it read-only.
 *
 * @param props - Teams, loaded setting, choices, save state, and actions.
 * @returns The panel.
 */
export function WorkItemKeyPrefixPanel(props: WorkItemKeyPrefixPanelProps) {
  const { settings, t } = props
  return (
    <section aria-labelledby="work-item-key-prefix-title" className="workbench-panel overflow-hidden" data-testid="work-item-key-prefix">
      <div className="grid gap-2 border-b border-[var(--workbench-border)] px-5 py-5">
        <h2 className="text-lg font-semibold text-[var(--workbench-text)]" id="work-item-key-prefix-title">{t('issues.keyPrefix.title')}</h2>
        <p className="max-w-[720px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('issues.keyPrefix.description').replace('{example}', `${settings?.keyPrefix ?? settings?.suggestedKeyPrefix ?? 'PT'}-12`)}
        </p>
        <label className="grid max-w-xs gap-1 text-sm font-semibold text-[var(--workbench-text)]">
          {t('issues.keyPrefix.team')}
          <select
            className="workbench-input min-h-10 px-3"
            data-testid="work-item-key-prefix-team"
            onChange={(event) => props.onSelectTeam(event.target.value)}
            value={props.teamId ?? ''}
          >
            {props.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </label>
      </div>
      {props.isLoading ? (
        <div className="px-5 py-5" role="status">
          <div className="h-16 animate-pulse rounded-lg bg-slate-100" />
        </div>
      ) : props.hasLoadError || !settings ? (
        <div className="grid justify-items-start gap-3 px-5 py-5">
          <p className="text-sm font-medium text-fg-red-700">{t('issues.keyPrefix.loadError')}</p>
          <button className="workbench-button-secondary min-h-10 px-4" onClick={props.onRetry} type="button">
            {t('issues.keyPrefix.retry')}
          </button>
        </div>
      ) : (
        <WorkItemKeyPrefixForm {...props} key={`${settings.teamId}:${settings.keyPrefix ?? ''}`} settings={settings} />
      )}
    </section>
  )
}

/**
 * Form for one loaded prefix; it remounts when a change or reload loads another prefix.
 *
 * @param props - Panel props with the loaded setting.
 * @returns The form.
 */
function WorkItemKeyPrefixForm(props: WorkItemKeyPrefixPanelProps & { settings: TeamWorkItemKeyPrefixSettings }) {
  const { settings, t } = props
  const [draft, setDraft] = useState('')
  const [isInvalid, setIsInvalid] = useState(false)
  const status = isInvalid
    ? { className: 'text-fg-red-700', key: 'issues.keyPrefix.invalid' as const }
    : props.saveResult === 'saved'
      ? { className: 'text-fg-emerald-700', key: 'issues.keyPrefix.saved' as const }
      : props.saveResult
        ? { className: 'text-fg-red-700', key: `issues.keyPrefix.${props.saveResult === 'error' ? 'saveError' : props.saveResult}` as const }
        : undefined
  const choices = props.projectCodeChoices.filter((choice) => choice !== settings.keyPrefix)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const keyPrefix = readWorkItemKeyPrefixInput(draft)
        setIsInvalid(!keyPrefix)
        if (keyPrefix) props.onSave(keyPrefix)
      }}
    >
      <dl className="grid gap-3 px-5 py-5 text-sm sm:grid-cols-2">
        <div className="grid gap-1">
          <dt className="font-semibold text-[var(--workbench-muted)]">{t('issues.keyPrefix.current')}</dt>
          <dd className="font-mono text-base font-semibold text-[var(--workbench-text)]" data-testid="work-item-key-prefix-current">
            {settings.keyPrefix ?? t('issues.keyPrefix.unassigned').replace('{prefix}', `${settings.suggestedKeyPrefix ?? ''}-1`)}
          </dd>
        </div>
        {settings.previousPrefixes.length > 0 ? (
          <div className="grid gap-1">
            <dt className="font-semibold text-[var(--workbench-muted)]">{t('issues.keyPrefix.previous')}</dt>
            <dd className="font-mono text-[var(--workbench-text)]">{settings.previousPrefixes.join(', ')}</dd>
          </div>
        ) : null}
      </dl>
      {settings.canManage ? (
        <div className="grid gap-3 border-t border-[var(--workbench-border)] px-5 py-5">
          <label className="grid max-w-xs gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.keyPrefix.input')}
            <input
              aria-describedby="work-item-key-prefix-hint"
              aria-invalid={isInvalid || undefined}
              autoCapitalize="characters"
              className="workbench-input min-h-10 px-3 font-mono uppercase"
              data-testid="work-item-key-prefix-input"
              disabled={props.isSaving}
              maxLength={10}
              onChange={(event) => setDraft(event.target.value)}
              value={draft}
            />
            <span className="text-xs font-medium text-[var(--workbench-muted)]" id="work-item-key-prefix-hint">{t('issues.keyPrefix.hint')}</span>
          </label>
          {choices.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-[var(--workbench-muted)]">{t('issues.keyPrefix.fromProjectCode')}</span>
              {choices.map((choice) => (
                <button
                  aria-pressed={draft.trim().toUpperCase() === choice}
                  className="workbench-button-secondary min-h-9 px-3 font-mono text-xs max-[760px]:min-h-[44px]"
                  disabled={props.isSaving}
                  key={choice}
                  onClick={() => { setDraft(choice); setIsInvalid(false) }}
                  type="button"
                >
                  {choice}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="border-t border-[var(--workbench-border)] px-5 py-4 text-sm font-semibold text-[var(--workbench-muted)]">{t('issues.keyPrefix.readOnly')}</p>
      )}
      {settings.canManage ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <p aria-live="polite" className="text-sm font-semibold">
            {status ? <span className={status.className}>{t(status.key)}</span> : null}
          </p>
          <button
            className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
            data-testid="work-item-key-prefix-save"
            disabled={props.isSaving || draft.trim() === ''}
            type="submit"
          >
            {t(props.isSaving ? 'issues.keyPrefix.saving' : 'issues.keyPrefix.save')}
          </button>
        </div>
      ) : null}
    </form>
  )
}
