import { useId, useState, type ChangeEvent } from 'react'
import { WORKSPACE_BULK_INVITATION_MAX_ROWS } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { WorkspaceAccess, WorkspaceRole } from '../api/access'
import { WorkspaceAccessApiError } from '../api/errors'
import type { CreateWorkspaceInvitationInput } from '../api/invitations'
import {
  createBulkInvitationRetryCsv,
  planBulkInvitation,
  type BulkInvitationPlan,
} from '../model/bulkInvitation'
import type { BulkInvitationOutcome } from '../mutations/bulkWorkspaceInvitations'

/** Largest CSV file the bulk invitation reads, in bytes. */
const maxCsvFileBytes = 1024 * 1024

/** Props of {@link WorkspaceBulkInvitePanel}. */
type WorkspaceBulkInvitePanelProps = {
  /** Current members and invitations the check compares the input with. */
  access: WorkspaceAccess
  /** Roles the signed-in administrator can grant, in display order. */
  availableRoles: readonly WorkspaceRole[]
  /** Translates a message key. */
  t: (key: MessageKey) => string
  /**
   * Sends the invitations and reports each outcome as it arrives.
   *
   * @param inputs - Invitations to send.
   * @param onOutcome - Called with each invitation's index and outcome.
   */
  onInviteMany: (
    inputs: CreateWorkspaceInvitationInput[],
    onOutcome: (index: number, outcome: BulkInvitationOutcome) => void,
  ) => Promise<unknown>
}

/** Outcome of a sent row, keyed by the row's index in the plan. */
type SentOutcomes = ReadonlyMap<number, BulkInvitationOutcome>

/**
 * Message key of the reason a failed invitation gives.
 *
 * @param error - Error the invitation failed with.
 * @returns Message key of the reason.
 */
function getFailureMessageKey(error: unknown): MessageKey {
  if (error instanceof WorkspaceAccessApiError) {
    switch (error.code) {
      case 'WorkspaceMemberAlreadyExists':
        return 'workspace.access.bulk.issue.already-member'
      case 'InvalidWorkspaceEmail':
        return 'workspace.access.bulk.issue.invalid-email'
      case 'InvalidWorkspaceInvitationName':
        return 'workspace.access.bulk.issue.name-too-long'
      case 'EnterpriseExternalAccessDenied':
      case 'EnterpriseGuestAccessDenied':
        return 'workspace.access.bulk.failure.policy'
      case 'CognitoUserDisabled':
        return 'workspace.access.error.cognitoUserDisabled'
      default:
        break
    }
    if (error.status === 409) return 'workspace.access.bulk.failure.conflict'
    if (error.status === 403) return 'workspace.access.error.forbidden'
    if (error.status === 429) return 'workspace.access.bulk.failure.rateLimited'
  }
  return 'workspace.access.bulk.failure.other'
}

/**
 * Invites many people at once from pasted addresses or a CSV file. It first checks the input
 * without sending anything, lists every row with what is wrong with it, and then sends only the
 * rows that can be sent, showing each row's result.
 */
