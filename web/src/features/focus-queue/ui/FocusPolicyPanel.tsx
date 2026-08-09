import type {
  FocusEffectivePolicy,
  FocusPolicy,
  FocusPolicyOverrides,
  FocusPolicyTarget,
  FocusSignalType,
  FocusSignalWeights,
} from '@mukuroji/contracts'
import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import {
  getFocusSignalMessageKey,
} from '../model/focusQueue'
import { readFocusPolicyOverrides } from '../model/focusPolicyForm'

/** One editable signal-weight field in stable display order. */
type FocusPolicyWeightField = {
  /** Contract property updated by the form control. */
  field: keyof FocusSignalWeights
  /** Signal label displayed beside the numeric input. */
  signalType: FocusSignalType
}

const focusPolicyWeightFields: readonly FocusPolicyWeightField[] = Object.freeze([
  { field: 'blocker', signalType: 'blocker' },
  { field: 'urgent', signalType: 'urgent' },
  { field: 'overdue', signalType: 'overdue' },
  { field: 'dueSoon', signalType: 'due-soon' },
  { field: 'approval', signalType: 'approval' },
  { field: 'reviewRequest', signalType: 'review-request' },
  { field: 'mention', signalType: 'mention' },
  { field: 'sla', signalType: 'sla' },
  { field: 'cycle', signalType: 'cycle' },
])

