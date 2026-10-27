import {
  AGENT_RUN_MAX_LEASE_MINUTES,
  AGENT_RUN_MIN_LEASE_MINUTES,
  AGENT_SETTINGS_BRIEF_MAX_BYTES,
  AGENT_SETTINGS_BRIEFS_MAX_TOTAL_BYTES,
  AGENT_SETTINGS_MAX_PROJECT_BRIEFS,
  AGENT_SETTINGS_MAX_READY_STATUSES,
  type AgentSettings,
} from '@mukuroji/contracts'
import { useId } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import {
  measureUtf8Bytes,
  toggleAgentReadyStatus,
  validateAgentSettingsDraft,
  type AgentAcceptanceCriteriaFieldOption,
  type AgentProjectBriefTarget,
  type AgentReadyStatusOption,
  type AgentSettingsDraft,
} from '../model/agentSettingsForm'
import type { AgentSettingsSaveFeedback } from '../mutations/useSaveTeamAgentSettings'

/** Team the operator can pick in the panel. */
export type AgentSettingsTeamOption = {
  /** Team ID. */
  id: string
  /** Team name. */
  name: string
}

/** Load state of the Team's workflow statuses and custom fields. */
export type AgentSettingsConfigurationState = 'loading' | 'error' | 'ready'

/** Props of the pure Agent settings panel. */
export type AgentSettingsPanelProps = {
  /** Locale used to format numbers and times. */
  locale: Locale
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Teams the operator can pick. */
  teamOptions: readonly AgentSettingsTeamOption[]
  /** Selected Team ID, if any Team exists. */
  selectedTeamId?: string
  /** Whether the selected Team's settings are being read for the first time. */
  isLoading: boolean
  /** Whether reading the selected Team's settings failed. */
  hasLoadError: boolean
  /** Settings as last read from the server. */
  settings?: AgentSettings
  /** Form values; present once settings are loaded. */
  draft?: AgentSettingsDraft
  /** Load state of the Team's workflow statuses and custom fields. */
  configurationState: AgentSettingsConfigurationState
  /** Statuses that may be marked as ready. */
  readyStatusOptions: readonly AgentReadyStatusOption[]
  /** Custom fields that may hold acceptance criteria. */
  acceptanceCriteriaFieldOptions: readonly AgentAcceptanceCriteriaFieldOption[]
  /** Projects that can carry their own brief. */
  projectBriefTargets: readonly AgentProjectBriefTarget[]
  /** Whether the operator may only review the settings. */
  readOnly: boolean
  /** Whether the draft differs from the loaded settings. */
  isDirty: boolean
  /** Whether a save is in flight. */
  isSaving: boolean
  /** Whether the settings changed on the server after the draft was started. */
  hasRevisionConflict: boolean
  /** Outcome of the latest save. */
  feedback?: AgentSettingsSaveFeedback
  /** Selects another Team. */
  onTeamChange: (teamId: string) => void
  /** Replaces the form values. */
  onDraftChange: (draft: AgentSettingsDraft) => void
  /** Saves the form values. */
  onSave: () => void
  /** Discards the form values and reads the latest settings. */
  onReload: () => void
  /** Reads the settings again after a failure. */
  onRetry: () => void
  /** Reads the Team's workflow statuses and custom fields again after a failure. */
  onConfigurationRetry: () => void
}

/**
 * Renders the Team Agent settings editor: lease, ready statuses, acceptance criteria, and briefs.
 *
 * @param props - Loaded settings, form values, options, state, and actions.
 * @returns The settings panel.
 */
