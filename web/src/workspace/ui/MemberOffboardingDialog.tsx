import { useId, useState, type ReactNode } from 'react'
import type { WorkspaceMemberOffboarding } from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { useModalFocus } from '../../shared/ui/useModalFocus'
import type { WorkspaceMember } from '../api/access'
import {
  formatAccessExpiryLastDay,
  listOffboardingSuccessors,
  readAccessExpiryFromLastDay,
} from '../model/memberAccessExpiry'
import type { MemberOffboardingActions } from '../mutations/useMemberOffboardingActions'

/** What the offboarding dialog is loading or showing. */
export type MemberOffboardingLoadState =
  | {
    /** The summary is being read. */
    status: 'loading'
  }
  | {
    /** Reading the summary failed. */
    status: 'failed'
  }
  | {
    /** The summary was read. */
    status: 'loaded'
    /** What the member manages, owns, or created. */
    offboarding: WorkspaceMemberOffboarding
  }

/** Props of {@link MemberOffboardingDialog}. */
export type MemberOffboardingDialogProps = {
  /** The handover summary, or whether it is still loading or failed. */
  loadState: MemberOffboardingLoadState
  /** Reads the summary again. */
  onReload: () => void
  /** Handover and revocation actions. */
  actions: MemberOffboardingActions
  /** Member who is leaving, as the member list shows them now. */
  member: WorkspaceMember
  /** Every Workspace member; active, unexpired non-guest members other than `member` can take over. */
  members: readonly WorkspaceMember[]
  /** Whether the administrator can set an access expiry on the member. */
  canEditAccessExpiry: boolean
  /**
   * Saves or clears the member's access expiry.
   *
   * @param accessExpiresAt - ISO 8601 instant access ends, or null to clear it.
   * @param expectedVersion - Member version the change was made against, so a change another
   *   administrator saved meanwhile is reported as a conflict instead of overwritten.
   */
  onSaveAccessExpiry: (accessExpiresAt: string | null, expectedVersion: number) => Promise<void>
  /** Opens the handover of the member's open Work Items; absent hides the link. */
  onOpenWorkHandover?: () => void
  /** Display locale of dates. */
  locale: Locale
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Closes the dialog. */
  onClose: () => void
}

/** A step of the dialog that is running. */
type OffboardingStep = 'projects' | 'planning' | 'credentials' | 'expiry-save' | 'expiry-clear'

/**
 * Shows on one screen everything a leaving member must hand over before deactivation, and hands
 * it over: Project manager roles, Planning ownership, private Document management, open Work
 * Items, API keys and OAuth apps, Webhooks, and the member's access expiry.
 *
 * @param props - Summary, actions, member, candidates, and close callback.
 * @returns The dialog.
 */
