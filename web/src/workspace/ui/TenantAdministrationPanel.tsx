import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSWRConfig } from 'swr'
import type {
  TenantFeature,
  TenantOperation,
  TenantPlan,
  TenantProfile,
  TenantGovernancePolicy,
  TenantEntitlement,
  TenantAdministrationSnapshot,
} from '@mukuroji/contracts'
import {
  pauseTenantOperation,
  requestTenantClosure,
  requestTenantExport,
  resumeTenantOperation,
  updateTenantEntitlement,
  updateTenantGovernance,
  updateTenantProfile,
  verifyTenantClosure,
  WorkspaceAccessApiError,
} from '../api'
import {
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../../shared/api/mutationHeaders'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { InfoGrid, SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import { useTenantAdministration } from '../queries/useTenantAdministration'

/** Props for the tenant administration panel container. */
type TenantAdministrationPanelContainerProps = {
  /** Bearer token used for authenticated tenant administration requests. */
  accessToken: string
  /** Locale used for labels and workflow copy. */
  locale: Locale
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

/** Supported commercial plans shown as entitlement controls. */
const tenantPlans: readonly TenantPlan[] = ['starter', 'growth', 'enterprise']

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
  const { mutate: mutateCache } = useSWRConfig()
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const {
    data,
    error,
    isLoading,
    key,
  } = useTenantAdministration(accessToken)
  const [profile, setProfile] = useState<TenantProfile>()
  const [entitlement, setEntitlement] = useState<TenantEntitlement>()
  const [governance, setGovernance] = useState<TenantGovernancePolicy>()
  const [activeOperation, setActiveOperation] = useState<TenantOperation>()
  const [exportFormat, setExportFormat] = useState<'jsonl' | 'csv'>('jsonl')
  const [closureConfirmation, setClosureConfirmation] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [actionError, setActionError] = useState<string>()

  useEffect(() => {
    if (!data) return
    setProfile(data.profile)
    setEntitlement(data.entitlement)
    setGovernance(data.governance)
    setActiveOperation(data.activeOperation)
  }, [data])

  const refresh = async () => {
    if (!key) return
    await mutateCache(key)
  }

  const runMutation = async <Result,>(
    operationKey: string,
    fingerprint: string,
    request: (context: MutationRequestContext) => Promise<Result>,
  ) => {
    setIsSaving(true)
    setActionError(undefined)
    try {
      await mutationRunner.run(operationKey, fingerprint, request)
      await refresh()
    } catch (mutationError) {
      setActionError(
        mutationError instanceof WorkspaceAccessApiError
          ? mutationError.message
          : t('workspace.tenantAdministration.error'),
      )
    } finally {
      setIsSaving(false)
    }
  }

  const saveProfile = () => {
    if (!profile) return
    void runMutation(
      'tenant-profile',
      JSON.stringify(profile),
      (context) => updateTenantProfile(accessToken, {
        region: profile.region,
        locale: profile.locale,
        defaultPolicy: profile.defaultPolicy,
        expectedRevision: profile.revision,
      }, context),
    )
  }

  const saveEntitlement = () => {
    if (!entitlement) return
    void runMutation(
      'tenant-entitlement',
      JSON.stringify(entitlement),
      (context) => updateTenantEntitlement(accessToken, {
        plan: entitlement.plan,
        features: entitlement.features,
        seatLimit: entitlement.seatLimit,
        usageQuota: entitlement.usageQuota,
        gracePeriodDays: entitlement.gracePeriodDays,
        expectedRevision: entitlement.revision,
      }, context),
    )
  }

  const saveGovernance = () => {
    if (!governance) return
    void runMutation(
      'tenant-governance',
      JSON.stringify(governance),
      (context) => updateTenantGovernance(accessToken, {
        auditRetentionDays: governance.auditRetentionDays,
        legalHold: governance.legalHold,
        dataResidency: governance.dataResidency,
        encryptionKeyPolicy: governance.encryptionKeyPolicy,
        expectedRevision: governance.revision,
      }, context),
    )
  }

  const runOperation = (
    operation: TenantOperation,
    action: 'pause' | 'resume' | 'verify',
  ) => {
    void runMutation(
      `tenant-operation-${operation.operationId}`,
      `${operation.operationId}:${action}:${operation.revision}`,
      (context) => {
        const request = action === 'pause'
          ? pauseTenantOperation
          : action === 'resume'
            ? resumeTenantOperation
            : verifyTenantClosure
        return request(accessToken, operation.operationId, context)
      },
    )
  }

  const requestExportAction = () => {
    void runMutation(
      'tenant-export',
      `export:${exportFormat}`,
      (context) => requestTenantExport(accessToken, { format: exportFormat }, context),
    )
  }

  const requestClosureAction = () => {
    if (closureConfirmation !== 'CLOSE') return
    void runMutation(
      'tenant-closure',
      'closure:CLOSE',
      (context) => requestTenantClosure(accessToken, { confirmation: 'CLOSE' }, context),
    )
    setClosureConfirmation('')
  }

  if (isLoading) {
    return <section className="workbench-panel p-5">{t('workspace.tenantAdministration.loading')}</section>
  }
  if (error || !data || !profile || !entitlement || !governance) {
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
      entitlement={entitlement}
      exportFormat={exportFormat}
      governance={governance}
      isSaving={isSaving}
      locale={locale}
      onChangeClosureConfirmation={setClosureConfirmation}
      onChangeExportFormat={setExportFormat}
      onChangeEntitlement={setEntitlement}
      onChangeGovernance={setGovernance}
      onChangeProfile={setProfile}
      onPauseOperation={(operation) => runOperation(operation, 'pause')}
      onRequestClosure={requestClosureAction}
      onRequestExport={requestExportAction}
      onResumeOperation={(operation) => runOperation(operation, 'resume')}
      onSaveEntitlement={saveEntitlement}
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
  /** Editable entitlement draft. */
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
  /** Changes the entitlement draft. */
  onChangeEntitlement: (value: TenantEntitlement) => void
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
  /** Saves entitlement changes. */
  onSaveEntitlement: () => void
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
function TenantAdministrationPanel({
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
  onChangeEntitlement,
  onChangeGovernance,
  onChangeProfile,
  onPauseOperation,
  onRequestClosure,
  onRequestExport,
  onResumeOperation,
  onSaveEntitlement,
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

  return (
    <section className="workbench-panel overflow-hidden" data-testid="tenant-administration-panel">
      <div className="border-b border-[var(--workbench-border)] bg-[linear-gradient(110deg,#eef9f7_0%,#ffffff_58%,#fff7ef_100%)] px-5 py-6 sm:px-7">
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
            {profile.region}
          </div>
        </div>
        {actionError ? (
          <p className="mt-4 rounded-lg border border-[#f1c4b8] bg-[#fff8f5] px-3 py-2 text-sm font-semibold text-[#9e3d27]" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 border-b border-[var(--workbench-border)] p-5 sm:grid-cols-3 sm:p-7">
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

      <div className="grid gap-5 p-5 sm:p-7 xl:grid-cols-2">
        <section className="rounded-xl border border-[var(--workbench-border)] bg-white p-5">
          <SectionHeader title={t('workspace.tenantAdministration.profileTitle')} meta={t('workspace.tenantAdministration.profileMeta')} />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.region')}
              <input
                className="workbench-input"
                onChange={(event) => onChangeProfile({ ...profile, region: event.target.value })}
                value={profile.region}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.locale')}
              <select
                className="workbench-input"
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
          <label className="mt-4 flex items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
            <input
              checked={profile.defaultPolicy.allowExternalCollaborators}
              onChange={(event) => onChangeProfile({
                ...profile,
                defaultPolicy: { ...profile.defaultPolicy, allowExternalCollaborators: event.target.checked },
              })}
              type="checkbox"
            />
            {t('workspace.tenantAdministration.allowExternal')}
          </label>
          <label className="mt-3 flex items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
            <input
              checked={profile.defaultPolicy.requireMfa}
              onChange={(event) => onChangeProfile({
                ...profile,
                defaultPolicy: { ...profile.defaultPolicy, requireMfa: event.target.checked },
              })}
              type="checkbox"
            />
            {t('workspace.tenantAdministration.requireMfa')}
          </label>
          <button className="workbench-button-primary mt-5" disabled={isSaving} onClick={onSaveProfile} type="button">
            {t('workspace.tenantAdministration.saveProfile')}
          </button>
        </section>

        <section className="rounded-xl border border-[var(--workbench-border)] bg-white p-5">
          <SectionHeader title={t('workspace.tenantAdministration.entitlementTitle')} meta={t('workspace.tenantAdministration.entitlementMeta')} />
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.plan')}
              <select
                className="workbench-input"
                onChange={(event) => onChangeEntitlement({ ...entitlement, plan: readPlan(event.target.value) })}
                value={entitlement.plan}
              >
                {tenantPlans.map((plan) => <option key={plan} value={plan}>{plan}</option>)}
              </select>
            </label>
            <NumberField label={t('workspace.tenantAdministration.seatLimit')} value={entitlement.seatLimit} onChange={(value) => onChangeEntitlement({ ...entitlement, seatLimit: value })} />
            <NumberField label={t('workspace.tenantAdministration.usageQuota')} value={entitlement.usageQuota} onChange={(value) => onChangeEntitlement({ ...entitlement, usageQuota: value })} />
          </div>
          <fieldset className="mt-4">
            <legend className="text-sm font-semibold text-[var(--workbench-text)]">{t('workspace.tenantAdministration.features')}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {tenantFeatures.map((feature) => {
                const checked = entitlement.features.includes(feature)
                return (
                  <label className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs font-semibold transition ${checked ? 'border-[#8acfc3] bg-[#ecfaf7] text-[var(--workbench-primary)]' : 'border-[var(--workbench-border)] text-[var(--workbench-muted)]'}`} key={feature}>
                    <input
                      checked={checked}
                      className="sr-only"
                      onChange={() => onChangeEntitlement({
                        ...entitlement,
                        features: checked ? entitlement.features.filter((candidate) => candidate !== feature) : [...entitlement.features, feature],
                      })}
                      type="checkbox"
                    />
                    {feature}
                  </label>
                )
              })}
            </div>
          </fieldset>
          <button className="workbench-button-primary mt-5" disabled={isSaving} onClick={onSaveEntitlement} type="button">
            {t('workspace.tenantAdministration.saveEntitlement')}
          </button>
        </section>

        <section className="rounded-xl border border-[var(--workbench-border)] bg-white p-5">
          <SectionHeader title={t('workspace.tenantAdministration.governanceTitle')} meta={t('workspace.tenantAdministration.governanceMeta')} />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <NumberField label={t('workspace.tenantAdministration.retention')} value={governance.auditRetentionDays} onChange={(value) => onChangeGovernance({ ...governance, auditRetentionDays: value })} />
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.dataResidency')}
              <input
                className="workbench-input"
                onChange={(event) => onChangeGovernance({ ...governance, dataResidency: event.target.value })}
                value={governance.dataResidency}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.encryption')}
              <select className="workbench-input" onChange={(event) => onChangeGovernance({ ...governance, encryptionKeyPolicy: event.target.value === 'customer-managed' ? 'customer-managed' : 'aws-managed' })} value={governance.encryptionKeyPolicy}>
                <option value="aws-managed">AWS managed</option>
                <option value="customer-managed">Customer managed</option>
              </select>
            </label>
          </div>
          <label className="mt-4 flex items-start gap-3 rounded-lg border border-[#f0d7a8] bg-[#fffaf0] p-3 text-sm font-semibold text-[#7b5b22]">
            <input checked={governance.legalHold} onChange={(event) => onChangeGovernance({ ...governance, legalHold: event.target.checked })} type="checkbox" />
            <span>{t('workspace.tenantAdministration.legalHold')}</span>
          </label>
          <button className="workbench-button-primary mt-5" disabled={isSaving} onClick={onSaveGovernance} type="button">
            {t('workspace.tenantAdministration.saveGovernance')}
          </button>
        </section>

        <section className="rounded-xl border border-[var(--workbench-border)] bg-[#fbfcfd] p-5">
          <SectionHeader title={t('workspace.tenantAdministration.lifecycleTitle')} meta={t('workspace.tenantAdministration.lifecycleMeta')} />
          {activeOperation ? (
            <div className="mt-5 rounded-lg border border-[#99d7cf] bg-[#f2fbf9] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                <span>{activeOperation.kind === 'export' ? t('workspace.tenantAdministration.exportOperation') : t('workspace.tenantAdministration.closureOperation')}</span>
                <span className="text-xs uppercase tracking-[0.08em] text-[var(--workbench-primary)]">{activeOperation.status}</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#d9eee9]">
                <div className="h-full rounded-full bg-[var(--workbench-primary)] transition-[width]" style={{ width: `${operationPercent}%` }} />
              </div>
              <p className="mt-2 text-xs font-semibold text-[var(--workbench-muted)]">{operationPercent}% · {activeOperation.currentStep ?? t('workspace.tenantAdministration.waiting')}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {(activeOperation.status === 'requested' || activeOperation.status === 'running') ? <button className="workbench-button-secondary" disabled={isSaving} onClick={() => onPauseOperation(activeOperation)} type="button">{t('workspace.tenantAdministration.pause')}</button> : null}
                {activeOperation.status === 'paused' ? <button className="workbench-button-secondary" disabled={isSaving} onClick={() => onResumeOperation(activeOperation)} type="button">{t('workspace.tenantAdministration.resume')}</button> : null}
                {activeOperation.kind === 'closure' && activeOperation.status === 'completed' ? <button className="workbench-button-primary" disabled={isSaving} onClick={() => onVerifyClosure(activeOperation)} type="button">{t('workspace.tenantAdministration.verify')}</button> : null}
              </div>
            </div>
          ) : null}
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-[var(--workbench-border)] bg-white p-4">
              <p className="text-sm font-semibold text-[var(--workbench-text)]">{t('workspace.tenantAdministration.exportTitle')}</p>
              <p className="mt-1 text-sm leading-6 text-[var(--workbench-muted)]">{t('workspace.tenantAdministration.exportDescription')}</p>
              <div className="mt-3 flex gap-2">
                <select className="workbench-input" onChange={(event) => onChangeExportFormat(event.target.value === 'csv' ? 'csv' : 'jsonl')} value={exportFormat}>
                  <option value="jsonl">JSONL</option>
                  <option value="csv">CSV</option>
                </select>
                <button className="workbench-button-secondary" disabled={isSaving || Boolean(activeOperation)} onClick={onRequestExport} type="button">{t('workspace.tenantAdministration.startExport')}</button>
              </div>
            </div>
            <div className="rounded-lg border border-[#f1c4b8] bg-[#fffaf8] p-4">
              <p className="text-sm font-semibold text-[#8d3c29]">{t('workspace.tenantAdministration.closureTitle')}</p>
              <p className="mt-1 text-sm leading-6 text-[#9e604f]">{t('workspace.tenantAdministration.closureDescription')}</p>
              <div className="mt-3 flex gap-2">
                <input aria-label={t('workspace.tenantAdministration.confirmationLabel')} className="workbench-input" onChange={(event) => onChangeClosureConfirmation(event.target.value)} placeholder="CLOSE" value={closureConfirmation} />
                <button className="workbench-button-danger" disabled={isSaving || Boolean(activeOperation) || governance.legalHold || closureConfirmation !== 'CLOSE'} onClick={onRequestClosure} type="button">{t('workspace.tenantAdministration.startClosure')}</button>
              </div>
            </div>
          </div>
        </section>
      </div>
      <InfoGrid items={[
        ['workspace.tenantAdministration.auditTitle', 'workspace.tenantAdministration.auditDescription'],
        ['workspace.tenantAdministration.residencyTitle', 'workspace.tenantAdministration.residencyDescription'],
        ['workspace.tenantAdministration.workflowTitle', 'workspace.tenantAdministration.workflowDescription'],
      ]} t={t} />
    </section>
  )
}

/** Compact usage metric with an optional progress bar. */
function TenantMetric({ label, value, progress }: { label: string; value: string; progress?: number }) {
  return (
    <div className="rounded-xl border border-[var(--workbench-border)] bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{label}</p>
      <p className="mt-2 text-xl font-semibold tracking-[-0.02em] text-[var(--workbench-text)]">{value}</p>
      {progress === undefined ? null : <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#e7efef]"><div className="h-full rounded-full bg-[var(--workbench-primary)]" style={{ width: `${progress}%` }} /></div>}
    </div>
  )
}

/** Numeric input used by tenant capacity and retention forms. */
function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <input className="workbench-input" min={0} onChange={(event) => onChange(Number(event.target.value))} type="number" value={value} />
    </label>
  )
}

function readPlan(value: string): TenantPlan {
  return value === 'growth' || value === 'enterprise' ? value : 'starter'
}
