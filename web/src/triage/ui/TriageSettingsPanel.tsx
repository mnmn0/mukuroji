import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  TriageConfiguration,
  TriageBulkOperation,
  TriageOwnerRotation,
  TriageOwnerStrategy,
  TriageRoutingRule,
  TriageSlaPolicy,
  TriageSourceKind,
  UpdateTriageConfigurationInput,
} from '../api'

const bulkActionOptions = [
  { action: 'assign', labelKey: 'triage.bulk.assign' },
  { action: 'decline', labelKey: 'triage.bulk.decline' },
  { action: 'snooze', labelKey: 'triage.bulk.snooze' },
] satisfies ReadonlyArray<{
  action: TriageBulkOperation['action']
  labelKey: MessageKey
}>

/** Props accepted by the Team triage configuration surface. */
export type TriageSettingsPanelProps = {
  /** Loaded versioned Team configuration. */
  readonly configuration?: TriageConfiguration
  /** Whether configuration is loading. */
  readonly isLoading?: boolean
  /** Whether configuration loading or saving failed. */
  readonly errorMessage?: string
  /** Whether the current principal may update Team triage configuration. */
  readonly canManage: boolean
  /** Whether a configuration update is running. */
  readonly isSaving?: boolean
  /** Whether the latest configuration update completed successfully. */
  readonly didSave?: boolean
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
  /** Retries configuration loading. */
  readonly onRetry?: () => void
  /** Persists one revision-fenced configuration replacement. */
  readonly onSave?: (
    input: UpdateTriageConfigurationInput,
  ) => Promise<TriageConfiguration>
}

/**
 * Renders routing rules, owner rotations, SLA policies, and retention settings.
 *
 * @param props - Configuration, permission state, and persistence callbacks.
 * @returns Editable or read-only Team triage settings.
 */
export function TriageSettingsPanel({
  canManage,
  configuration,
  errorMessage,
  didSave = false,
  isLoading = false,
  isSaving = false,
  onRetry,
  onSave,
  t,
}: TriageSettingsPanelProps) {
  if (isLoading) {
    return <SettingsLoading label={t('triage.settings.loading')} />
  }
  if (!configuration) {
    return (
      <section className="grid min-h-80 place-items-center p-8 text-center">
        <div>
          <p className="text-sm font-semibold text-red-700" role="alert">
            {errorMessage ?? t('triage.settings.error')}
          </p>
          {onRetry ? (
            <button className="workbench-button-secondary mt-4 min-h-10 px-4" onClick={onRetry} type="button">
              {t('triage.settings.retry')}
            </button>
          ) : null}
        </div>
      </section>
    )
  }

  return (
    <TriageSettingsEditor
      canManage={canManage}
      configuration={configuration}
      errorMessage={errorMessage}
      didSave={didSave}
      isSaving={isSaving}
      onSave={onSave}
      t={t}
    />
  )
}

