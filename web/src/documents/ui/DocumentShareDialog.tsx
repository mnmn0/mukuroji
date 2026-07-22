import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import type {
  DocumentMemberGrantRole,
  DocumentMemberShare,
  DocumentPermission,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  CreateDocumentShareInput,
  DocumentRecord,
  DocumentShare,
  RevokeDocumentShareInput,
} from '../api'
import {
  focusFirstModalElement,
  trapModalFocus,
} from './modalFocus'

/**
 * Share dialog が container へ渡す logical share 作成入力です。
 *
 * Public link の絶対 expiry は retry 間で変化させないため、container が一度だけ
 * 確定します。
 */
export type CreateDocumentShareDraftInput =
  | Extract<CreateDocumentShareInput, { type: 'member' }>
  | {
      /**
       * Public link 作成を表す discriminator です。
       */
      type: 'public'
      /**
       * 作成時点から expiry までの日数です。
       */
      expiresInDays: number
      /**
       * Public link からの export を許可するかどうかです。
       */
      allowExport: boolean
    }

/**
 * Document share dialog の props です。
 */
export type DocumentShareDialogProps = {
  /**
   * Permission と capability を表示する Document です。
   */
  document: DocumentRecord
  /**
   * Guest/public share 一覧です。
   */
  shares: DocumentShare[]
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Dialog を閉じる callback です。
   */
  onClose: () => void
  /**
   * Inherit/private permission 変更 callback です。
   */
  onPermissionChange?: (permission: DocumentPermission) => Promise<void>
  /**
   * Guest/public share 作成 callback です。
   */
  onCreateShare?: (
    input: CreateDocumentShareDraftInput,
  ) => Promise<void>
  /**
   * Share revoke callback です。
   */
  onDeleteShare?: (input: RevokeDocumentShareInput) => Promise<void>
}

/**
 * Permission inheritance、guest grants、expiring public link を管理する dialog です。
 */
