import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { BulkOperation, BulkOperationPreview, BulkOperationRequest } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { useModalFocus } from '../../shared/ui/useModalFocus'
import { loadWorkspaceWorkItems } from '../../issues/queries/workspaceWorkItemLoader'
import { createBulkOperationHandlers } from '../../bulk-operations/mutations/createBulkOperationHandlers'
import { BulkOperationResultPanel } from '../../bulk-operations/ui/BulkOperationResultPanel'
import type { WorkspaceMember } from '../api/access'
import {
  MEMBER_WORK_HANDOVER_BATCH_LIMIT,
  createMemberWorkHandoverRequest,
  listMemberWorkHandoverItems,
  type MemberWorkHandoverItem,
} from '../model/memberWorkHandover'

/** Props of {@link MemberWorkHandoverDialog}. */
export type MemberWorkHandoverDialogProps = {
  /** Access token for the Work Item and bulk operation APIs. */
  accessToken: string
  /** Workspace that scopes the bulk request. */
  workspaceId: string
  /** Member whose open work is handed over. */
  member: WorkspaceMember
  /** Every Workspace member; active non-guest members other than `member` can take over. */
  members: readonly WorkspaceMember[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Closes the dialog. */
  onClose: () => void
}

/** What the dialog is loading or showing. */
type HandoverLoadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'loaded', items: MemberWorkHandoverItem[] }

/**
 * Lists a member's open Work Items and hands the selected ones to another member.
 *
 * Used before or after a member is deactivated, or when a member leaves a Team: the person can
 * keep only one Team's Work Items selected. The handover is a bulk operation, so it previews
 * every Work Item first, checks each revision, and can be retried or undone.
 *
 * @param props - Session, member, candidates, and close callback.
 * @returns The dialog.
 */