/** Renders and owns the mutable draft for a loaded Team configuration. */
function TriageSettingsEditor({
  canManage,
  configuration,
  errorMessage,
  didSave,
  isSaving,
  onSave,
  t,
}: {
  canManage: boolean
  configuration: TriageConfiguration
  errorMessage?: string
  didSave: boolean
  isSaving: boolean
  onSave?: TriageSettingsPanelProps['onSave']
  t: (key: MessageKey) => string
}) {
  const [rules, setRules] = useState<TriageRoutingRule[]>(() =>
    configuration.rules.map((rule) => ({
      ...rule,
      keywords: [...rule.keywords],
      sourceKinds: [...rule.sourceKinds],
    })),
  )
  const [rotations, setRotations] = useState<TriageOwnerRotation[]>(() =>
    configuration.rotations.map((rotation) => ({
      ...rotation,
      memberUserIds: [...rotation.memberUserIds],
    })),
  )
  const [slaPolicies, setSlaPolicies] = useState<TriageSlaPolicy[]>(() =>
    configuration.slaPolicies.map((policy) => ({
      ...policy,
      sourceKinds: [...policy.sourceKinds],
    })),
  )
  const [allowedBulkActions, setAllowedBulkActions] = useState<
    TriageBulkOperation['action'][]
  >(() => [...configuration.allowedBulkActions])
  const [retentionDays, setRetentionDays] = useState(configuration.retentionDays)
  const [localError, setLocalError] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage || !onSave || isSaving) return
    setLocalError(false)
    try {
      await onSave({
        allowedBulkActions,
        expectedRevision: configuration.revision,
        retentionDays,
        rotations,
        rules: rules.map((rule, index) => ({ ...rule, order: index })),
        slaPolicies,
      })
    } catch {
      setLocalError(true)
    }
  }

  return (
    <form className="grid gap-8 p-6 max-[720px]:p-4" onSubmit={(event) => void submit(event)}>
      <header className="border-b border-[var(--workbench-border)] pb-5">
        <p className="workbench-eyebrow">{t('triage.settings.eyebrow')}</p>
        <h2 className="mt-2 text-xl font-semibold text-[var(--workbench-text)]">{t('triage.settings.title')}</h2>
        <p className="mt-2 max-w-[760px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('triage.settings.description')}
        </p>
        {!canManage ? (
          <p className="mt-4 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
            {t('triage.settings.readOnly')}
          </p>
        ) : null}
      </header>

      <SettingsSection
        action={canManage ? (
          <button className="workbench-button-secondary min-h-10 px-4" onClick={() => setRules((current) => [
            ...current,
            createEmptyRule(configuration.teamId, current.length),
          ])} type="button">{t('triage.settings.addRule')}</button>
        ) : undefined}
        description={t('triage.settings.rulesDescription')}
        title={t('triage.settings.rules')}
      >
        <div className="divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
          {rules.length === 0 ? <SettingsEmpty>{t('triage.settings.rulesEmpty')}</SettingsEmpty> : rules.map((rule, index) => (
            <div className="grid gap-3 py-4" key={rule.id}>
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                  <input
                    checked={rule.enabled}
                    disabled={!canManage}
                    onChange={(event) => setRules(updateAt(rules, index, { ...rule, enabled: event.target.checked }))}
                    type="checkbox"
                  />
                  {t('triage.settings.ruleEnabled')}
                </label>
                <input
                  aria-label={t('triage.settings.ruleName')}
                  className="workbench-input min-h-10 min-w-[220px] flex-1 px-3"
                  disabled={!canManage}
                  onChange={(event) => setRules(updateAt(rules, index, { ...rule, name: event.target.value }))}
                  value={rule.name}
                />
                {canManage ? (
                  <button className="min-h-10 px-3 text-sm font-semibold text-red-700" onClick={() => setRules(removeAt(rules, index))} type="button">
                    {t('triage.settings.remove')}
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                <SettingsInput
                  disabled={!canManage}
                  label={t('triage.settings.sourceKinds')}
                  value={rule.sourceKinds.join(', ')}
                  onChange={(value) => setRules(updateAt(rules, index, { ...rule, sourceKinds: parseSourceKinds(value) }))}
                />
                <SettingsInput
                  disabled={!canManage}
                  label={t('triage.settings.keywords')}
                  value={rule.keywords.join(', ')}
                  onChange={(value) => setRules(updateAt(rules, index, { ...rule, keywords: parseList(value) }))}
                />
                <SettingsInput
                  disabled={!canManage}
                  label={t('triage.settings.targetTeam')}
                  value={rule.teamId}
                  onChange={(value) => setRules(updateAt(rules, index, { ...rule, teamId: value }))}
                />
                <SettingsInput
                  disabled={!canManage}
                  label={t('triage.settings.targetProject')}
                  value={rule.projectId ?? ''}
                  onChange={(value) => setRules(updateAt(rules, index, { ...rule, projectId: value || undefined }))}
                />
                <SettingsInput
                  disabled={!canManage}
                  label={t('triage.settings.ownerStrategy')}
                  value={formatOwnerStrategy(rule.owner)}
                  onChange={(value) => setRules(updateAt(rules, index, { ...rule, owner: parseOwnerStrategy(value) }))}
                />
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        description={t('triage.settings.bulkActionsDescription')}
        title={t('triage.settings.bulkActions')}
      >
        <fieldset
          className="grid grid-cols-3 border-y border-[var(--workbench-border)] max-[720px]:grid-cols-1"
          disabled={!canManage}
        >
          <legend className="sr-only">{t('triage.settings.bulkActions')}</legend>
          {bulkActionOptions.map(({ action, labelKey }) => (
            <label
              className="inline-flex min-h-12 items-center gap-3 border-r border-[var(--workbench-border)] px-3 text-sm font-semibold text-[var(--workbench-text)] last:border-r-0 max-[720px]:border-b max-[720px]:border-r-0 max-[720px]:last:border-b-0"
              key={action}
            >
              <input
                checked={allowedBulkActions.includes(action)}
                name="allowedBulkActions"
                onChange={(event) => setAllowedBulkActions(toggleBulkAction(
                  allowedBulkActions,
                  action,
                  event.target.checked,
                ))}
                type="checkbox"
                value={action}
              />
              {t(labelKey)}
            </label>
          ))}
        </fieldset>
      </SettingsSection>

      <SettingsSection
        action={canManage ? (
          <button className="workbench-button-secondary min-h-10 px-4" onClick={() => setRotations((current) => [
            ...current,
            { id: `rotation-${current.length + 1}`, memberUserIds: [], name: '', nextIndex: 0 },
          ])} type="button">{t('triage.settings.addRotation')}</button>
        ) : undefined}
        description={t('triage.settings.rotationsDescription')}
        title={t('triage.settings.rotations')}
      >
        <div className="divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
          {rotations.length === 0 ? <SettingsEmpty>{t('triage.settings.rotationsEmpty')}</SettingsEmpty> : rotations.map((rotation, index) => (
            <div className="grid grid-cols-[minmax(180px,0.5fr)_minmax(240px,1fr)_auto] gap-3 py-4 max-[720px]:grid-cols-1" key={rotation.id}>
              <SettingsInput
                disabled={!canManage}
                label={t('triage.settings.rotationName')}
                value={rotation.name}
                onChange={(value) => setRotations(updateAt(rotations, index, { ...rotation, name: value }))}
              />
              <SettingsInput
                disabled={!canManage}
                label={t('triage.settings.rotationMembers')}
                value={rotation.memberUserIds.join(', ')}
                onChange={(value) => setRotations(updateAt(rotations, index, { ...rotation, memberUserIds: parseList(value) }))}
              />
              {canManage ? (
                <button className="min-h-10 self-end px-3 text-sm font-semibold text-red-700" onClick={() => setRotations(removeAt(rotations, index))} type="button">
                  {t('triage.settings.remove')}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        action={canManage ? (
          <button className="workbench-button-secondary min-h-10 px-4" onClick={() => setSlaPolicies((current) => [
            ...current,
            { id: `sla-${current.length + 1}`, name: '', responseMinutes: 240, sourceKinds: [] },
          ])} type="button">{t('triage.settings.addSla')}</button>
        ) : undefined}
        description={t('triage.settings.slaDescription')}
        title={t('triage.settings.sla')}
      >
        <div className="divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
          {slaPolicies.length === 0 ? <SettingsEmpty>{t('triage.settings.slaEmpty')}</SettingsEmpty> : slaPolicies.map((policy, index) => (
            <div className="grid gap-3 py-4" key={policy.id}>
              <div className="flex items-end gap-3">
                <SettingsInput
                  disabled={!canManage}
                  label={t('triage.settings.slaName')}
                  value={policy.name}
                  onChange={(value) => setSlaPolicies(updateAt(slaPolicies, index, { ...policy, name: value }))}
                />
                {canManage ? (
                  <button className="min-h-10 px-3 text-sm font-semibold text-red-700" onClick={() => setSlaPolicies(removeAt(slaPolicies, index))} type="button">
                    {t('triage.settings.remove')}
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                <SettingsInput
                  disabled={!canManage}
                  label={t('triage.settings.sourceKinds')}
                  value={policy.sourceKinds.join(', ')}
                  onChange={(value) => setSlaPolicies(updateAt(slaPolicies, index, { ...policy, sourceKinds: parseSourceKinds(value) }))}
                />
                <SettingsNumberInput
                  disabled={!canManage}
                  label={t('triage.settings.responseMinutes')}
                  value={policy.responseMinutes}
                  onChange={(value) => setSlaPolicies(updateAt(slaPolicies, index, { ...policy, responseMinutes: value }))}
                />
                <SettingsNumberInput
                  disabled={!canManage}
                  label={t('triage.settings.escalationMinutes')}
                  value={policy.escalationMinutes ?? 0}
                  onChange={(value) => setSlaPolicies(updateAt(slaPolicies, index, { ...policy, escalationMinutes: value || undefined }))}
                />
                <SettingsInput
                  disabled={!canManage}
                  label={t('triage.settings.escalationOwner')}
                  value={policy.escalationOwnerUserId ?? ''}
                  onChange={(value) => setSlaPolicies(updateAt(slaPolicies, index, { ...policy, escalationOwnerUserId: value || undefined }))}
                />
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection description={t('triage.settings.retentionDescription')} title={t('triage.settings.retention')}>
        <SettingsNumberInput
          disabled={!canManage}
          label={t('triage.settings.retentionDays')}
          value={retentionDays}
          onChange={setRetentionDays}
        />
      </SettingsSection>

      {errorMessage || localError ? (
        <p className="text-sm font-semibold text-red-700" role="alert">{errorMessage ?? t('triage.settings.saveError')}</p>
      ) : didSave ? (
        <p className="text-sm font-semibold text-emerald-700" role="status">{t('triage.settings.saved')}</p>
      ) : null}

      {canManage ? (
        <div className="sticky bottom-0 flex justify-end border-t border-[var(--workbench-border)] bg-white py-4">
          <button className="workbench-button-primary min-h-10 px-5" disabled={isSaving} type="submit">
            {isSaving ? t('triage.settings.saving') : t('triage.settings.save')}
          </button>
        </div>
      ) : null}
    </form>
  )
}

/** Adds or removes one bulk action while preserving the canonical display order. */
function toggleBulkAction(
  current: readonly TriageBulkOperation['action'][],
  action: TriageBulkOperation['action'],
  enabled: boolean,
): TriageBulkOperation['action'][] {
  const selected = new Set(current)
  if (enabled) selected.add(action)
  else selected.delete(action)
  return bulkActionOptions
    .map((option) => option.action)
    .filter((candidate) => selected.has(candidate))
}

/** Renders one configuration section with an optional section action. */
function SettingsSection({ action, children, description, title }: {
  action?: React.ReactNode
  children: React.ReactNode
  description: string
  title: string
}) {
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--workbench-text)]">{title}</h3>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Renders one labeled text configuration input. */
function SettingsInput({ disabled, label, onChange, value }: {
  disabled: boolean
  label: string
  onChange: (value: string) => void
  value: string
}) {
  return (
    <label className="grid min-w-0 flex-1 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <input className="workbench-input min-h-10 min-w-0 px-3" disabled={disabled} onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  )
}

/** Renders one labeled non-negative configuration input. */
function SettingsNumberInput({ disabled, label, onChange, value }: {
  disabled: boolean
  label: string
  onChange: (value: number) => void
  value: number
}) {
  return (
    <label className="grid min-w-0 flex-1 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <input className="workbench-input min-h-10 min-w-0 px-3" disabled={disabled} min="0" onChange={(event) => onChange(Number(event.target.value) || 0)} type="number" value={value} />
    </label>
  )
}

/** Renders a section-level configuration empty state. */
function SettingsEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-5 text-sm font-medium text-[var(--workbench-muted)]">{children}</p>
}

/** Renders the stable configuration loading skeleton. */
function SettingsLoading({ label }: { label: string }) {
  return (
    <section aria-label={label} className="animate-pulse p-6 motion-reduce:animate-none" role="status">
      <div className="h-7 w-64 rounded bg-slate-200" />
      <div className="mt-8 h-40 rounded bg-slate-100" />
      <div className="mt-6 h-32 rounded bg-slate-100" />
    </section>
  )
}

/** Creates an editable blank routing rule scoped to the current Team. */
function createEmptyRule(teamId: string, order: number): TriageRoutingRule {
  return {
    enabled: true,
    id: `rule-${order + 1}`,
    keywords: [],
    name: '',
    order,
    owner: { type: 'unowned' },
    sourceKinds: [],
    teamId,
  }
}

/** Parses and deduplicates a comma-separated configuration list. */
function parseList(value: string) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
}

/** Parses supported source kinds from a comma-separated value. */
function parseSourceKinds(value: string): TriageSourceKind[] {
  return parseList(value).filter(isSourceKind)
}

/** Checks whether a string is a supported source kind. */
function isSourceKind(value: string): value is TriageSourceKind {
  return value === 'form' || value === 'chat' || value === 'email' ||
    value === 'webhook' || value === 'manual-handoff'
}

/** Formats an owner strategy as an editable compact value. */
function formatOwnerStrategy(owner: TriageOwnerStrategy) {
  if (owner.type === 'fixed') return `fixed:${owner.ownerUserId}`
  if (owner.type === 'rotation') return `rotation:${owner.rotationId}`
  return 'unowned'
}

/** Parses a compact owner-strategy value with an unowned fallback. */
function parseOwnerStrategy(value: string): TriageOwnerStrategy {
  const [type, ...rest] = value.trim().split(':')
  const identifier = rest.join(':').trim()
  if (type === 'fixed' && identifier) return { ownerUserId: identifier, type: 'fixed' }
  if (type === 'rotation' && identifier) return { rotationId: identifier, type: 'rotation' }
  return { type: 'unowned' }
}

/** Replaces one immutable array entry by index. */
function updateAt<Value>(values: readonly Value[], index: number, value: Value) {
  return values.map((current, currentIndex) => currentIndex === index ? value : current)
}

/** Removes one immutable array entry by index. */
function removeAt<Value>(values: readonly Value[], index: number) {
  return values.filter((_, currentIndex) => currentIndex !== index)
}