export function DocumentShareDialog({
  document,
  onClose,
  onCreateShare,
  onDeleteShare,
  onPermissionChange,
  shares,
  t,
}: DocumentShareDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const [guestEmail, setGuestEmail] = useState('')
  const [guestRole, setGuestRole] =
    useState<DocumentMemberGrantRole>('viewer')
  const [expiryDays, setExpiryDays] = useState('7')
  const [allowPublicExport, setAllowPublicExport] = useState(false)
  const [isSavingPermission, setIsSavingPermission] = useState(false)
  const [isCreatingGuest, setIsCreatingGuest] = useState(false)
  const [isCreatingPublic, setIsCreatingPublic] = useState(false)
  const [deletingShareId, setDeletingShareId] = useState<string>()
  const [copiedShareId, setCopiedShareId] = useState<string>()
  const [errorMessage, setErrorMessage] = useState<string>()
  const publicShares = shares.filter((share) => share.type === 'public')
  const memberShares = shares.filter((share) => share.type === 'member')

  useEffect(() => {
    const previousFocusedElement =
      globalThis.document.activeElement instanceof HTMLElement
        ? globalThis.document.activeElement
        : undefined
    focusFirstModalElement(dialogRef.current)

    return () => previousFocusedElement?.focus()
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    trapModalFocus(event, dialogRef.current)
  }

  const updatePermissionMode = async (
    mode: DocumentPermission['mode'],
  ) => {
    if (!onPermissionChange || isSavingPermission) {
      return
    }

    setIsSavingPermission(true)
    setErrorMessage(undefined)
    try {
      await onPermissionChange({
        memberGrants: document.permission.memberGrants,
        mode,
      })
    } catch {
      setErrorMessage(t('documents.share.error'))
    } finally {
      setIsSavingPermission(false)
    }
  }

  const createGuest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const email = guestEmail.trim().toLowerCase()
    if (!email || !onCreateShare || isCreatingGuest) {
      return
    }

    setIsCreatingGuest(true)
    setErrorMessage(undefined)
    try {
      await onCreateShare({
        memberKey: email,
        role: guestRole,
        type: 'member',
      })
      setGuestEmail('')
    } catch {
      setErrorMessage(t('documents.share.error'))
    } finally {
      setIsCreatingGuest(false)
    }
  }

  const createPublic = async () => {
    if (!onCreateShare || isCreatingPublic) {
      return
    }

    setIsCreatingPublic(true)
    setErrorMessage(undefined)
    try {
      await onCreateShare({
        allowExport: allowPublicExport,
        expiresInDays: Number(expiryDays),
        type: 'public',
      })
    } catch {
      setErrorMessage(t('documents.share.error'))
    } finally {
      setIsCreatingPublic(false)
    }
  }

  const revokeShare = async (input: RevokeDocumentShareInput) => {
    if (!onDeleteShare || deletingShareId) {
      return
    }

    const shareId =
      input.type === 'public'
        ? input.publicShareId
        : `member:${input.memberKey}`
    setDeletingShareId(shareId)
    setErrorMessage(undefined)
    try {
      await onDeleteShare(input)
    } catch {
      setErrorMessage(t('documents.share.error'))
    } finally {
      setDeletingShareId(undefined)
    }
  }

  const copyShare = async (share: DocumentShare) => {
    if (share.type !== 'public' || !share.url) {
      return
    }

    try {
      await navigator.clipboard.writeText(share.url)
      setCopiedShareId(share.id)
      window.setTimeout(() => setCopiedShareId(undefined), 1800)
    } catch {
      setCopiedShareId(undefined)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        aria-labelledby="document-share-title"
        aria-modal="true"
        className="flex max-h-[min(820px,calc(100svh-48px))] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-[var(--workbench-border)] bg-white shadow-[0_28px_90px_rgba(23,32,29,0.3)]"
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex flex-none items-start justify-between gap-4 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5">
          <div>
            <p className="workbench-eyebrow">{t('documents.share.eyebrow')}</p>
            <h2
              className="m-0 mt-2 text-xl font-semibold text-[var(--workbench-text)]"
              id="document-share-title"
            >
              {t('documents.share.title')}
            </h2>
            <p className="m-0 mt-1 max-w-[520px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {document.title}
            </p>
          </div>
          <button
            aria-label={t('documents.share.close')}
            className="grid h-9 w-9 flex-none place-items-center rounded-md text-xl text-[var(--workbench-muted)] hover:bg-white"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
          {errorMessage ? (
            <p
              className="m-0 mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"
              role="alert"
            >
              {errorMessage}
            </p>
          ) : null}
          <section>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="m-0 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('documents.share.permissionTitle')}
                </h3>
                <p className="m-0 mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                  {document.permission.mode === 'inherit'
                    ? t('documents.share.inheritDescription')
                    : t('documents.share.privateDescription')}
                </p>
              </div>
              <span
                className={
                  document.permission.mode === 'private'
                    ? 'workbench-badge-warning'
                    : 'workbench-badge-primary'
                }
              >
                {t(`documents.permission.${document.permission.mode}`)}
              </span>
            </div>
            {document.capabilities.canManagePermissions &&
            onPermissionChange ? (
              <div className="mt-4 grid grid-cols-2 rounded-lg bg-[var(--workbench-surface-muted)] p-1">
                {(['inherit', 'private'] as const).map((mode) => (
                  <button
                    aria-pressed={document.permission.mode === mode}
                    className={`min-h-10 rounded-md px-3 text-sm font-semibold ${
                      document.permission.mode === mode
                        ? 'bg-white text-[var(--workbench-text)] shadow-sm'
                        : 'text-[var(--workbench-muted)]'
                    }`}
                    disabled={isSavingPermission}
                    key={mode}
                    onClick={() => void updatePermissionMode(mode)}
                    type="button"
                  >
                    {t(`documents.permission.${mode}`)}
                  </button>
                ))}
              </div>
            ) : null}
          </section>

          <section className="mt-7 border-t border-[var(--workbench-border)] pt-6">
            <h3 className="m-0 text-sm font-semibold text-[var(--workbench-text)]">
              {t('documents.share.guests')}
            </h3>
            <p className="m-0 mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('documents.share.guestsDescription')}
            </p>
            {document.capabilities.canShare && onCreateShare ? (
              <form
                className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]"
                onSubmit={createGuest}
              >
                <input
                  aria-label={t('documents.share.guestEmail')}
                  className="workbench-input min-h-10 px-3"
                  onChange={(event) => setGuestEmail(event.target.value)}
                  placeholder="guest@example.com"
                  type="email"
                  value={guestEmail}
                />
                <select
                  aria-label={t('documents.share.guestRole')}
                  className="workbench-input min-h-10 px-2"
                  onChange={(event) =>
                    setGuestRole(
                      event.target.value === 'manager'
                        ? 'manager'
                        : event.target.value === 'editor'
                          ? 'editor'
                          : 'viewer',
                    )
                  }
                  value={guestRole}
                >
                  <option value="viewer">
                    {t('documents.share.viewer')}
                  </option>
                  <option value="editor">
                    {t('documents.share.editor')}
                  </option>
                  <option value="manager">
                    {t('documents.share.manager')}
                  </option>
                </select>
                <button
                  className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
                  disabled={!guestEmail.trim() || isCreatingGuest}
                  type="submit"
                >
                  {isCreatingGuest
                    ? t('documents.share.saving')
                    : t('documents.share.invite')}
                </button>
              </form>
            ) : null}
            <ShareList
              deletingShareId={deletingShareId}
              shares={memberShares}
              t={t}
              onDeleteShare={
                document.capabilities.canShare ? revokeShare : undefined
              }
            />
          </section>

          <section className="mt-7 border-t border-[var(--workbench-border)] pt-6">
            <h3 className="m-0 text-sm font-semibold text-[var(--workbench-text)]">
              {t('documents.share.publicLinks')}
            </h3>
            <p className="m-0 mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('documents.share.publicDescription')}
            </p>
            {document.capabilities.canShare && onCreateShare ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3">
                <label className="flex min-h-10 items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
                  {t('documents.share.expires')}
                  <select
                    className="workbench-input h-10 px-2"
                    onChange={(event) => setExpiryDays(event.target.value)}
                    value={expiryDays}
                  >
                    <option value="1">
                      {t('documents.share.expiry1')}
                    </option>
                    <option value="7">
                      {t('documents.share.expiry7')}
                    </option>
                    <option value="30">
                      {t('documents.share.expiry30')}
                    </option>
                  </select>
                </label>
                <label className="inline-flex min-h-10 items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
                  <input
                    checked={allowPublicExport}
                    onChange={(event) =>
                      setAllowPublicExport(event.target.checked)
                    }
                    type="checkbox"
                  />
                  {t('documents.share.allowExport')}
                </label>
                <button
                  className="workbench-button-primary ml-auto min-h-10 px-4 disabled:opacity-50"
                  disabled={isCreatingPublic}
                  onClick={() => void createPublic()}
                  type="button"
                >
                  {isCreatingPublic
                    ? t('documents.share.saving')
                    : t('documents.share.createLink')}
                </button>
              </div>
            ) : null}
            {publicShares.length > 0 ? (
              <div className="mt-3 grid gap-2">
                {publicShares.map((share) => (
                  <article
                    className="rounded-lg border border-[var(--workbench-border)] bg-white p-3"
                    key={share.id}
                  >
                    <div className="flex items-center gap-2">
                      {share.url ? (
                        <>
                          <input
                            aria-label={t('documents.share.publicLink')}
                            className="workbench-input h-9 min-w-0 flex-1 px-3 text-xs"
                            readOnly
                            value={share.url}
                          />
                          <button
                            className="workbench-button-secondary min-h-9 px-3"
                            onClick={() => void copyShare(share)}
                            type="button"
                          >
                            {copiedShareId === share.id
                              ? t('documents.share.copied')
                              : t('documents.share.copy')}
                          </button>
                        </>
                      ) : (
                        <p className="m-0 min-w-0 flex-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                          {t('documents.share.linkUnavailable')}
                        </p>
                      )}
                      {onDeleteShare ? (
                        <button
                          aria-label={t('documents.share.revoke')}
                          className="grid h-9 w-9 place-items-center rounded-md text-[var(--workbench-muted)] hover:bg-red-50 hover:text-[var(--workbench-danger)]"
                          disabled={Boolean(deletingShareId)}
                          onClick={() =>
                            void revokeShare({
                              publicShareId: share.id,
                              type: 'public',
                            })
                          }
                          type="button"
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                    {share.expiresAt ? (
                      <p className="m-0 mt-2 text-xs font-medium text-[var(--workbench-muted)]">
                        {t('documents.share.expiresAt').replace(
                          '{date}',
                          new Intl.DateTimeFormat(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }).format(new Date(share.expiresAt)),
                        )}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="m-0 mt-3 rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-5 text-center text-xs font-medium text-[var(--workbench-muted)]">
                {t('documents.share.noPublicLinks')}
              </p>
            )}
          </section>
        </div>
      </section>
    </div>
  )
}

function ShareList({
  deletingShareId,
  onDeleteShare,
  shares,
  t,
}: {
  deletingShareId?: string
  onDeleteShare?: (input: RevokeDocumentShareInput) => Promise<void>
  shares: DocumentMemberShare[]
  t: (key: MessageKey) => string
}) {
  if (shares.length === 0) {
    return (
      <p className="m-0 mt-3 rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-5 text-center text-xs font-medium text-[var(--workbench-muted)]">
        {t('documents.share.noGuests')}
      </p>
    )
  }

  return (
    <div className="mt-3 divide-y divide-[var(--workbench-border)] rounded-lg border border-[var(--workbench-border)]">
      {shares.map((share) => (
        <div
          className="flex items-center gap-3 px-3 py-3"
          key={share.grant.memberKey}
        >
          <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-[#e5f7f4] text-xs font-bold text-[var(--workbench-primary)]">
            {share.grant.memberKey.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-sm font-semibold text-[var(--workbench-text)]">
              {share.grant.memberKey}
            </p>
            <p className="m-0 mt-0.5 text-xs font-medium text-[var(--workbench-muted)]">
              {t(
                share.grant.role === 'manager'
                  ? 'documents.share.manager'
                  : share.grant.role === 'editor'
                    ? 'documents.share.editor'
                    : 'documents.share.viewer',
              )}
            </p>
          </div>
          {onDeleteShare ? (
            <button
              className="text-xs font-semibold text-[var(--workbench-danger)] hover:underline disabled:opacity-50"
              disabled={Boolean(deletingShareId)}
              onClick={() =>
                void onDeleteShare({
                  memberKey: share.grant.memberKey,
                  type: 'member',
                })
              }
              type="button"
            >
              {deletingShareId === `member:${share.grant.memberKey}`
                ? t('documents.share.revoking')
                : t('documents.share.revoke')}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
