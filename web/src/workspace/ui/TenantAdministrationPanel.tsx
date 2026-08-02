import {
  useMemo,
  useState,
} from 'react'
import type {
  TenantFeature,
  TenantOperation,
  TenantProfile,
  TenantGovernancePolicy,
  TenantEntitlement,
  TenantAdministrationSnapshot,
} from '@mukuroji/contracts'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import { useTenantAdministrationMutations } from '../mutations/useTenantAdministrationMutations'
import { useTenantAdministration } from '../queries/useTenantAdministration'

/** Props for the tenant administration panel container. */
type TenantAdministrationPanelContainerProps = {
  /** Bearer token used for authenticated tenant administration requests. */
  accessToken: string
  /** Locale used for labels and workflow copy. */
  locale: Locale
}

/** Editable server value pinned to the revision from which it was derived. */
type RevisionedDraft<Value> = {
  /** Server revision used to initialize the draft. */
  baseRevision: number
  /** Locally edited value. */
  value: Value
}

/** Supported tenant features shown as entitlement controls. */
const tenantFeatures: readonly TenantFeature[] = [
  'documents',
  'analytics',
  'automation',
  'developer-platform',
  'sso',
  'scim',
]

/** Flat governance notes displayed below tenant administration controls. */
const tenantAdministrationInfoItems: ReadonlyArray<
  readonly [MessageKey, MessageKey]
> = [
  [
    'workspace.tenantAdministration.auditTitle',
    'workspace.tenantAdministration.auditDescription',
  ],
  [
    'workspace.tenantAdministration.residencyTitle',
    'workspace.tenantAdministration.residencyDescription',
  ],
  [
    'workspace.tenantAdministration.workflowTitle',
    'workspace.tenantAdministration.workflowDescription',
  ],
]

/**
 * Connects tenant administration data and mutations to the settings view.
 *
 * @param props - Authenticated settings panel inputs.
 * @returns Tenant administration management UI.
 */
export function TenantAdministrationPanelContainer({
  accessToken,
  locale,
}: TenantAdministrationPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const {
    data,
    error,
    isLoading,
    mutate: refresh,
  } = useTenantAdministration(accessToken)
  const [profileDraft, setProfileDraft] = useState<RevisionedDraft<TenantProfile>>()
  const [governanceDraft, setGovernanceDraft] =
    useState<RevisionedDraft<TenantGovernancePolicy>>()
  const [exportFormat, setExportFormat] = useState<'jsonl' | 'csv'>('jsonl')
  const [closureConfirmation, setClosureConfirmation] = useState('')
  const mutations = useTenantAdministrationMutations({ accessToken, refresh })

  const profile = data && profileDraft?.baseRevision === data.profile.revision
    ? profileDraft.value
    : data?.profile
  const governance = data && governanceDraft?.baseRevision === data.governance.revision
    ? governanceDraft.value
    : data?.governance
  const activeOperation = data?.activeOperation
  const actionError = mutations.actionError?.kind === 'api'
    ? mutations.actionError.message
    : mutations.actionError
      ? t('workspace.tenantAdministration.error')
      : undefined

  const saveProfile = () => {
    if (!profile) return
    void mutations.saveProfile(profile)
  }

  const saveGovernance = () => {
    if (!governance) return
    void mutations.saveGovernance(governance)
  }

  const runOperation = (
    operation: TenantOperation,
    action: 'pause' | 'resume' | 'verify',
  ) => {
    void mutations.runOperation(operation, action)
  }

  const requestExportAction = () => {
    void mutations.requestExport(exportFormat)
  }

  const requestClosureAction = () => {
    if (closureConfirmation !== 'CLOSE') return
    void mutations.requestClosure(closureConfirmation).then((completed) => {
      if (completed) setClosureConfirmation('')
    })
  }

  if (isLoading) {
    return <section className="workbench-panel p-5">{t('workspace.tenantAdministration.loading')}</section>
  }
  if (error || !data || !profile || !governance) {
    return (
      <section className="workbench-panel border-[#f1c4b8] p-5" data-testid="tenant-administration-error">
        <SectionHeader
          title={t('workspace.tenantAdministration.title')}
          meta={t('workspace.tenantAdministration.loadError')}
        />
        <button className="workbench-button-secondary mt-4" onClick={() => void refresh()} type="button">
          {t('workspace.tenantAdministration.retry')}
        </button>
      </section>
    )
  }

  return (
    <TenantAdministrationPanel
      actionError={actionError}
      activeOperation={activeOperation}
      closureConfirmation={closureConfirmation}
      data={data}
      entitlement={data.entitlement}
      exportFormat={exportFormat}
      governance={governance}
      isSaving={mutations.isSaving}
      locale={locale}
      onChangeClosureConfirmation={setClosureConfirmation}
      onChangeExportFormat={setExportFormat}
      onChangeGovernance={(value) => setGovernanceDraft({
        baseRevision: data.governance.revision,
        value,
      })}
      onChangeProfile={(value) => setProfileDraft({
        baseRevision: data.profile.revision,
        value,
      })}
      onPauseOperation={(operation) => runOperation(operation, 'pause')}
      onRequestClosure={requestClosureAction}
      onRequestExport={requestExportAction}
      onResumeOperation={(operation) => runOperation(operation, 'resume')}
      onSaveGovernance={saveGovernance}
      onSaveProfile={saveProfile}
      onVerifyClosure={(operation) => runOperation(operation, 'verify')}
      profile={profile}
      t={t}
    />
  )
}

