import type {
  AiAssistancePolicy,
  AiAssistancePreference,
  AiAssistanceTask,
} from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../../shared/i18n/i18n'
import { SectionHeader } from '../../../shared/ui/WorkbenchPrimitives'
import { ShieldIcon } from '../../../shared/ui/icons'
import { useAiAssistanceSettingsMutations } from '../mutations/useAiAssistanceSettingsMutations'
import type { AiAssistanceSettingsMutationFeedback } from '../mutations/useAiAssistanceSettingsMutations'
import {
  useAiAssistancePolicy,
  useAiAssistancePreference,
} from '../queries/useAiAssistanceSettings'

const policyTasks = ['triage', 'summary', 'search', 'planning'] as const satisfies readonly AiAssistanceTask[]

/** Props for the authenticated AI settings panel container. */
export type AiAssistanceSettingsPanelContainerProps = {
  /** Bearer token for the active Workspace member. */
  accessToken: string
  /** Whether the active member may load and replace the Workspace AI policy. */
  canManagePolicy: boolean
  /** Locale used for settings labels. */
  locale: Locale
  /** Wraps authenticated settings requests so the Workspace session guard sees expiry. */
  guardRequest?: <Result>(request: Promise<Result>) => Promise<Result>
}

/** Editable server value pinned to the revision from which it was derived. */
type RevisionedAiSettingsDraft<Value> = {
  /** Server revision used to initialize the local draft. */
  baseRevision: number
  /** Locally edited value. */
  value: Value
}

/**
 * Connects personal AI preference and manager-only policy resources to Settings.
 *
 * @param props - Authentication, management capability, and locale.
 * @returns A revision-aware AI settings panel.
 */
export function AiAssistanceSettingsPanelContainer({
  accessToken,
  canManagePolicy,
  guardRequest,
  locale,
}: AiAssistanceSettingsPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const preferenceQuery = useAiAssistancePreference(accessToken, true, guardRequest)
  const policyQuery = useAiAssistancePolicy(accessToken, canManagePolicy, guardRequest)
  const mutations = useAiAssistanceSettingsMutations({
    accessToken,
    guardRequest,
    mutatePolicy: policyQuery.mutate,
    mutatePreference: preferenceQuery.mutate,
  })
  const [preferenceDraft, setPreferenceDraft] = useState<RevisionedAiSettingsDraft<boolean>>()
  const [policyDraft, setPolicyDraft] = useState<RevisionedAiSettingsDraft<AiAssistancePolicy>>()
  const [policyEditorVersion, setPolicyEditorVersion] = useState(0)
  const preference = preferenceQuery.data
  const policy = policyQuery.data
  const preferenceEnabled = preferenceDraft?.value ?? preference?.enabled
  const visiblePolicy = policyDraft && policy
    ? {
        ...policyDraft.value,
        revision: policy.revision,
        updatedAt: policy.updatedAt,
      }
    : policy
  const hasPreferenceRevisionConflict = Boolean(
    preference && preferenceDraft && preferenceDraft.baseRevision !== preference.revision,
  )
  const hasPolicyRevisionConflict = Boolean(
    policy && policyDraft && policyDraft.baseRevision !== policy.revision,
  )
  const isPreferenceDirty = preferenceEnabled !== undefined && preferenceEnabled !== preference?.enabled
  const isPolicyDirty = Boolean(policy && visiblePolicy && !arePoliciesEqual(policy, visiblePolicy))

  return (
    <AiAssistanceSettingsPanel
      canManagePolicy={canManagePolicy}
      hasPolicyRevisionConflict={hasPolicyRevisionConflict}
      hasPreferenceRevisionConflict={hasPreferenceRevisionConflict}
      isPolicySaving={mutations.isPolicySaving}
      isPolicyDirty={isPolicyDirty}
      isPreferenceSaving={mutations.isPreferenceSaving}
      isPreferenceDirty={isPreferenceDirty}
      isPreferenceLoading={preferenceQuery.isLoading && !preference}
      policy={visiblePolicy}
      policyEditorVersion={policyEditorVersion}
      policyFeedback={hasPolicyRevisionConflict ? 'conflict' : mutations.policyFeedback}
      isPolicyLoading={Boolean(canManagePolicy && policyQuery.isLoading)}
      policyLoadError={Boolean(canManagePolicy && policyQuery.error)}
      preference={preference && preferenceEnabled !== undefined
        ? { ...preference, enabled: preferenceEnabled }
        : undefined}
      preferenceLoadError={Boolean(preferenceQuery.error)}
      preferenceFeedback={hasPreferenceRevisionConflict ? 'conflict' : mutations.preferenceFeedback}
      t={t}
      onPolicyChange={(value) => {
        if (!policy) return
        mutations.clearPolicyFeedback()
        setPolicyDraft({ baseRevision: policy.revision, value })
      }}
      onPolicyRetry={() => void policyQuery.mutate()}
      onPolicyUseLatest={() => {
        mutations.clearPolicyFeedback()
        setPolicyDraft(undefined)
        setPolicyEditorVersion((version) => version + 1)
      }}
      onPolicySave={() => {
        if (!policy || !visiblePolicy || hasPolicyRevisionConflict) return
        void mutations.savePolicy({
          allowedModelIds: visiblePolicy.allowedModelIds,
          defaultModelId: visiblePolicy.defaultModelId,
          enabled: visiblePolicy.enabled,
          enabledTasks: visiblePolicy.enabledTasks,
          expectedRevision: policy.revision,
          retentionDays: visiblePolicy.retentionDays,
        }).then((saved) => {
          if (saved) {
            setPolicyDraft(undefined)
            setPolicyEditorVersion((version) => version + 1)
          }
        })
      }}
      onPreferenceChange={(enabled) => {
        if (!preference) return
        mutations.clearPreferenceFeedback()
        setPreferenceDraft({ baseRevision: preference.revision, value: enabled })
      }}
      onPreferenceUseLatest={() => {
        mutations.clearPreferenceFeedback()
        setPreferenceDraft(undefined)
      }}
      onPreferenceSave={() => {
        if (!preference || preferenceEnabled === undefined || hasPreferenceRevisionConflict) return
        void mutations.savePreference({
          enabled: preferenceEnabled,
          expectedRevision: preference.revision,
        }).then((saved) => {
          if (saved) setPreferenceDraft(undefined)
        })
      }}
      onPreferenceRetry={() => void preferenceQuery.mutate()}
    />
  )
}