export function AgentSettingsPanel({
  acceptanceCriteriaFieldOptions,
  configurationState,
  draft,
  feedback,
  hasLoadError,
  hasRevisionConflict,
  isDirty,
  isLoading,
  isSaving,
  locale,
  onConfigurationRetry,
  onDraftChange,
  onReload,
  onRetry,
  onSave,
  onTeamChange,
  projectBriefTargets,
  readOnly,
  readyStatusOptions,
  selectedTeamId,
  settings,
  t,
  teamOptions,
}: AgentSettingsPanelProps) {
  const idPrefix = useId()
  const numberFormat = new Intl.NumberFormat(locale)
  const validation = draft ? validateAgentSettingsDraft(draft) : undefined
  const disabled = readOnly || isSaving
  const leaseHelpId = `${idPrefix}-lease-help`
  const leaseErrorId = `${idPrefix}-lease-error`

  /**
   * Fills `{name}` placeholders of a message.
   *
   * @param key - Message key.
   * @param values - Placeholder values.
   * @returns The localized message.
   */
  const format = (key: MessageKey, values: Readonly<Record<string, string | number>>) =>
    Object.entries(values).reduce(
      (message, [name, value]) => message.replaceAll(`{${name}}`, typeof value === 'number' ? numberFormat.format(value) : value),
      t(key),
    )

  return (
    <section className="grid gap-5" data-testid="agent-settings-panel">
      <div className="workbench-toolbar grid grid-cols-[minmax(0,1fr)_minmax(240px,360px)] items-end gap-5 p-4 max-[760px]:grid-cols-1">
        <div className="min-w-0">
          <p className="workbench-eyebrow">{t('agentSettings.eyebrow')}</p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--workbench-text)]">{t('agentSettings.title')}</h2>
          <p className="mt-2 max-w-[760px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('agentSettings.description')}
          </p>
        </div>
        {teamOptions.length > 0 ? (
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('agentSettings.team')}
            <select
              className="workbench-input min-h-11 w-full min-w-0 px-3"
              data-testid="agent-settings-team"
              disabled={isSaving}
              value={selectedTeamId}
              onChange={(event) => onTeamChange(event.target.value)}
            >
              {teamOptions.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {teamOptions.length === 0 ? (
        <p className="workbench-panel p-6 text-center text-sm font-semibold text-[var(--workbench-muted)]">
          {t('agentSettings.noTeams')}
        </p>
      ) : isLoading && !settings ? (
        <div className="workbench-panel grid min-h-52 place-items-center p-6" role="status">
          <p className="text-sm font-semibold text-[var(--workbench-muted)]">{t('agentSettings.loading')}</p>
        </div>
      ) : !settings || !draft || !validation ? (
        <div className="workbench-panel grid justify-items-start gap-3 p-6">
          <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
            {t('agentSettings.loadError')}
          </p>
          <button className="workbench-button-secondary min-h-[44px] px-4" onClick={onRetry} type="button">
            {t('agentSettings.retry')}
          </button>
        </div>
      ) : (
        <div className="workbench-panel grid gap-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-7">
            <p className="text-sm font-medium text-[var(--workbench-muted)]">
              {settings.revision === 0
                ? t('agentSettings.defaults')
                : settings.updatedAt
                  ? format('agentSettings.updatedAt', {
                    time: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
                      .format(new Date(settings.updatedAt)),
                  })
                  : null}
            </p>
            <span className="workbench-badge">{format('agentSettings.revision', { revision: settings.revision })}</span>
          </div>
          {readOnly ? (
            <p className="border-t border-[var(--workbench-border)] px-5 py-3 text-sm font-medium text-[var(--workbench-muted)] sm:px-7" role="note">
              {t('agentSettings.readOnly')}
            </p>
          ) : null}
          {hasLoadError ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-[var(--workbench-border)] px-5 py-3 sm:px-7">
              <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">{t('agentSettings.loadError')}</p>
              <button className="workbench-button-secondary min-h-[44px] px-4" onClick={onRetry} type="button">
                {t('agentSettings.retry')}
              </button>
            </div>
          ) : null}

          <fieldset className="grid gap-4 border-t border-[var(--workbench-border)] px-5 py-6 sm:px-7" disabled={disabled}>
            <legend className="text-base font-semibold text-[var(--workbench-text)]">{t('agentSettings.lease.title')}</legend>
            <label className="grid max-w-xs gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('agentSettings.lease.minutes')}
              <input
                aria-describedby={validation.leaseMinutesValid ? leaseHelpId : `${leaseHelpId} ${leaseErrorId}`}
                aria-invalid={!validation.leaseMinutesValid || undefined}
                className="workbench-input min-h-11 px-3"
                inputMode="numeric"
                max={AGENT_RUN_MAX_LEASE_MINUTES}
                min={AGENT_RUN_MIN_LEASE_MINUTES}
                step={1}
                type="number"
                value={draft.leaseMinutes}
                onChange={(event) => onDraftChange({ ...draft, leaseMinutes: event.target.value })}
              />
            </label>
            <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]" id={leaseHelpId}>
              {format('agentSettings.lease.help', { min: AGENT_RUN_MIN_LEASE_MINUTES, max: AGENT_RUN_MAX_LEASE_MINUTES })}
            </p>
            {validation.leaseMinutesValid ? null : (
              <p className="text-xs font-semibold text-[var(--workbench-danger)]" id={leaseErrorId}>
                {format('agentSettings.lease.invalid', { min: AGENT_RUN_MIN_LEASE_MINUTES, max: AGENT_RUN_MAX_LEASE_MINUTES })}
              </p>
            )}
            <label className="flex min-h-[44px] items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
              <input
                checked={draft.allowTakeoverAfterLeaseExpiry}
                className="h-5 w-5 accent-[var(--workbench-primary)]"
                type="checkbox"
                onChange={(event) => onDraftChange({ ...draft, allowTakeoverAfterLeaseExpiry: event.target.checked })}
              />
              {t('agentSettings.lease.takeover')}
            </label>
          </fieldset>

          <div className="border-t border-[var(--workbench-border)] px-5 py-6 sm:px-7">
            {configurationState === 'loading' ? (
              <p className="text-sm font-semibold text-[var(--workbench-muted)]" role="status">
                {t('agentSettings.configuration.loading')}
              </p>
            ) : configurationState === 'error' ? (
              <div className="grid justify-items-start gap-3">
                <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
                  {t('agentSettings.configuration.loadError')}
                </p>
                <button className="workbench-button-secondary min-h-[44px] px-4" onClick={onConfigurationRetry} type="button">
                  {t('agentSettings.configuration.retry')}
                </button>
              </div>
            ) : null}
            {configurationState === 'ready' ? (
              <div className="grid gap-6">
                <fieldset className="grid gap-3" disabled={disabled}>
                  <legend className="text-base font-semibold text-[var(--workbench-text)]">{t('agentSettings.ready.title')}</legend>
                  <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">{t('agentSettings.ready.help')}</p>
                  {draft.readyStatusIds.length === 0 ? (
                    <p className="workbench-badge justify-self-start">{t('agentSettings.ready.any')}</p>
                  ) : null}
                  {readyStatusOptions.length === 0 ? (
                    <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('agentSettings.ready.empty')}</p>
                  ) : (
                    <ul className="grid gap-1 sm:grid-cols-2">
                      {readyStatusOptions.map((status) => (
                        <li key={status.id}>
                          <label className="flex min-h-[44px] items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
                            <input
                              checked={draft.readyStatusIds.includes(status.id)}
                              className="h-5 w-5 shrink-0 accent-[var(--workbench-primary)]"
                              type="checkbox"
                              onChange={(event) => onDraftChange({
                                ...draft,
                                readyStatusIds: toggleAgentReadyStatus(draft.readyStatusIds, status.id, event.target.checked),
                              })}
                            />
                            <span className="grid min-w-0">
                              <span className="truncate">{status.name}</span>
                              {status.missing ? (
                                <span className="text-xs font-medium text-[var(--workbench-danger)]">{t('agentSettings.ready.missing')}</span>
                              ) : status.workflowName ? (
                                <span className="truncate text-xs font-medium text-[var(--workbench-muted)]">{status.workflowName}</span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  {validation.tooManyReadyStatuses ? (
                    <p className="text-xs font-semibold text-[var(--workbench-danger)]">
                      {format('agentSettings.ready.tooMany', { max: AGENT_SETTINGS_MAX_READY_STATUSES })}
                    </p>
                  ) : null}
                </fieldset>

                <fieldset className="grid gap-3" disabled={disabled}>
                  <legend className="text-base font-semibold text-[var(--workbench-text)]">{t('agentSettings.criteria.title')}</legend>
                  <label className="flex min-h-[44px] items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
                    <input
                      checked={draft.requireAcceptanceCriteria}
                      className="h-5 w-5 accent-[var(--workbench-primary)]"
                      type="checkbox"
                      onChange={(event) => onDraftChange({ ...draft, requireAcceptanceCriteria: event.target.checked })}
                    />
                    {t('agentSettings.criteria.require')}
                  </label>
                  <label className="grid max-w-md gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                    {t('agentSettings.criteria.field')}
                    <select
                      aria-describedby={`${idPrefix}-criteria-help`}
                      className="workbench-input min-h-11 w-full min-w-0 px-3"
                      value={draft.acceptanceCriteriaFieldId}
                      onChange={(event) => onDraftChange({ ...draft, acceptanceCriteriaFieldId: event.target.value })}
                    >
                      <option value="">{t('agentSettings.criteria.fieldNone')}</option>
                      {acceptanceCriteriaFieldOptions.map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.missing ? format('agentSettings.criteria.fieldMissing', { field: field.name }) : field.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]" id={`${idPrefix}-criteria-help`}>
                    {t('agentSettings.criteria.fieldHelp')}
                  </p>
                </fieldset>
              </div>
            ) : null}
          </div>

          <fieldset className="grid gap-5 border-t border-[var(--workbench-border)] px-5 py-6 sm:px-7" disabled={disabled}>
            <legend className="text-base font-semibold text-[var(--workbench-text)]">{t('agentSettings.briefs.title')}</legend>
            <div className="grid gap-2">
              <p className="max-w-[760px] text-xs font-medium leading-5 text-[var(--workbench-muted)]">{t('agentSettings.briefs.help')}</p>
              <p className="max-w-[760px] text-xs font-medium leading-5 text-[var(--workbench-muted)]">{t('agentSettings.briefs.hiddenNote')}</p>
            </div>
            <BriefField
              bytesLabel={format('agentSettings.briefs.bytes', { used: validation.briefBytes, max: AGENT_SETTINGS_BRIEF_MAX_BYTES })}
              id={`${idPrefix}-team-brief`}
              label={t('agentSettings.briefs.team')}
              overLimitMessage={validation.briefOverLimit
                ? format('agentSettings.briefs.overLimit', { max: AGENT_SETTINGS_BRIEF_MAX_BYTES })
                : undefined}
              value={draft.brief}
              onChange={(brief) => onDraftChange({ ...draft, brief })}
            />
            {projectBriefTargets.length === 0 ? (
              <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('agentSettings.briefs.noProjects')}</p>
            ) : projectBriefTargets.map((target, index) => {
              const value = Object.hasOwn(draft.projectBriefs, target.projectId) ? draft.projectBriefs[target.projectId] ?? '' : ''
              return (
                <BriefField
                  key={target.projectId}
                  bytesLabel={format('agentSettings.briefs.bytes', {
                    used: measureUtf8Bytes(value),
                    max: AGENT_SETTINGS_BRIEF_MAX_BYTES,
                  })}
                  id={`${idPrefix}-project-brief-${index}`}
                  label={format('agentSettings.briefs.project', {
                    project: target.name ?? format('agentSettings.briefs.projectUnknown', { project: target.projectId }),
                  })}
                  overLimitMessage={validation.overLimitProjectIds.includes(target.projectId)
                    ? format('agentSettings.briefs.overLimit', { max: AGENT_SETTINGS_BRIEF_MAX_BYTES })
                    : undefined}
                  value={value}
                  onChange={(brief) => onDraftChange({
                    ...draft,
                    projectBriefs: Object.fromEntries([
                      ...Object.entries(draft.projectBriefs).filter(([projectId]) => projectId !== target.projectId),
                      [target.projectId, brief],
                    ]),
                  })}
                />
              )
            })}
            <div className="grid gap-1">
              <p
                className={`text-xs font-semibold ${validation.totalOverLimit ? 'text-[var(--workbench-danger)]' : 'text-[var(--workbench-muted)]'}`}
              >
                {format('agentSettings.briefs.total', { used: validation.totalBytes, max: AGENT_SETTINGS_BRIEFS_MAX_TOTAL_BYTES })}
              </p>
              {validation.totalOverLimit ? (
                <p className="text-xs font-semibold text-[var(--workbench-danger)]">
                  {format('agentSettings.briefs.totalOverLimit', { max: AGENT_SETTINGS_BRIEFS_MAX_TOTAL_BYTES })}
                </p>
              ) : null}
              {validation.tooManyProjectBriefs ? (
                <p className="text-xs font-semibold text-[var(--workbench-danger)]">
                  {format('agentSettings.briefs.tooManyProjects', {
                    max: AGENT_SETTINGS_MAX_PROJECT_BRIEFS,
                    count: validation.projectBriefCount,
                  })}
                </p>
              ) : null}
            </div>
          </fieldset>

          {readOnly ? null : (
            <div className="flex flex-wrap items-center gap-3 border-t border-[var(--workbench-border)] px-5 py-5 sm:px-7">
              <button
                className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="agent-settings-save"
                disabled={!isDirty || isSaving || hasRevisionConflict || feedback?.kind === 'conflict' || !validation.valid}
                onClick={onSave}
                type="button"
              >
                {isSaving ? t('agentSettings.saving') : t('agentSettings.save')}
              </button>
              {isDirty && !validation.valid ? (
                <p className="text-sm font-semibold text-[var(--workbench-danger)]">{t('agentSettings.blocked')}</p>
              ) : null}
              <SaveFeedback
                feedback={hasRevisionConflict ? { kind: 'conflict' } : feedback}
                format={format}
                t={t}
              />
              {hasRevisionConflict || feedback?.kind === 'conflict' ? (
                <button className="workbench-button-secondary min-h-[44px] px-4" disabled={isSaving} onClick={onReload} type="button">
                  {t('agentSettings.reload')}
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** Props of one brief textarea with its size counter. */
type BriefFieldProps = {
  /** Element ID of the textarea. */
  id: string
  /** Visible label. */
  label: string
  /** Brief text. */
  value: string
  /** Size counter text. */
  bytesLabel: string
  /** Error shown when the brief is too large. */
  overLimitMessage?: string
  /** Replaces the brief text. */
  onChange: (value: string) => void
}

/**
 * Renders one Markdown brief textarea with its UTF-8 size counter.
 *
 * @param props - Label, value, counter, and change handler.
 * @returns The labelled textarea.
 */
function BriefField({ bytesLabel, id, label, onChange, overLimitMessage, value }: BriefFieldProps) {
  const counterId = `${id}-counter`
  return (
    <div className="grid gap-2">
      <label className="text-sm font-semibold text-[var(--workbench-text)]" htmlFor={id}>{label}</label>
      <textarea
        aria-describedby={counterId}
        aria-invalid={overLimitMessage ? true : undefined}
        className="workbench-input min-h-28 resize-y px-3 py-2 font-mono text-sm font-normal text-[var(--workbench-text)]"
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p
        className={`text-xs font-semibold ${overLimitMessage ? 'text-[var(--workbench-danger)]' : 'text-[var(--workbench-muted)]'}`}
        id={counterId}
      >
        {bytesLabel}
        {overLimitMessage ? ` ${overLimitMessage}` : null}
      </p>
    </div>
  )
}

/** Props of the save outcome message. */
type SaveFeedbackProps = {
  /** Outcome to show, if any. */
  feedback?: AgentSettingsSaveFeedback
  /** Fills placeholders of a message. */
  format: (key: MessageKey, values: Readonly<Record<string, string | number>>) => string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders the outcome of the latest save.
 *
 * @param props - Outcome and message helpers.
 * @returns The message, or nothing when there is no outcome.
 */
function SaveFeedback({ feedback, format, t }: SaveFeedbackProps) {
  if (!feedback) return null
  const message = feedback.kind === 'saved'
    ? t('agentSettings.saved')
    : feedback.kind === 'conflict'
      ? t('agentSettings.conflict')
      : feedback.kind === 'forbidden'
        ? t('agentSettings.forbidden')
        : feedback.kind === 'invalid'
          ? format('agentSettings.invalid', { message: feedback.message })
          : t('agentSettings.saveError')
  return (
    <p
      className={`text-sm font-semibold ${feedback.kind === 'saved' ? 'text-[var(--workbench-success)]' : 'text-[var(--workbench-danger)]'}`}
      role={feedback.kind === 'saved' ? 'status' : 'alert'}
    >
      {message}
    </p>
  )
}