export function MemberWorkHandoverDialog({
  accessToken,
  workspaceId,
  member,
  members,
  t,
  onClose,
}: MemberWorkHandoverDialogProps) {
  const titleId = useId()
  const [loadState, setLoadState] = useState<HandoverLoadState>({ status: 'loading' })
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(() => new Set())
  const [successorKey, setSuccessorKey] = useState('')
  const [request, setRequest] = useState<BulkOperationRequest>()
  const [preview, setPreview] = useState<BulkOperationPreview>()
  const [operation, setOperation] = useState<BulkOperation>()
  const [busy, setBusy] = useState<'preview' | 'apply' | 'retry' | 'undo'>()
  const [errorMessage, setErrorMessage] = useState<string>()
  const dialogRef = useModalFocus<HTMLElement>(() => {
    if (!busy) onClose()
  })

  const successors = members.filter((candidate) =>
    candidate.memberKey !== member.memberKey &&
    candidate.status === 'active' &&
    candidate.role !== 'guest'
  )

  const [loadCount, setLoadCount] = useState(0)

  useEffect(() => {
    let current = true
    loadWorkspaceWorkItems(accessToken, false, { memberUserId: member.memberKey, openOnly: true }).then(
      (workItems) => {
        if (current) setLoadState({ status: 'loaded', items: listMemberWorkHandoverItems(workItems, member.memberKey) })
      },
      () => {
        if (current) setLoadState({ status: 'failed' })
      },
    )
    return () => {
      current = false
    }
  }, [accessToken, member.memberKey, loadCount])

  /** Reads the member's Work Items again, as after a handover changed them. */
  const reload = useCallback(() => {
    setLoadState({ status: 'loading' })
    setLoadCount((count) => count + 1)
  }, [])

  const handlers = useMemo(() => createBulkOperationHandlers({
    accessToken,
    guardRequest: (pending) => pending,
    mutationRequestRunner: createMutationRequestRunner(),
    // The server checks write permission on every Work Item during preview and apply.
    requireWriteScopes: () => undefined,
    revalidate: async () => reload(),
    t,
  }), [accessToken, reload, t])

  const items = loadState.status === 'loaded' ? loadState.items : []
  const selectedItems = items.filter((item) => !deselected.has(itemKey(item)))
  const ownerCount = items.filter((item) => item.owner).length
  const contributorCount = items.filter((item) => item.contributor).length

  /**
   * Runs one bulk step and shows a safe message when it fails.
   *
   * @param step - Step shown as busy while it runs.
   * @param action - Request to send.
   */
  const run = async (step: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(step)
    setErrorMessage(undefined)
    try {
      await action()
    } catch (error) {
      setErrorMessage(error instanceof Error && error.message ? error.message : t('bulk.error'))
    } finally {
      setBusy(undefined)
    }
  }

  const startPreview = () => run('preview', async () => {
    const nextRequest = createMemberWorkHandoverRequest(workspaceId, selectedItems, member.memberKey, successorKey)
    setOperation(undefined)
    setRequest(nextRequest)
    setPreview(await handlers.preview(nextRequest))
  })

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
        className="workbench-panel flex max-h-full w-full max-w-[640px] flex-col overflow-hidden shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
        data-testid="member-work-handover-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5">
          <h2 className="text-xl font-semibold text-[var(--workbench-text)]" id={titleId}>
            {t('workspace.access.handover.title').replace('{member}', member.name?.trim() || member.email)}
          </h2>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workspace.access.handover.description')}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {loadState.status === 'loading' ? (
            <p className="text-sm font-semibold text-[var(--workbench-muted)]" role="status">
              {t('workspace.access.handover.loading')}
            </p>
          ) : loadState.status === 'failed' ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('workspace.access.handover.loadError')}</p>
              <button className="workbench-button-secondary min-h-9 px-3" type="button" onClick={reload}>
                {t('workspace.access.handover.retry')}
              </button>
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm font-semibold text-[var(--workbench-muted)]" data-testid="member-work-handover-empty">
              {t('workspace.access.handover.empty')}
            </p>
          ) : (
            <>
              <p className="text-sm font-semibold text-[var(--workbench-text)]" data-testid="member-work-handover-summary">
                {t('workspace.access.handover.summary')
                  .replace('{owner}', String(ownerCount))
                  .replace('{contributor}', String(contributorCount))}
              </p>
              <ul className="mt-3 divide-y divide-[var(--workbench-border)] rounded-lg border border-[var(--workbench-border)]">
                {items.map((item) => {
                  const key = itemKey(item)
                  return (
                    <li key={key}>
                      <label className="flex items-start gap-3 px-3 py-2 text-sm">
                        <input
                          checked={!deselected.has(key)}
                          className="mt-1"
                          disabled={busy !== undefined}
                          type="checkbox"
                          onChange={(event) => {
                            const next = new Set(deselected)
                            if (event.target.checked) next.delete(key)
                            else next.add(key)
                            setDeselected(next)
                            setPreview(undefined)
                          }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block break-words font-semibold text-[var(--workbench-text)]">
                            {item.key ? `${item.key} ` : ''}{item.title}
                          </span>
                          <span className="mt-1 flex flex-wrap gap-1.5">
                            {item.owner ? (
                              <span className="workbench-badge-primary">{t('workspace.access.handover.owner')}</span>
                            ) : null}
                            {item.contributor ? (
                              <span className="workbench-badge-warning">{t('workspace.access.handover.contributor')}</span>
                            ) : null}
                          </span>
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
              {selectedItems.length > MEMBER_WORK_HANDOVER_BATCH_LIMIT ? (
                <p className="mt-2 text-xs font-semibold text-[var(--workbench-muted)]">
                  {t('workspace.access.handover.batchLimit')
                    .replace('{limit}', String(MEMBER_WORK_HANDOVER_BATCH_LIMIT))}
                </p>
              ) : null}
              <label className="mt-4 grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.access.handover.successor')}
                <select
                  className="workbench-input min-h-10 px-3"
                  data-testid="member-work-handover-successor"
                  disabled={busy !== undefined}
                  value={successorKey}
                  onChange={(event) => {
                    setSuccessorKey(event.target.value)
                    setPreview(undefined)
                  }}
                >
                  <option value="">{t('workspace.access.handover.successorPlaceholder')}</option>
                  {successors.map((candidate) => (
                    <option key={candidate.memberKey} value={candidate.memberKey}>
                      {candidate.name?.trim() ? `${candidate.name.trim()} (${candidate.email})` : candidate.email}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-2 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {t('workspace.access.handover.rules')}
              </p>
            </>
          )}
          {preview || operation ? (
            <BulkOperationResultPanel
              errorMessage={errorMessage}
              isApplying={busy === 'apply'}
              isRetrying={busy === 'retry'}
              isUndoing={busy === 'undo'}
              operation={operation}
              preview={preview}
              t={t}
              onApply={request && preview ? () => void run('apply', async () => {
                setOperation(await handlers.apply(request, preview))
              }) : undefined}
              onClose={() => {
                setPreview(undefined)
                setOperation(undefined)
                setErrorMessage(undefined)
              }}
              onRetry={operation ? () => void run('retry', async () => {
                setOperation(await handlers.retry(operation.id, operation))
              }) : undefined}
              onUndo={operation ? () => void run('undo', async () => {
                setOperation(await handlers.undo(operation.id, operation))
              }) : undefined}
            />
          ) : errorMessage ? (
            <p className="mt-3 text-sm font-semibold text-fg-red-700" role="alert">{errorMessage}</p>
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
            {t('workspace.access.handover.close')}
          </button>
          <button
            className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="member-work-handover-preview"
            disabled={busy !== undefined || selectedItems.length === 0 || !successorKey || operation !== undefined}
            type="button"
            onClick={() => void startPreview()}
          >
            {t(busy === 'preview' ? 'workspace.access.handover.previewing' : 'workspace.access.handover.preview')}
          </button>
        </div>
      </section>
    </div>
  )
}

/**
 * Identifies a Work Item across Teams.
 *
 * @param item - Work Item to identify.
 * @returns A key unique within the Workspace.
 */
function itemKey(item: Pick<MemberWorkHandoverItem, 'teamId' | 'workItemId'>) {
  return `${item.teamId}\0${item.workItemId}`
}