/** Props for the pure AI assistance settings panel. */
export type AiAssistanceSettingsPanelProps = {
  /** Whether the Workspace policy section may be rendered. */
  canManagePolicy: boolean
  /** Whether the editable Workspace policy differs from its latest server revision. */
  isPolicyDirty?: boolean
  /** Whether the server policy changed after this local draft began. */
  hasPolicyRevisionConflict?: boolean
  /** Whether a Workspace policy save is in flight. */
  isPolicySaving?: boolean
  /** Whether the manager-only Workspace policy is loading. */
  isPolicyLoading?: boolean
  /** Whether the personal preference differs from its latest server revision. */
  isPreferenceDirty?: boolean
  /** Whether the server preference changed after this local draft began. */
  hasPreferenceRevisionConflict?: boolean
  /** Whether a personal preference save is in flight. */
  isPreferenceSaving?: boolean
  /** Whether the personal preference is being loaded for the first time. */
  isPreferenceLoading?: boolean
  /** Whether the personal preference could not be loaded. */
  preferenceLoadError?: boolean
  /** Current editable manager-only Workspace policy. */
  policy?: AiAssistancePolicy
  /** Revision-independent reset version for raw policy text controls. */
  policyEditorVersion?: number
  /** Latest Workspace policy save result. */
  policyFeedback?: AiAssistanceSettingsMutationFeedback
  /** Whether the manager-only policy could not be loaded. */
  policyLoadError?: boolean
  /** Current editable personal preference. */
  preference?: AiAssistancePreference
  /** Latest personal preference save result. */
  preferenceFeedback?: AiAssistanceSettingsMutationFeedback
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Replaces the local Workspace policy draft. */
  onPolicyChange?: (policy: AiAssistancePolicy) => void
  /** Retries the manager-only policy query. */
  onPolicyRetry?: () => void
  /** Explicitly discards the stale policy draft and shows the latest server value. */
  onPolicyUseLatest?: () => void
  /** Explicitly saves the revision-fenced Workspace policy. */
  onPolicySave?: () => void
  /** Replaces the local personal preference draft. */
  onPreferenceChange: (enabled: boolean) => void
  /** Explicitly discards the stale preference draft and shows the latest server value. */
  onPreferenceUseLatest?: () => void
  /** Retries loading the personal preference without affecting manager policy data. */
  onPreferenceRetry?: () => void
  /** Explicitly saves the revision-fenced personal preference. */
  onPreferenceSave: () => void
}

/**
 * Renders separate personal opt-out and administrator Workspace policy save surfaces.
 *
 * @param props - Revisioned settings data, pending state, feedback, and explicit actions.
 * @returns A flat settings panel with no automatic saves.
 */