/** Props for the tenant administration presentational panel. */
type TenantAdministrationPanelProps = {
  /** Last mutation error shown below the control-plane header. */
  actionError?: string
  /** Currently active export or closure operation. */
  activeOperation?: TenantOperation
  /** Explicit closure confirmation field value. */
  closureConfirmation: string
  /** Current aggregate returned by the server. */
  data: TenantAdministrationSnapshot
  /** Read-only commercial entitlement assigned by the system control plane. */
  entitlement: TenantEntitlement
  /** Selected export format. */
  exportFormat: 'jsonl' | 'csv'
  /** Editable governance draft. */
  governance: TenantGovernancePolicy
  /** Whether a tenant mutation is in flight. */
  isSaving: boolean
  /** Locale used for option labels. */
  locale: Locale
  /** Editable profile draft. */
  profile: TenantProfile
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Changes the closure confirmation field. */
  onChangeClosureConfirmation: (value: string) => void
  /** Changes the export format. */
  onChangeExportFormat: (value: 'jsonl' | 'csv') => void
  /** Changes the governance draft. */
  onChangeGovernance: (value: TenantGovernancePolicy) => void
  /** Changes the profile draft. */
  onChangeProfile: (value: TenantProfile) => void
  /** Pauses one operation. */
  onPauseOperation: (operation: TenantOperation) => void
  /** Starts account closure after confirmation. */
  onRequestClosure: () => void
  /** Starts an export operation. */
  onRequestExport: () => void
  /** Resumes one paused operation. */
  onResumeOperation: (operation: TenantOperation) => void
  /** Saves governance changes. */
  onSaveGovernance: () => void
  /** Saves profile changes. */
  onSaveProfile: () => void
  /** Verifies a completed closure. */
  onVerifyClosure: (operation: TenantOperation) => void
}

/**
 * Renders the tenant control plane with profile, usage, governance, and lifecycle controls.
 *
 * @param props - Tenant aggregate, drafts, callbacks, and localized labels.
 * @returns Tenant administration settings panel.
 */