export function MemberOffboardingDialog({
  loadState,
  onReload,
  actions,
  member,
  members,
  canEditAccessExpiry,
  onSaveAccessExpiry,
  onOpenWorkHandover,
  locale,
  t,
  onClose,
}: MemberOffboardingDialogProps) {
  const titleId = useId()
  const lastDayId = useId()
  const [successorKey, setSuccessorKey] = useState('')
  const [lastDay, setLastDay] = useState(() => formatAccessExpiryLastDay(member.accessExpiresAt))
  // The member version the last-day field was filled from, with the value it was filled with.
  const [expiryBase, setExpiryBase] = useState(() => ({
    version: member.version,
    lastDay: formatAccessExpiryLastDay(member.accessExpiresAt),
  }))
  if (member.version !== expiryBase.version && lastDay === expiryBase.lastDay) {
    // The field was not edited, so it follows the member's newer expiry and version. An edited
    // field keeps the version it was based on, and saving it reports the conflict.
    const next = { version: member.version, lastDay: formatAccessExpiryLastDay(member.accessExpiresAt) }
    setExpiryBase(next)
    setLastDay(next.lastDay)
  }
  const [busy, setBusy] = useState<OffboardingStep>()
  const [errorMessage, setErrorMessage] = useState<string>()
  const dialogRef = useModalFocus<HTMLElement>(() => {
    if (!busy) onClose()
  })

  const successors = listOffboardingSuccessors(member.memberKey, members, new Date())
  const offboarding = loadState.status === 'loaded' ? loadState.offboarding : undefined
  const lastDayExpiry = readAccessExpiryFromLastDay(lastDay)
  const dateFormat = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium' })
  const formatLastDay = (accessExpiresAt: string) => {
    const value = formatAccessExpiryLastDay(accessExpiresAt)
    return value ? dateFormat.format(new Date(`${value}T00:00:00`)) : accessExpiresAt
  }

  /**
   * Runs one step and shows a safe message when it fails.
   *
   * @param step - Step shown as busy while it runs.
   * @param action - Requests of the step.
   */
  const run = async (step: OffboardingStep, action: () => Promise<void>) => {
    setBusy(step)
    setErrorMessage(undefined)
    try {
      await action()
    } catch {
      // The summary is read again after every step, so it shows what is still left.
      setErrorMessage(t('workspace.access.offboarding.error'))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onMouseDown={() => {
        if (!busy) onClose()
      }}
    >
      <section
        aria-busy={busy !== undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="workbench-panel flex max-h-full w-full max-w-[720px] flex-col overflow-hidden shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
        data-testid="member-offboarding-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5">
          <h2 className="text-xl font-semibold text-[var(--workbench-text)]" id={titleId}>
            {t('workspace.access.offboarding.title').replace('{member}', member.name?.trim() || member.email)}
          </h2>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workspace.access.offboarding.description')}
          </p>
        </div>
        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-6">
          {loadState.status === 'loading' ? (
            <p className="text-sm font-semibold text-[var(--workbench-muted)]" role="status">
              {t('workspace.access.offboarding.loading')}
            </p>
          ) : loadState.status === 'failed' ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('workspace.access.offboarding.loadError')}</p>
              <button className="workbench-button-secondary min-h-9 px-3" type="button" onClick={onReload}>
                {t('workspace.access.offboarding.retry')}
              </button>
            </div>
          ) : offboarding ? (
            <>
              <p
                className={`rounded-lg border px-4 py-3 text-sm font-semibold ${offboarding.canDeactivate
                  ? 'border-emerald-200 bg-emerald-50 text-fg-emerald-700'
                  : 'border-amber-200 bg-amber-50 text-fg-amber-700'}`}
                data-testid="member-offboarding-readiness"
                role="status"
              >
                {t(offboarding.canDeactivate ? 'workspace.access.offboarding.ready' : 'workspace.access.offboarding.blocked')}
              </p>

              {offboarding.managedProjects.length > 0 || offboarding.ownedPlanningEntities.length > 0 ? (
                <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('workspace.access.offboarding.successor')}
                  <select
                    className="workbench-input min-h-10 px-3"
                    data-testid="member-offboarding-successor"
                    disabled={busy !== undefined}
                    value={successorKey}
                    onChange={(event) => setSuccessorKey(event.target.value)}
                  >
                    <option value="">{t('workspace.access.offboarding.successorPlaceholder')}</option>
                    {successors.map((candidate) => (
                      <option key={candidate.memberKey} value={candidate.memberKey}>
                        {candidate.name?.trim() ? `${candidate.name.trim()} (${candidate.email})` : candidate.email}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <OffboardingSection
                count={offboarding.managedProjects.length}
                required
                t={t}
                testId="member-offboarding-projects"
                title={t('workspace.access.offboarding.projects.title')}
                action={offboarding.managedProjects.length > 0 ? (
                  <button
                    className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-60"
                    data-testid="member-offboarding-projects-transfer"
                    disabled={busy !== undefined || !successorKey}
                    type="button"
                    onClick={() => void run('projects', () => actions.transferProjects(offboarding, successorKey))}
                  >
                    {t('workspace.access.offboarding.projects.transfer')}
                  </button>
                ) : undefined}
                note={offboarding.managedProjects.length > 0 ? t('workspace.access.offboarding.projects.rule') : undefined}
              >
                {offboarding.managedProjects.map((project) => (
                  <li key={`${project.teamId ?? ''}\0${project.projectId}`}>{project.name ?? project.projectId}</li>
                ))}
              </OffboardingSection>

              <OffboardingSection
                count={offboarding.ownedPlanningEntities.length}
                required
                t={t}
                testId="member-offboarding-planning"
                title={t('workspace.access.offboarding.planning.title')}
                action={offboarding.ownedPlanningEntities.length > 0 ? (
                  <button
                    className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-60"
                    data-testid="member-offboarding-planning-transfer"
                    disabled={busy !== undefined || !successorKey}
                    type="button"
                    onClick={() => void run('planning', () => actions.transferPlanningEntities(offboarding, successorKey))}
                  >
                    {t('workspace.access.offboarding.planning.transfer')}
                  </button>
                ) : undefined}
              >
                {offboarding.ownedPlanningEntities.map((entity) => (
                  <li key={entity.id}>{entity.title}</li>
                ))}
              </OffboardingSection>

              <OffboardingSection
                count={offboarding.managesPrivateDocuments ? 1 : 0}
                required
                t={t}
                testId="member-offboarding-documents"
                title={t('workspace.access.offboarding.documents.title')}
                note={offboarding.managesPrivateDocuments ? t('workspace.access.offboarding.documents.blocked') : undefined}
              />

              <OffboardingSection
                t={t}
                testId="member-offboarding-work"
                title={t('workspace.access.offboarding.work.title')}
                note={t('workspace.access.offboarding.work.description')}
                action={onOpenWorkHandover ? (
                  <button
                    className="workbench-button-secondary min-h-9 px-3"
                    data-testid="member-offboarding-work-open"
                    disabled={busy !== undefined}
                    type="button"
                    onClick={onOpenWorkHandover}
                  >
                    {t('workspace.access.offboarding.work.open')}
                  </button>
                ) : undefined}
              />

              <OffboardingSection
                count={offboarding.credentials.length}
                t={t}
                testId="member-offboarding-credentials"
                title={t('workspace.access.offboarding.credentials.title')}
                note={offboarding.credentials.length > 0 ? t('workspace.access.offboarding.credentials.note') : undefined}
                action={offboarding.credentials.length > 0 ? (
                  <button
                    className="min-h-9 rounded-md border border-red-200 bg-surface px-3 text-sm font-semibold text-fg-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-fg-slate-400"
                    data-testid="member-offboarding-credentials-revoke"
                    disabled={busy !== undefined}
                    type="button"
                    onClick={() => void run('credentials', actions.revokeCredentials)}
                  >
                    {t('workspace.access.offboarding.credentials.revoke')}
                  </button>
                ) : undefined}
              >
                {offboarding.credentials.map((credential) => (
                  <li key={`${credential.kind}:${credential.id}`}>
                    <span className="mr-2 workbench-badge-warning">
                      {t(credential.kind === 'api-key'
                        ? 'workspace.access.offboarding.credentials.apiKey'
                        : 'workspace.access.offboarding.credentials.oauthApp')}
                    </span>
                    {credential.name}
                  </li>
                ))}
              </OffboardingSection>

              <OffboardingSection
                count={offboarding.webhooks.length}
                t={t}
                testId="member-offboarding-webhooks"
                title={t('workspace.access.offboarding.webhooks.title')}
                note={offboarding.webhooks.length > 0 ? t('workspace.access.offboarding.webhooks.note') : undefined}
              >
                {offboarding.webhooks.map((webhook) => (
                  <li key={webhook.id}>{webhook.name}</li>
                ))}
              </OffboardingSection>

              <section className="grid gap-2 border-t border-[var(--workbench-border)] pt-4" data-testid="member-offboarding-expiry">
                <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('workspace.access.offboarding.expiry.title')}</h3>
                <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                  {t('workspace.access.offboarding.expiry.description')}
                </p>
                <p
                  className={`text-sm font-semibold ${offboarding.accessExpired ? 'text-fg-red-700' : 'text-[var(--workbench-text)]'}`}
                  data-testid="member-offboarding-expiry-current"
                >
                  {offboarding.accessExpired
                    ? t('workspace.access.offboarding.expiry.expired')
                    : offboarding.accessExpiresAt
                      ? t('workspace.access.offboarding.expiry.current').replace('{date}', formatLastDay(offboarding.accessExpiresAt))
                      : t('workspace.access.offboarding.expiry.unset')}
                </p>
                {canEditAccessExpiry ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={lastDayId}>
                      {t('workspace.access.offboarding.expiry.label')}
                      <input
                        className="workbench-input min-h-10 px-3 text-sm"
                        data-testid="member-offboarding-expiry-input"
                        disabled={busy !== undefined}
                        id={lastDayId}
                        type="date"
                        value={lastDay}
                        onChange={(event) => setLastDay(event.target.value)}
                      />
                    </label>
                    <button
                      className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
                      data-testid="member-offboarding-expiry-save"
                      disabled={busy !== undefined || !lastDayExpiry || lastDayExpiry === member.accessExpiresAt}
                      type="button"
                      onClick={() => {
                        if (lastDayExpiry) {
                          void run('expiry-save', async () => {
                            try {
                              await onSaveAccessExpiry(lastDayExpiry, expiryBase.version)
                            } catch (error) {
                              // A refused save, such as a conflict with another administrator,
                              // refills the field from the member's current expiry and version.
                              setExpiryBase({ version: Number.NaN, lastDay })
                              throw error
                            }
                            // The saved value is no longer an edit, so the newer version is taken up.
                            setExpiryBase({ version: expiryBase.version, lastDay })
                          })
                        }
                      }}
                    >
                      {t('workspace.access.offboarding.expiry.save')}
                    </button>
                    {member.accessExpiresAt ? (
                      <button
                        className="workbench-button-secondary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
                        data-testid="member-offboarding-expiry-clear"
                        disabled={busy !== undefined}
                        type="button"
                        onClick={() => void run('expiry-clear', async () => {
                          // Clearing acts on the expiry shown now, so it is based on the latest version.
                          await onSaveAccessExpiry(null, member.version)
                          setLastDay('')
                          setExpiryBase({ version: member.version, lastDay: '' })
                        })}
                      >
                        {t('workspace.access.offboarding.expiry.clear')}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-xs font-medium text-[var(--workbench-muted)]">
                    {t('workspace.access.offboarding.expiry.unavailable')}
                  </p>
                )}
              </section>
            </>
          ) : null}
          {errorMessage ? (
            <p className="text-sm font-semibold text-fg-red-700" role="alert">{errorMessage}</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-3 border-t border-[var(--workbench-border)] px-6 py-4">
          <button
            className="workbench-button-secondary min-h-10 px-4"
            data-autofocus
            disabled={busy !== undefined}
            type="button"
            onClick={onClose}
          >
            {t('workspace.access.offboarding.close')}
          </button>
        </div>
      </section>
    </div>
  )
}

/**
 * One group of things to hand over, with its count, items, note, and action.
 *
 * @param props - Title, count, whether it blocks deactivation, items, note, and action.
 * @returns The section.
 */
function OffboardingSection({
  title,
  count,
  required = false,
  note,
  action,
  children,
  testId,
  t,
}: {
  /** Heading of the group. */
  title: string
  /** Number of items; absent when the group has no count. */
  count?: number
  /** Whether items of the group block deactivation. */
  required?: boolean
  /** Explanation shown below the items. */
  note?: string | undefined
  /** Button that hands the group over. */
  action?: ReactNode
  /** List items of the group. */
  children?: ReactNode
  /** Test ID of the section. */
  testId: string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}) {
  const hasItems = count !== undefined && count > 0
  return (
    <section className="grid gap-2 border-t border-[var(--workbench-border)] pt-4 first:border-t-0 first:pt-0" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {title}
          {count !== undefined ? (
            <span className="text-[var(--workbench-muted)]">{count}</span>
          ) : null}
          {required && hasItems ? (
            <span className="workbench-badge-warning">{t('workspace.access.offboarding.required')}</span>
          ) : null}
        </h3>
        {action}
      </div>
      {hasItems && children ? (
        <ul className="grid gap-1 rounded-lg border border-[var(--workbench-border)] px-3 py-2 text-sm text-[var(--workbench-text)]">
          {children}
        </ul>
      ) : count === 0 ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('workspace.access.offboarding.none')}</p>
      ) : null}
      {note ? (
        <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">{note}</p>
      ) : null}
    </section>
  )
}