/** Props for the effective Focus policy disclosure and personal override editor. */
export type FocusPolicyPanelProps = {
  /** Whether the latest policy mutation failed. */
  hasError?: boolean
  /** Whether a personal policy update is in flight. */
  isSaving?: boolean
  /** Whether the selected Team policy layer may be managed. */
  canEditTeam?: boolean
  /** Whether the personal policy layer may be managed. */
  canEditPersonal?: boolean
  /** Saves a sparse policy layer using optimistic concurrency. */
  onSave?: (
    target: FocusPolicyTarget,
    expectedVersion: number,
    overrides: FocusPolicyOverrides,
  ) => Promise<void>
  /** Stored personal layer whose sparse values replace inherited settings. */
  personalPolicy?: FocusPolicy
  /** Effective policy used by the selected queue item. */
  policy?: FocusEffectivePolicy
  /** Stored Team layer whose sparse values replace product defaults. */
  teamPolicy?: FocusPolicy
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Shows transparent ranking settings and edits the caller's personal policy layer.
 *
 * @param props - Effective policy, localized copy, and optional save action.
 * @returns A compact disclosure panel, or null when no policy is visible.
 */
export function FocusPolicyPanel({
  canEditPersonal = false,
  canEditTeam = false,
  hasError = false,
  isSaving = false,
  onSave,
  personalPolicy,
  policy,
  teamPolicy,
  t,
}: FocusPolicyPanelProps) {
  const [scope, setScope] = useState<'user' | 'team'>('user')
  if (!policy) return null
  const editingTeam = scope === 'team' && policy.teamId !== undefined
  const storedPolicy = editingTeam ? teamPolicy : personalPolicy
  const inheritedSettings = editingTeam ? policy.baseSettings : policy.teamSettings
  const canEdit = editingTeam ? canEditTeam : canEditPersonal

  /** Validates and submits one sparse personal policy replacement. */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!onSave) return
    const formData = new FormData(event.currentTarget)
    const overrides = readFocusPolicyOverrides(formData)
    if (overrides) {
      const target: FocusPolicyTarget = editingTeam && policy.teamId !== undefined
        ? { type: 'team', teamId: policy.teamId }
        : { type: 'user' }
      void onSave(target, storedPolicy?.version ?? 0, overrides).then(
        () => undefined,
        () => undefined,
      )
    }
  }

  return (
    <details className="workbench-panel group overflow-hidden">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-left marker:hidden">
        <span>
          <span className="block text-app-body font-semibold text-[var(--workbench-text)]">
            {t('workspace.focus.policy.title')}
          </span>
          <span className="mt-0.5 block text-app-caption text-[var(--workbench-muted)]">
            {t('workspace.focus.policy.description')}
          </span>
        </span>
        <span aria-hidden="true" className="text-[var(--workbench-muted)] transition-transform group-open:rotate-45">
          +
        </span>
      </summary>
      <form
        className="border-t border-[var(--workbench-border)] px-4 py-4"
        key={`${policy.fingerprint}:${scope}:${storedPolicy?.version ?? 0}`}
        onSubmit={handleSubmit}
      >
        <p className="mb-4 text-app-caption text-[var(--workbench-muted)]">
          {t('workspace.focus.policy.provenance').replace(
            '{layers}',
            policy.provenance.map((layer) => layer.source).join(' → '),
          )}
        </p>
        {policy.teamId ? (
          <label className="mb-4 grid max-w-xs gap-1 text-app-caption font-semibold text-[var(--workbench-muted)]">
            <span>{t('workspace.focus.policy.scope')}</span>
            <select
              className="workbench-input min-h-[44px] px-3"
              onChange={(event) => setScope(event.target.value === 'team' ? 'team' : 'user')}
              value={scope}
            >
              <option value="user">{t('workspace.focus.policy.scopeUser')}</option>
              <option disabled={!canEditTeam} value="team">
                {t('workspace.focus.policy.scopeTeam')}
              </option>
            </select>
          </label>
        ) : null}
        <fieldset disabled={!onSave || !canEdit || isSaving}>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {focusPolicyWeightFields.map(({ field, signalType }) => (
              <label className="grid gap-1 text-app-caption font-semibold text-[var(--workbench-muted)]" key={field}>
                <span>
                  {t('workspace.focus.policy.weight').replace(
                    '{signal}',
                    t(getFocusSignalMessageKey(signalType)),
                  )}
                </span>
                <input
                  className="workbench-input min-h-[44px] w-full px-3 tabular-nums"
                  defaultValue={storedPolicy?.overrides.weights?.[field] ?? ''}
                  max="10000"
                  min="0"
                  name={`weight-${field}`}
                  placeholder={String(inheritedSettings.weights[field])}
                  step="0.1"
                  type="number"
                />
              </label>
            ))}
            <PolicyNumberField
              effectiveValue={inheritedSettings.dueSoonDays}
              label={t('workspace.focus.policy.dueSoonDays')}
              max="365"
              name="dueSoonDays"
              value={storedPolicy?.overrides.dueSoonDays}
            />
            <PolicyNumberField
              effectiveValue={inheritedSettings.cycleDueSoonDays}
              label={t('workspace.focus.policy.cycleDueSoonDays')}
              max="365"
              name="cycleDueSoonDays"
              value={storedPolicy?.overrides.cycleDueSoonDays}
            />
            <PolicyNumberField
              effectiveValue={inheritedSettings.slaHours}
              label={t('workspace.focus.policy.slaHours')}
              max="8760"
              min="1"
              name="slaHours"
              value={storedPolicy?.overrides.slaHours}
            />
            <PolicyNumberField
              effectiveValue={inheritedSettings.nowScoreThreshold}
              label={t('workspace.focus.policy.nowThreshold')}
              max="100000"
              name="nowScoreThreshold"
              step="0.1"
              value={storedPolicy?.overrides.nowScoreThreshold}
            />
          </div>
          {hasError ? (
            <p className="mt-4 text-app-meta font-semibold text-[var(--workbench-danger)]" role="alert">
              {t('workspace.focus.policy.updateError')}
            </p>
          ) : null}
          {onSave ? (
            <button
              className="workbench-button-primary mt-4 min-h-[44px] px-4"
              type="submit"
            >
              {t(isSaving
                ? 'workspace.focus.policy.saving'
                : 'workspace.focus.policy.save')}
            </button>
          ) : null}
        </fieldset>
      </form>
    </details>
  )
}

/** Props for one policy numeric setting. */
type PolicyNumberFieldProps = {
  /** Effective inherited value shown as a placeholder. */
  effectiveValue: number
  /** Visible localized field label. */
  label: string
  /** Highest value accepted by the server-side policy validator. */
  max: string
  /** Lowest value accepted by the server-side policy validator. */
  min?: string
  /** Form field name read by the policy parser. */
  name: string
  /** Optional HTML numeric step. */
  step?: string
  /** Current sparse personal override, or undefined to inherit. */
  value?: number
}

/** Renders one 44px policy number field. */
function PolicyNumberField({
  effectiveValue,
  label,
  max,
  min = '0',
  name,
  step = '1',
  value,
}: PolicyNumberFieldProps) {
  return (
    <label className="grid gap-1 text-app-caption font-semibold text-[var(--workbench-muted)]">
      <span>{label}</span>
      <input
        className="workbench-input min-h-[44px] w-full px-3 tabular-nums"
        defaultValue={value ?? ''}
        max={max}
        min={min}
        name={name}
        placeholder={String(effectiveValue)}
        step={step}
        type="number"
      />
    </label>
  )
}