export function AiAssistanceSettingsPanel({
  canManagePolicy,
  hasPolicyRevisionConflict = false,
  hasPreferenceRevisionConflict = false,
  isPreferenceLoading = false,
  isPolicyDirty = false,
  isPolicyLoading = false,
  isPolicySaving = false,
  isPreferenceDirty = false,
  isPreferenceSaving = false,
  onPolicyChange,
  onPolicyRetry,
  onPolicySave,
  onPolicyUseLatest,
  onPreferenceChange,
  onPreferenceRetry,
  onPreferenceSave,
  onPreferenceUseLatest,
  policy,
  policyEditorVersion = 0,
  policyFeedback,
  policyLoadError = false,
  preference,
  preferenceLoadError = false,
  preferenceFeedback,
  t,
}: AiAssistanceSettingsPanelProps) {
  const policyValidation = policy ? validatePolicy(policy) : undefined

  return (
    <section className="workbench-panel overflow-hidden" data-testid="ai-assistance-settings-panel">
      <div className="flex items-start gap-3 px-5 py-5 sm:px-7">
        <span className="mt-1 text-[var(--workbench-primary)]">
          <ShieldIcon className="h-6 w-6 fill-none stroke-current stroke-2" />
        </span>
        <SectionHeader
          title={t('ai.settings.title')}
          meta={t('ai.settings.description')}
        />
      </div>

      <div className="border-t border-[var(--workbench-border)] px-5 py-6 sm:px-7">
        {isPreferenceLoading && !preference ? (
          <div className="grid gap-3" role="status">
            <p className="text-app-body font-semibold text-[var(--workbench-text)]">
              {t('workspace.loading')}
            </p>
            <span className="h-3 w-3/5 animate-pulse rounded bg-[var(--workbench-border)] motion-reduce:animate-none" />
          </div>
        ) : preferenceLoadError || !preference ? (
          <div className="grid gap-3">
            <p className="text-app-body font-semibold text-[var(--workbench-danger)]" role="alert">
              {t('ai.settings.loadError')}
            </p>
            {onPreferenceRetry ? (
              <button className="workbench-button-secondary min-h-[44px] justify-self-start px-4" onClick={onPreferenceRetry} type="button">
                {t('ai.settings.retry')}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <h3 className="text-app-body font-semibold text-[var(--workbench-text)]">
                  {t('ai.settings.preference.title')}
                </h3>
                <p className="mt-1 text-app-caption leading-5 text-[var(--workbench-muted)]">
                  {t('ai.settings.preference.description')}
                </p>
              </div>
              <span className="workbench-badge">
                {t('ai.settings.revision').replace('{revision}', String(preference.revision))}
              </span>
            </div>
            <label className="mt-5 flex min-h-[44px] items-center gap-3 text-app-body font-semibold text-[var(--workbench-text)]">
              <input
                checked={preference.enabled}
                className="h-5 w-5 accent-[var(--workbench-primary)]"
                disabled={isPreferenceSaving}
                onChange={(event) => onPreferenceChange(event.target.checked)}
                type="checkbox"
              />
              {t('ai.settings.preference.enabled')}
            </label>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!isPreferenceDirty || isPreferenceSaving || hasPreferenceRevisionConflict}
                onClick={onPreferenceSave}
                type="button"
              >
                {isPreferenceSaving ? t('ai.settings.saving') : t('ai.settings.preference.save')}
              </button>
              <SettingsFeedback feedback={preferenceFeedback} t={t} />
              {hasPreferenceRevisionConflict && onPreferenceUseLatest ? (
                <button
                  className="workbench-button-secondary min-h-[44px] px-4"
                  onClick={onPreferenceUseLatest}
                  type="button"
                >
                  {t('ai.settings.useLatest')}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>

      {canManagePolicy ? (
        <div className="border-t border-[var(--workbench-border)] px-5 py-6 sm:px-7">
          {isPolicyLoading ? (
            <div className="grid gap-3" role="status">
              <p className="text-app-body font-semibold text-[var(--workbench-text)]">
                {t('ai.settings.policy.loading')}
              </p>
              <span className="h-3 w-3/5 animate-pulse rounded bg-[var(--workbench-border)] motion-reduce:animate-none" />
            </div>
          ) : policyLoadError || !policy ? (
            <div className="grid gap-3">
              <p className="text-app-body font-semibold text-[var(--workbench-danger)]" role="alert">
                {t('ai.settings.loadError')}
              </p>
              {onPolicyRetry ? (
                <button className="workbench-button-secondary min-h-[44px] justify-self-start px-4" onClick={onPolicyRetry} type="button">
                  {t('ai.settings.retry')}
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-2xl">
                  <h3 className="text-app-body font-semibold text-[var(--workbench-text)]">
                    {t('ai.settings.policy.title')}
                  </h3>
                  <p className="mt-1 text-app-caption leading-5 text-[var(--workbench-muted)]">
                    {t('ai.settings.policy.description')}
                  </p>
                </div>
                <span className="workbench-badge-primary">
                  {t('ai.settings.revision').replace('{revision}', String(policy.revision))}
                </span>
              </div>

              <fieldset className="mt-5 grid gap-5" disabled={isPolicySaving || !onPolicyChange}>
                <label className="flex min-h-[44px] items-center gap-3 text-app-body font-semibold text-[var(--workbench-text)]">
                  <input
                    checked={policy.enabled}
                    className="h-5 w-5 accent-[var(--workbench-primary)]"
                    onChange={(event) => onPolicyChange?.({ ...policy, enabled: event.target.checked })}
                    type="checkbox"
                  />
                  {t('ai.settings.policy.enabled')}
                </label>

                <fieldset className="grid gap-2 border-t border-[var(--workbench-border)] pt-4">
                  <legend className="pr-2 text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                    {t('ai.settings.policy.tasks')}
                  </legend>
                  <div className="grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
                    {policyTasks.map((task) => (
                      <label className="flex min-h-[44px] items-center gap-3 text-app-caption font-semibold text-[var(--workbench-text)]" key={task}>
                        <input
                          checked={policy.enabledTasks.includes(task)}
                          className="h-5 w-5 accent-[var(--workbench-primary)]"
                          onChange={() => onPolicyChange?.({
                            ...policy,
                            enabledTasks: togglePolicyTask(policy.enabledTasks, task),
                          })}
                          type="checkbox"
                        />
                        {t(`ai.settings.policy.task.${task}`)}
                      </label>
                    ))}
                  </div>
                  {!policyValidation?.tasksValid ? (
                    <p className="text-app-caption font-semibold text-[var(--workbench-danger)]" role="alert">
                      {t('ai.settings.validation.tasks')}
                    </p>
                  ) : null}
                </fieldset>

                <label className="grid gap-2 text-app-caption font-semibold text-[var(--workbench-muted)]">
                  {t('ai.settings.policy.allowedModels')}
                  <AllowedModelsInput
                    key={`allowed-models-${policy.revision}-${policyEditorVersion}`}
                    onChange={(allowedModelIds) => onPolicyChange?.({
                      ...policy,
                      allowedModelIds,
                    })}
                    value={policy.allowedModelIds}
                  />
                  <span className="text-[11px] font-normal" id="ai-settings-model-hint">
                    {t('ai.settings.policy.allowedModelsHint')}
                  </span>
                </label>

                <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
                  <label className="grid gap-2 text-app-caption font-semibold text-[var(--workbench-muted)]">
                    {t('ai.settings.policy.defaultModel')}
                    <select
                      className="workbench-input min-h-[44px] px-3 font-normal text-[var(--workbench-text)]"
                      onChange={(event) => onPolicyChange?.({ ...policy, defaultModelId: event.target.value })}
                      value={policy.defaultModelId}
                    >
                      {!policy.allowedModelIds.includes(policy.defaultModelId) ? (
                        <option value={policy.defaultModelId}>{policy.defaultModelId}</option>
                      ) : null}
                      {policy.allowedModelIds.map((modelId) => (
                        <option key={modelId} value={modelId}>{modelId}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-2 text-app-caption font-semibold text-[var(--workbench-muted)]">
                    {t('ai.settings.policy.retentionDays')}
                    <input
                      className="workbench-input min-h-[44px] px-3 font-normal text-[var(--workbench-text)]"
                      max="365"
                      min="1"
                      onChange={(event) => onPolicyChange?.({
                        ...policy,
                        retentionDays: Number(event.target.value),
                      })}
                      step="1"
                      type="number"
                      value={policy.retentionDays}
                    />
                  </label>
                </div>
                {!policyValidation?.modelsValid ? (
                  <p className="text-app-caption font-semibold text-[var(--workbench-danger)]" role="alert">
                    {t('ai.settings.validation.models')}
                  </p>
                ) : null}
                {!policyValidation?.retentionValid ? (
                  <p className="text-app-caption font-semibold text-[var(--workbench-danger)]" role="alert">
                    {t('ai.settings.validation.retention')}
                  </p>
                ) : null}
              </fieldset>

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={
                    !isPolicyDirty ||
                    !policyValidation?.valid ||
                    isPolicySaving ||
                    hasPolicyRevisionConflict ||
                    !onPolicySave
                  }
                  onClick={onPolicySave}
                  type="button"
                >
                  {isPolicySaving ? t('ai.settings.saving') : t('ai.settings.policy.save')}
                </button>
                <SettingsFeedback feedback={policyFeedback} t={t} />
                {hasPolicyRevisionConflict && onPolicyUseLatest ? (
                  <button
                    className="workbench-button-secondary min-h-[44px] px-4"
                    onClick={onPolicyUseLatest}
                    type="button"
                  >
                    {t('ai.settings.useLatest')}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

/** Props for the line-preserving Bedrock model allowlist editor. */
type AllowedModelsInputProps = {
  /** Replaces the parsed model allowlist while raw typing remains visible. */
  onChange: (modelIds: string[]) => void
  /** Latest revision-scoped model allowlist. */
  value: readonly string[]
}

/** Keeps trailing newlines visible while emitting a normalized model allowlist. */
function AllowedModelsInput({ onChange, value }: AllowedModelsInputProps) {
  const [rawValue, setRawValue] = useState(() => value.join('\n'))

  return (
    <textarea
      aria-describedby="ai-settings-model-hint"
      className="workbench-input min-h-28 resize-y px-3 py-2 font-mono text-app-caption font-normal text-[var(--workbench-text)]"
      onChange={(event) => {
        const nextValue = event.target.value
        setRawValue(nextValue)
        onChange(parseModelIds(nextValue))
      }}
      value={rawValue}
    />
  )
}

/** Props for a compact mutation result beside one save action. */
type SettingsFeedbackProps = {
  /** Latest scoped save result. */
  feedback?: AiAssistanceSettingsMutationFeedback
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders explicit saved, conflict, or failure feedback without raw API content. */
function SettingsFeedback({ feedback, t }: SettingsFeedbackProps) {
  if (!feedback) return null
  const messageKey = feedback === 'saved'
    ? 'ai.settings.saved'
    : feedback === 'conflict'
      ? 'ai.settings.conflict'
      : 'ai.settings.saveError'
  return (
    <p
      className={`text-app-caption font-semibold ${feedback === 'saved' ? 'text-[var(--workbench-success)]' : 'text-[var(--workbench-danger)]'}`}
      role={feedback === 'saved' ? 'status' : 'alert'}
    >
      {t(messageKey)}
    </p>
  )
}

/** Toggles one Workspace-enabled AI workflow without mutating policy state. */
function togglePolicyTask(
  tasks: readonly AiAssistanceTask[],
  task: AiAssistanceTask,
): AiAssistanceTask[] {
  return tasks.includes(task)
    ? tasks.filter((candidate) => candidate !== task)
    : [...tasks, task]
}

/** Parses unique non-empty Bedrock model IDs from a line-delimited control. */
function parseModelIds(value: string): string[] {
  return [...new Set(value.split('\n').map((modelId) => modelId.trim()).filter(Boolean))]
}

/** Validation result for one editable Workspace policy. */
type PolicyValidation = {
  /** Whether the default model belongs to a non-empty allowlist. */
  modelsValid: boolean
  /** Whether retention is a positive whole number. */
  retentionValid: boolean
  /** Whether an enabled Workspace exposes at least one workflow. */
  tasksValid: boolean
  /** Whether every policy field is currently valid. */
  valid: boolean
}

/** Validates the complete editable policy before enabling explicit Save. */
function validatePolicy(policy: AiAssistancePolicy): PolicyValidation {
  const modelsValid = policy.allowedModelIds.length > 0 &&
    policy.allowedModelIds.length <= 20 &&
    policy.allowedModelIds.every((modelId) => modelId.length <= 256) &&
    policy.allowedModelIds.includes(policy.defaultModelId)
  const retentionValid = Number.isInteger(policy.retentionDays) &&
    policy.retentionDays >= 1 &&
    policy.retentionDays <= 365
  const tasksValid = policy.enabledTasks.length > 0
  return {
    modelsValid,
    retentionValid,
    tasksValid,
    valid: modelsValid && retentionValid && tasksValid,
  }
}

/** Returns whether two revision-adjacent policies have identical editable fields. */
function arePoliciesEqual(
  base: AiAssistancePolicy,
  draft: AiAssistancePolicy,
): boolean {
  return base.enabled === draft.enabled &&
    base.defaultModelId === draft.defaultModelId &&
    base.retentionDays === draft.retentionDays &&
    areStringArraysEqual(base.allowedModelIds, draft.allowedModelIds) &&
    areStringArraysEqual(base.enabledTasks, draft.enabledTasks)
}

/** Returns whether two ordered string arrays contain the same values. */
function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