export function TenantAdministrationPanel({
  actionError,
  activeOperation,
  closureConfirmation,
  data,
  entitlement,
  exportFormat,
  governance,
  isSaving,
  locale,
  onChangeClosureConfirmation,
  onChangeExportFormat,
  onChangeGovernance,
  onChangeProfile,
  onPauseOperation,
  onRequestClosure,
  onRequestExport,
  onResumeOperation,
  onSaveGovernance,
  onSaveProfile,
  onVerifyClosure,
  profile,
  t,
}: TenantAdministrationPanelProps) {
  const usagePercent = Math.min(
    100,
    Math.round((data.usage.periodUsage / Math.max(entitlement.usageQuota, 1)) * 100),
  )
  const seatPercent = Math.min(
    100,
    Math.round((data.usage.activeSeats / Math.max(entitlement.seatLimit, 1)) * 100),
  )
  const operationSteps = activeOperation?.kind === 'export'
    ? 3
    : 6
  const operationPercent = activeOperation
    ? Math.round((activeOperation.completedSteps.length / operationSteps) * 100)
    : 0
  const tenantClosed = profile.status !== 'active'

  return (
    <section className="workbench-panel overflow-hidden" data-testid="tenant-administration-panel">
      <div className="border-b border-[var(--workbench-border)] bg-[#f1f7f5] px-5 py-6 sm:px-7">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="workbench-eyebrow">{t('workspace.tenantAdministration.eyebrow')}</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.title')}
            </h2>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t('workspace.tenantAdministration.description')}
            </p>
          </div>
          <div className="rounded-full border border-[#9dd8cf] bg-white/80 px-3 py-1.5 text-xs font-semibold tracking-[0.08em] text-[var(--workbench-primary)]">
            {profile.region} · {profile.status}
          </div>
        </div>
        {tenantClosed ? (
          <p className="mt-4 rounded-lg border border-[#f1c4b8] bg-[#fff8f5] px-3 py-2 text-sm font-semibold text-[#9e3d27]" role="status">
            {t(profile.status === 'closed'
              ? 'workspace.tenantAdministration.closed'
              : 'workspace.tenantAdministration.closing')}
          </p>
        ) : null}
        {actionError ? (
          <p className="mt-4 rounded-lg border border-[#f1c4b8] bg-[#fff8f5] px-3 py-2 text-sm font-semibold text-[#9e3d27]" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>

      <div className="grid border-b border-[var(--workbench-border)] px-5 py-6 sm:grid-cols-3 sm:divide-x sm:divide-[var(--workbench-border)] sm:px-7">
        <TenantMetric label={t('workspace.tenantAdministration.metric.plan')} value={entitlement.plan} />
        <TenantMetric
          label={t('workspace.tenantAdministration.metric.seats')}
          value={`${data.usage.activeSeats} / ${entitlement.seatLimit}`}
          progress={seatPercent}
        />
        <TenantMetric
          label={t('workspace.tenantAdministration.metric.usage')}
          value={`${data.usage.periodUsage.toLocaleString(locale)} / ${entitlement.usageQuota.toLocaleString(locale)}`}
          progress={usagePercent}
        />
      </div>

      <div className="grid px-5 sm:px-7 xl:grid-cols-2 xl:gap-x-8">
        <section className="border-t border-[var(--workbench-border)] py-7">
          <SectionHeader title={t('workspace.tenantAdministration.profileTitle')} meta={t('workspace.tenantAdministration.profileMeta')} />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.owner')}
              <input
                className="workbench-input"
                disabled
                readOnly
                value={profile.ownerMemberKey}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.region')}
              <input
                className="workbench-input"
                disabled
                readOnly
                value={data.governanceEnforcement.dataResidency}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.locale')}
              <select
                className="workbench-input"
                disabled={tenantClosed}
                onChange={(event) => onChangeProfile({ ...profile, locale: event.target.value === 'en' ? 'en' : 'ja' })}
                value={profile.locale}
              >
                <option value="ja">日本語</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.defaultRole')}
              <select
                className="workbench-input"
                disabled={tenantClosed}
                onChange={(event) => onChangeProfile({
                  ...profile,
                  defaultPolicy: {
                    ...profile.defaultPolicy,
                    defaultMemberRole: event.target.value === 'guest' ? 'guest' : 'member',
                  },
                })}
                value={profile.defaultPolicy.defaultMemberRole}
              >
                <option value="member">{t('workspace.tenantAdministration.memberRole')}</option>
                <option value="guest">{t('workspace.tenantAdministration.guestRole')}</option>
              </select>
            </label>
          </div>
          <button className="workbench-button-primary mt-5" disabled={isSaving || tenantClosed} onClick={onSaveProfile} type="button">
            {t('workspace.tenantAdministration.saveProfile')}
          </button>
        </section>

        <section className="border-t border-[var(--workbench-border)] py-7">
          <SectionHeader title={t('workspace.tenantAdministration.entitlementTitle')} meta={t('workspace.tenantAdministration.entitlementMeta')} />
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.plan')}
              <input className="workbench-input" disabled readOnly value={entitlement.plan} />
            </label>
            <ReadOnlyNumberField label={t('workspace.tenantAdministration.seatLimit')} value={entitlement.seatLimit} />
            <ReadOnlyNumberField label={t('workspace.tenantAdministration.usageQuota')} value={entitlement.usageQuota} />
          </div>
          <fieldset className="mt-4">
            <legend className="text-sm font-semibold text-[var(--workbench-text)]">{t('workspace.tenantAdministration.features')}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {tenantFeatures.map((feature) => {
                const checked = entitlement.features.includes(feature)
                return (
                  <span className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${checked ? 'border-[#8acfc3] bg-[#ecfaf7] text-[var(--workbench-primary)]' : 'border-[var(--workbench-border)] text-[var(--workbench-muted)]'}`} key={feature}>
                    {feature}
                  </span>
                )
              })}
            </div>
          </fieldset>
          <div className="mt-5 border-t border-[var(--workbench-border)] pt-4">
            <p className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.invoiceHistory')}
            </p>
            <div className="mt-2 grid gap-2">
              {data.billingPeriods.slice(0, 3).map((period) => (
                <div className="flex items-center justify-between gap-3 border-b border-[var(--workbench-border)] py-2 text-xs last:border-b-0" key={period.periodStart}>
                  <span className="font-semibold text-[var(--workbench-text)]">
                    {period.periodStart.slice(0, 7)}
                  </span>
                  <span className="text-right text-[var(--workbench-muted)]">
                    {t('workspace.tenantAdministration.metric.usage')}: {' '}
                    {period.meteredUnits.toLocaleString(locale)} · {' '}
                    {t('workspace.tenantAdministration.metric.seats')}: {' '}
                    {period.activeSeatHighWaterMark.toLocaleString(locale)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-[var(--workbench-border)] py-7 xl:col-span-2">
          <SectionHeader title={t('workspace.tenantAdministration.governanceTitle')} meta={t('workspace.tenantAdministration.governanceMeta')} />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <NumberField disabled={tenantClosed} label={t('workspace.tenantAdministration.retention')} value={governance.auditRetentionDays} onChange={(value) => onChangeGovernance({ ...governance, auditRetentionDays: value })} />
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.dataResidency')}
              <input
                className="workbench-input"
                disabled
                readOnly
                value={data.governanceEnforcement.dataResidency}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.encryption')}
              <select className="workbench-input" disabled value={data.governanceEnforcement.encryptionKeyPolicy}>
                <option value={data.governanceEnforcement.encryptionKeyPolicy}>
                  {data.governanceEnforcement.encryptionKeyPolicy === 'customer-managed' ? 'Customer managed' : 'AWS managed'}
                </option>
              </select>
            </label>
          </div>
          <label className="mt-4 flex items-start gap-3 rounded-lg border border-[#f0d7a8] bg-[#fffaf0] p-3 text-sm font-semibold text-[#7b5b22]">
            <input checked={governance.legalHold} disabled={tenantClosed} onChange={(event) => onChangeGovernance({ ...governance, legalHold: event.target.checked })} type="checkbox" />
            <span>{t('workspace.tenantAdministration.legalHold')}</span>
          </label>
          {data.retentionReconciliation && (
            <p className="mt-3 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('workspace.tenantAdministration.retentionProgress')}: {' '}
              {data.retentionReconciliation.status} · {' '}
              {data.retentionReconciliation.processedEvents.toLocaleString(locale)}
            </p>
          )}
          <button className="workbench-button-primary mt-5" disabled={isSaving || tenantClosed} onClick={onSaveGovernance} type="button">
            {t('workspace.tenantAdministration.saveGovernance')}
          </button>
        </section>

        <section className="border-t border-[var(--workbench-border)] py-7 xl:col-span-2">
          <SectionHeader title={t('workspace.tenantAdministration.lifecycleTitle')} meta={t('workspace.tenantAdministration.lifecycleMeta')} />
          {activeOperation ? (
            <div className="mt-5 rounded-lg border border-[#99d7cf] bg-[#f2fbf9] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                <span>{activeOperation.kind === 'export' ? t('workspace.tenantAdministration.exportOperation') : t('workspace.tenantAdministration.closureOperation')}</span>
                <span className="text-xs uppercase tracking-[0.08em] text-[var(--workbench-primary)]">{activeOperation.status}</span>
              </div>
              <div
                aria-label={activeOperation.kind === 'export'
                  ? t('workspace.tenantAdministration.exportOperation')
                  : t('workspace.tenantAdministration.closureOperation')}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={operationPercent}
                className="mt-3 h-2 overflow-hidden rounded-full bg-[#d9eee9]"
                role="progressbar"
              >
                <div className="h-full rounded-full bg-[var(--workbench-primary)] transition-[width] motion-reduce:transition-none" style={{ width: `${operationPercent}%` }} />
              </div>
              <p className="mt-2 text-xs font-semibold text-[var(--workbench-muted)]">{operationPercent}% · {activeOperation.currentStep ?? t('workspace.tenantAdministration.waiting')}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {activeOperation.status === 'running' ? <button className="workbench-button-secondary" disabled={isSaving} onClick={() => onPauseOperation(activeOperation)} type="button">{t('workspace.tenantAdministration.pause')}</button> : null}
                {activeOperation.status === 'paused' ? <button className="workbench-button-secondary" disabled={isSaving} onClick={() => onResumeOperation(activeOperation)} type="button">{t('workspace.tenantAdministration.resume')}</button> : null}
                {activeOperation.kind === 'closure' && activeOperation.status === 'completed' ? <button className="workbench-button-primary" disabled={isSaving} onClick={() => onVerifyClosure(activeOperation)} type="button">{t('workspace.tenantAdministration.verify')}</button> : null}
              </div>
            </div>
          ) : null}
          <div className="mt-5 grid border-y border-[var(--workbench-border)] sm:grid-cols-2 sm:divide-x sm:divide-[var(--workbench-border)]">
            <div className="py-5 sm:pr-5">
              <p className="text-sm font-semibold text-[var(--workbench-text)]">{t('workspace.tenantAdministration.exportTitle')}</p>
              <p className="mt-1 text-sm leading-6 text-[var(--workbench-muted)]">{t('workspace.tenantAdministration.exportDescription')}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <select aria-label={t('workspace.tenantAdministration.exportFormat')} className="workbench-input" onChange={(event) => onChangeExportFormat(event.target.value === 'csv' ? 'csv' : 'jsonl')} value={exportFormat}>
                  <option value="jsonl">JSONL</option>
                  <option value="csv">CSV</option>
                </select>
                <button className="workbench-button-secondary" disabled={isSaving || tenantClosed || Boolean(activeOperation)} onClick={onRequestExport} type="button">{t('workspace.tenantAdministration.startExport')}</button>
              </div>
            </div>
            <div className="border-l-2 border-[#d76a4d] bg-[#fffaf8] px-4 py-5 sm:border-l-0 sm:pl-5">
              <p className="text-sm font-semibold text-[#8d3c29]">{t('workspace.tenantAdministration.closureTitle')}</p>
              <p className="mt-1 text-sm leading-6 text-[#9e604f]">{t('workspace.tenantAdministration.closureDescription')}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input aria-label={t('workspace.tenantAdministration.confirmationLabel')} className="workbench-input" onChange={(event) => onChangeClosureConfirmation(event.target.value)} placeholder="CLOSE" value={closureConfirmation} />
                <button className="workbench-button-danger" disabled={isSaving || tenantClosed || Boolean(activeOperation) || governance.legalHold || closureConfirmation !== 'CLOSE'} onClick={onRequestClosure} type="button">{t('workspace.tenantAdministration.startClosure')}</button>
              </div>
            </div>
          </div>
          {data.recentOperations.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.tenantAdministration.operationHistory')}
              </h3>
              <div className="mt-2 divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
                {data.recentOperations.map((operation) => (
                  <div className="grid gap-1 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4" key={operation.operationId}>
                    <div className="min-w-0">
                      <p className="font-semibold text-[var(--workbench-text)]">
                        {operation.kind} · {operation.status}
                      </p>
                      <p className="mt-1 break-all text-[var(--workbench-muted)]">
                        {operation.operationId}
                      </p>
                      {operation.lastEvidenceReference ? (
                        <p className="mt-1 break-all text-[var(--workbench-muted)]">
                          {t('workspace.tenantAdministration.operationEvidence')}: {' '}
                          {operation.lastEvidenceReference}
                        </p>
                      ) : null}
                      {operation.failureCode ? (
                        <p className="mt-1 font-semibold text-[#9e3d27]">
                          {t('workspace.tenantAdministration.operationFailure')}: {' '}
                          {operation.failureCode}
                        </p>
                      ) : null}
                    </div>
                    <p className="text-[var(--workbench-muted)] sm:text-right">
                      {formatTenantOperationTimestamp(operation.requestedAt, locale)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>
      <div className="grid border-t border-[var(--workbench-border)] bg-[#f8faf9] sm:grid-cols-3 sm:divide-x sm:divide-[var(--workbench-border)]">
        {tenantAdministrationInfoItems.map(([titleKey, descriptionKey]) => (
          <section className="px-5 py-5 sm:px-7" key={titleKey}>
            <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
              {t(titleKey)}
            </h3>
            <p className="mt-2 text-xs font-medium leading-5 tracking-[0.01em] text-[var(--workbench-muted)]">
              {t(descriptionKey)}
            </p>
          </section>
        ))}
      </div>
    </section>
  )
}

/** Formats one audited lifecycle timestamp for the active tenant locale. */
function formatTenantOperationTimestamp(timestamp: string, locale: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

/** Compact usage metric with an optional progress bar. */
function TenantMetric({ label, value, progress }: { label: string; value: string; progress?: number }) {
  return (
    <div className="py-1 sm:px-6 sm:first:pl-0 sm:last:pr-0">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{label}</p>
      <p className="mt-2 text-xl font-semibold tracking-[-0.02em] text-[var(--workbench-text)]">{value}</p>
      {progress === undefined ? null : <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#e7efef]"><div className="h-full rounded-full bg-[var(--workbench-primary)]" style={{ width: `${progress}%` }} /></div>}
    </div>
  )
}

/** Numeric input used by tenant capacity and retention forms. */
function NumberField({ disabled = false, label, value, onChange }: { disabled?: boolean; label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <input className="workbench-input" disabled={disabled} min={0} onChange={(event) => onChange(Number(event.target.value))} type="number" value={value} />
    </label>
  )
}

/** Read-only numeric field used for server-assigned commercial limits. */
function ReadOnlyNumberField({ label, value }: { label: string; value: number }) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <input className="workbench-input" disabled readOnly type="number" value={value} />
    </label>
  )
}