export function WorkspaceBulkInvitePanel({
  access,
  availableRoles,
  onInviteMany,
  t,
}: WorkspaceBulkInvitePanelProps) {
  const fieldId = useId()
  const [text, setText] = useState('')
  const [defaultRole, setDefaultRole] = useState<WorkspaceRole>(
    availableRoles.includes('member') ? 'member' : availableRoles[0] ?? 'member',
  )
  const [plan, setPlan] = useState<BulkInvitationPlan | undefined>()
  const [outcomes, setOutcomes] = useState<SentOutcomes>(new Map())
  const [isSending, setIsSending] = useState(false)
  const [fileError, setFileError] = useState<string | undefined>()

  const resetPlan = () => {
    setPlan(undefined)
    setOutcomes(new Map())
  }

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > maxCsvFileBytes) {
      setFileError(t('workspace.access.bulk.fileTooLarge'))
      return
    }
    try {
      setText(await file.text())
      setFileError(undefined)
      resetPlan()
    } catch {
      setFileError(t('workspace.access.bulk.fileUnreadable'))
    }
  }

  const check = () => {
    setOutcomes(new Map())
    setPlan(planBulkInvitation(text, {
      allowedRoles: availableRoles,
      defaultRole,
      invitations: access.invitations,
      members: access.members,
    }))
  }

  const sendableIndexes = plan
    ? plan.rows.flatMap((row, index) => row.issue || outcomes.get(index)?.status === 'sent' ? [] : [index])
    : []
  const sentCount = [...outcomes.values()].filter((outcome) => outcome.status === 'sent').length
  const failedRows = plan
    ? plan.rows.filter((row, index) => row.issue || outcomes.get(index)?.status === 'failed')
    : []
  const hasSent = outcomes.size > 0

  const send = async () => {
    if (!plan || isSending || sendableIndexes.length === 0) return
    const indexes = sendableIndexes
    setIsSending(true)
    try {
      await onInviteMany(
        indexes.map((index) => {
          const row = plan.rows[index]
          return { email: row.email, name: row.name, role: row.role }
        }),
        (position, outcome) => {
          setOutcomes((current) => new Map(current).set(indexes[position], outcome))
        },
      )
    } finally {
      setIsSending(false)
    }
  }

  const keepFailedRows = () => {
    setText(createBulkInvitationRetryCsv(failedRows))
    resetPlan()
  }

  return (
    <section className="grid min-w-0 gap-4" data-testid="workspace-bulk-invite">
      <div>
        <p className="workbench-eyebrow text-[var(--workbench-primary-text)]">{t('workspace.access.bulk.eyebrow')}</p>
        <h3 className="mt-1 text-base font-semibold text-[var(--workbench-text)]">{t('workspace.access.bulk.title')}</h3>
        <p className="mt-1 text-sm leading-6 text-[var(--workbench-muted)]">
          {t('workspace.access.bulk.description').replace('{max}', String(WORKSPACE_BULK_INVITATION_MAX_ROWS))}
        </p>
      </div>
      <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${fieldId}-text`}>
        {t('workspace.access.bulk.input')}
      </label>
      <textarea
        className="workbench-input min-h-32 px-3 py-2 font-mono text-sm"
        data-testid="workspace-bulk-invite-input"
        disabled={isSending}
        id={`${fieldId}-text`}
        placeholder={t('workspace.access.bulk.placeholder')}
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          resetPlan()
        }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
          {t('workspace.access.bulk.file')}
          <input
            accept=".csv,.txt,text/csv,text/plain"
            className="text-sm"
            data-testid="workspace-bulk-invite-file"
            disabled={isSending}
            type="file"
            onChange={(event) => void handleFile(event)}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
          {t('workspace.access.bulk.defaultRole')}
          <select
            className="workbench-input min-h-10 px-3"
            data-testid="workspace-bulk-invite-role"
            disabled={isSending}
            value={defaultRole}
            onChange={(event) => {
              const role = availableRoles.find((candidate) => candidate === event.target.value)
              if (role) {
                setDefaultRole(role)
                resetPlan()
              }
            }}
          >
            {availableRoles.map((role) => (
              <option key={role} value={role}>{t(`workspace.access.role.${role}`)}</option>
            ))}
          </select>
        </label>
        <button
          className="workbench-button-secondary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="workspace-bulk-invite-check"
          disabled={isSending || text.trim() === ''}
          type="button"
          onClick={check}
        >
          {t('workspace.access.bulk.check')}
        </button>
      </div>
      {fileError ? (
        <p className="text-sm font-semibold text-fg-red-700" role="alert">{fileError}</p>
      ) : null}

      {plan ? (
        <div className="grid min-w-0 gap-3" data-testid="workspace-bulk-invite-plan">
          <p className="text-sm font-semibold text-[var(--workbench-text)]" role="status">
            {(hasSent ? t('workspace.access.bulk.sentSummary') : t('workspace.access.bulk.summary'))
              .replace('{ready}', String(plan.rows.filter((row) => !row.issue).length))
              .replace('{blocked}', String(plan.rows.filter((row) => row.issue).length))
              .replace('{sent}', String(sentCount))
              .replace('{failed}', String(failedRows.length))}
          </p>
          {plan.truncated ? (
            <p className="text-sm font-semibold text-fg-amber-700" role="alert">
              {t('workspace.access.bulk.truncated').replace('{max}', String(WORKSPACE_BULK_INVITATION_MAX_ROWS))}
            </p>
          ) : null}
          {plan.rows.length === 0 ? (
            <p className="text-sm text-[var(--workbench-muted)]">{t('workspace.access.bulk.empty')}</p>
          ) : (
            <div className="max-h-96 overflow-auto rounded-md border border-[var(--workbench-border)]">
              <table className="w-full border-collapse text-left text-sm" data-testid="workspace-bulk-invite-rows">
                <thead className="sticky top-0 bg-[var(--workbench-surface-muted)]">
                  <tr>
                    <th className="px-3 py-2" scope="col">{t('workspace.access.bulk.column.line')}</th>
                    <th className="px-3 py-2" scope="col">{t('workspace.access.invite.email')}</th>
                    <th className="px-3 py-2" scope="col">{t('workspace.access.bulk.column.name')}</th>
                    <th className="px-3 py-2" scope="col">{t('workspace.access.roleLabel')}</th>
                    <th className="px-3 py-2" scope="col">{t('workspace.access.bulk.column.result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((row, index) => {
                    const outcome = outcomes.get(index)
                    const [tone, label] = row.issue
                      ? ['text-fg-red-700', t(`workspace.access.bulk.issue.${row.issue}`)]
                      : outcome?.status === 'sent'
                        ? ['text-fg-emerald-700', t('workspace.access.bulk.result.sent')]
                        : outcome?.status === 'failed'
                          ? ['text-fg-red-700', t(getFailureMessageKey(outcome.error))]
                          : ['text-[var(--workbench-muted)]', isSending
                            ? t('workspace.access.bulk.result.sending')
                            : t('workspace.access.bulk.result.ready')]
                    return (
                      <tr
                        className="border-t border-[var(--workbench-border)]"
                        data-testid={`workspace-bulk-invite-row-${index}`}
                        key={`${row.line}-${index}`}
                      >
                        <td className="px-3 py-2 tabular-nums text-[var(--workbench-muted)]">{row.line}</td>
                        <td className="break-all px-3 py-2">{row.email}</td>
                        <td className="break-all px-3 py-2">{row.name ?? ''}</td>
                        <td className="px-3 py-2">{t(`workspace.access.role.${row.role}`)}</td>
                        <td className={`px-3 py-2 font-semibold ${tone}`}>{label}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="workspace-bulk-invite-send"
              disabled={isSending || sendableIndexes.length === 0}
              type="button"
              onClick={() => void send()}
            >
              {isSending
                ? t('workspace.access.bulk.sending')
                : t('workspace.access.bulk.send').replace('{count}', String(sendableIndexes.length))}
            </button>
            {hasSent && !isSending && failedRows.length > 0 ? (
              <button
                className="workbench-button-secondary min-h-10 px-4"
                data-testid="workspace-bulk-invite-keep-failed"
                type="button"
                onClick={keepFailedRows}
              >
                {t('workspace.access.bulk.keepFailed')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
