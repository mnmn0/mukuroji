import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useSWRConfig } from 'swr'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import {
  acknowledgeWorkspaceInvitationCleanup,
  createWorkspaceInvitation,
  getWorkspaceAccess,
  reinviteWorkspaceInvitation,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  updateWorkspaceMember,
  WorkspaceAccessApiError,
  type CreateWorkspaceInvitationInput,
  type UpdateWorkspaceMemberInput,
  type WorkspaceAccess,
  type WorkspaceInvitation,
  type WorkspaceInvitationStatus,
  type WorkspaceMember,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from '../api'
import { useWorkspaceAccess } from '../queries/useWorkspaceAccess'

function shouldRetainWorkspaceMutationContext(error: unknown) {
  return !(error instanceof WorkspaceAccessApiError)
}

/**
 * Workspace access API と管理パネルを接続する container の props です。
 */
type WorkspaceAccessPanelContainerProps = {
  /**
   * Workspace access API の Authorization header に使う access token です。
   */
  accessToken: string
  /**
   * パネルの表示 locale です。
   */
  locale: Locale
}

/**
 * WorkspaceAccessPanel が受け取る描画状態と callback です。
 */
type WorkspaceAccessPanelProps = {
  /**
   * パネルの表示 locale です。
   */
  locale: Locale
  /**
   * Workspace member、invitation、capability をまとめた取得結果です。
   */
  access?: WorkspaceAccess
  /**
   * Workspace access を取得中かどうかです。
   */
  isLoading?: boolean
  /**
   * Workspace access 取得失敗時の表示メッセージです。
   */
  loadErrorMessage?: string
  /**
   * invitation 作成 callback です。
   */
  onInvite?: (input: CreateWorkspaceInvitationInput) => Promise<void>
  /**
   * 手動 Cognito cleanup の完了確認 callback です。
   */
  onAcknowledgeInvitationCleanup?: (
    invitationId: string,
    expectedVersion: number,
  ) => Promise<void>
  /**
   * invitation 再送 callback です。
   */
  onResendInvitation?: (invitationId: string) => Promise<void>
  /**
   * invitation 取消 callback です。
   */
  onRevokeInvitation?: (invitationId: string) => Promise<void>
  /**
   * invitation 再招待 callback です。
   */
  onReinviteInvitation?: (invitationId: string) => Promise<void>
  /**
   * member role または status 更新 callback です。
   */
  onUpdateMember?: (
    memberKey: string,
    input: UpdateWorkspaceMemberInput,
  ) => Promise<void>
  /**
   * Workspace access の再取得 callback です。
   */
  onRetry?: () => Promise<void> | void
}

/**
 * 確認 dialog で確定する Workspace access 操作です。
 */
type WorkspaceAccessAction =
  | {
      /**
       * member role 変更操作を表す discriminant です。
       */
      kind: 'member-role'
      /**
       * role を変更する member です。
       */
      member: WorkspaceMember
      /**
       * 変更後の role です。
       */
      role: WorkspaceRole
    }
  | {
      /**
       * member status 変更操作を表す discriminant です。
       */
      kind: 'member-status'
      /**
       * status を変更する member です。
       */
      member: WorkspaceMember
      /**
       * 変更後の status です。
       */
      status: WorkspaceMemberStatus
    }
  | {
      /**
       * invitation lifecycle 操作を表す discriminant です。
       */
      kind: 'invitation'
      /**
       * 操作対象の invitation です。
       */
      invitation: WorkspaceInvitation
      /**
       * invitation に対して実行する action です。
       */
      action: 'resend' | 'revoke' | 'reinvite' | 'acknowledgeCleanup'
    }

/**
 * 確認 dialog に表示する操作内容です。
 */
type WorkspaceAccessActionCopy = {
  /**
   * dialog の見出しです。
   */
  title: string
  /**
   * 操作対象と影響を示す説明です。
   */
  description: string
  /**
   * 確定ボタンの文言です。
   */
  confirmLabel: string
  /**
   * 破壊的操作として赤色表示するかどうかです。
   */
  destructive: boolean
}

/**
 * Workspace access 確認 dialog の props です。
 */
type WorkspaceAccessConfirmationDialogProps = {
  /**
   * dialog の見出しです。
   */
  title: string
  /**
   * 操作の影響を示す説明です。
   */
  description: string
  /**
   * 確定ボタンの文言です。
   */
  confirmLabel: string
  /**
   * 破壊的操作として赤色表示するかどうかです。
   */
  destructive: boolean
  /**
   * API 操作を実行中かどうかです。
   */
  isBusy: boolean
  /**
   * API 操作失敗時の表示メッセージです。
   */
  errorMessage?: string
  /**
   * dialog を閉じたあとにフォーカスを戻す要素です。
   */
  returnFocusRef: RefObject<HTMLElement | null>
  /**
   * i18n message 解決関数です。
   */
  t: (key: MessageKey) => string
  /**
   * 操作を確定する callback です。
   */
  onConfirm: () => Promise<void> | void
  /**
   * dialog を閉じる callback です。
   */
  onRequestClose: () => void
}

const workspaceRoles = ['owner', 'admin', 'member', 'guest'] as const satisfies readonly WorkspaceRole[]

/**
 * Workspace access API を SWR で取得し、mutation 後に最新状態へ再検証します。
 */
export function WorkspaceAccessPanelContainer({
  accessToken,
  locale,
}: WorkspaceAccessPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { mutate: mutateCache } = useSWRConfig()
  const mutationSession = useMemo(() => ({
    accessToken,
    requestRunner: createMutationRequestRunner(),
  }), [accessToken])
  const mutationRequestRunner = mutationSession.requestRunner
  const {
    data: access,
    error,
    isLoading,
    key: accessKey,
  } = useWorkspaceAccess(mutationSession.accessToken)

  const refresh = async () => {
    if (!accessKey) {
      return
    }

    // bound mutate は最新の hook key を参照するため、開始時 token の key を明示して
    // 旧 session の snapshot が token 切り替え後の cache を上書きしないようにします。
    await mutateCache(
      accessKey,
      () => getWorkspaceAccess(mutationSession.accessToken),
      { revalidate: false },
    )
    mutationRequestRunner.discardRetainedContexts()
  }

  const retryLoad = async () => {
    try {
      await refresh()
    } catch {
      // SWR が保持する既存の load error を表示したまま、click handler の
      // unhandled rejection だけを抑止します。
    }
  }

  const createInvitationMutationFingerprint = (invitationId: string) => {
    const invitation = access?.invitations.find((item) => item.id === invitationId)

    return JSON.stringify({
      invitationId,
      status: invitation?.status,
      version: invitation?.version,
    })
  }

  return (
    <WorkspaceAccessPanel
      access={access}
      isLoading={isLoading}
      key={mutationSession.accessToken}
      loadErrorMessage={error ? t('workspace.access.error.load') : undefined}
      locale={locale}
      onAcknowledgeInvitationCleanup={async (invitationId, expectedVersion) => {
        await mutationRequestRunner.run(
          `workspace-invitation:acknowledge-cleanup:${invitationId}`,
          JSON.stringify({ expectedVersion }),
          (context) => acknowledgeWorkspaceInvitationCleanup(
            accessToken,
            invitationId,
            expectedVersion,
            context,
          ),
          shouldRetainWorkspaceMutationContext,
        )
        await refresh()
      }}
      onInvite={async (input) => {
        await mutationRequestRunner.run(
          'workspace-invitation:create',
          JSON.stringify(input),
          (context) => createWorkspaceInvitation(accessToken, input, context),
          shouldRetainWorkspaceMutationContext,
        )
        await refresh()
      }}
      onReinviteInvitation={async (invitationId) => {
        await mutationRequestRunner.run(
          `workspace-invitation:reinvite:${invitationId}`,
          createInvitationMutationFingerprint(invitationId),
          (context) => reinviteWorkspaceInvitation(accessToken, invitationId, context),
          shouldRetainWorkspaceMutationContext,
        )
        await refresh()
      }}
      onResendInvitation={async (invitationId) => {
        await mutationRequestRunner.run(
          `workspace-invitation:resend:${invitationId}`,
          createInvitationMutationFingerprint(invitationId),
          (context) => resendWorkspaceInvitation(accessToken, invitationId, context),
          shouldRetainWorkspaceMutationContext,
        )
        await refresh()
      }}
      onRetry={retryLoad}
      onRevokeInvitation={async (invitationId) => {
        await mutationRequestRunner.run(
          `workspace-invitation:revoke:${invitationId}`,
          createInvitationMutationFingerprint(invitationId),
          (context) => revokeWorkspaceInvitation(accessToken, invitationId, context),
          shouldRetainWorkspaceMutationContext,
        )
        await refresh()
      }}
      onUpdateMember={async (memberKey, input) => {
        await mutationRequestRunner.run(
          `workspace-member:update:${memberKey}`,
          JSON.stringify(input),
          (context) => updateWorkspaceMember(accessToken, memberKey, input, context),
          shouldRetainWorkspaceMutationContext,
        )
        await refresh()
      }}
    />
  )
}

/**
 * Workspace member と invitation の lifecycle を同じ access ledger で管理するパネルです。
 */
export function WorkspaceAccessPanel({
  access,
  isLoading = false,
  loadErrorMessage,
  locale,
  onAcknowledgeInvitationCleanup,
  onInvite,
  onReinviteInvitation,
  onResendInvitation,
  onRetry,
  onRevokeInvitation,
  onUpdateMember,
}: WorkspaceAccessPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('member')
  const [isInviting, setIsInviting] = useState(false)
  const [operationErrorMessage, setOperationErrorMessage] = useState<string | undefined>()
  const [action, setAction] = useState<WorkspaceAccessAction | undefined>()
  const [isActionBusy, setIsActionBusy] = useState(false)
  const actionReturnFocusRef = useRef<HTMLElement | null>(null)

  if (isLoading && !access) {
    return (
      <section className="workbench-panel overflow-hidden" data-testid="workspace-access-loading">
        <WorkspaceAccessHeader t={t} />
        <p className="border-t border-[var(--workbench-border)] px-5 py-8 text-sm font-semibold text-[var(--workbench-muted)]" role="status">
          {t('workspace.access.loading')}
        </p>
      </section>
    )
  }

  if (loadErrorMessage && !access) {
    return (
      <section className="workbench-panel overflow-hidden" data-testid="workspace-access-error">
        <WorkspaceAccessHeader t={t} />
        <div className="grid gap-4 border-t border-[var(--workbench-border)] px-5 py-6">
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
            {loadErrorMessage}
          </p>
          <button
            className="workbench-button-secondary min-h-10 w-fit px-4"
            type="button"
            onClick={() => void onRetry?.()}
          >
            {t('workspace.access.retry')}
          </button>
        </div>
      </section>
    )
  }

  if (!access) {
    return null
  }

  const activeMemberCount = access.members.filter((member) => member.status === 'active').length
  const deactivatedMemberCount = access.members.length - activeMemberCount
  const openInvitationCount = access.invitations.filter((invitation) =>
    ['provisioning', 'pending', 'delivery-failed'].includes(invitation.status),
  ).length
  const attentionInvitationCount = access.invitations.filter((invitation) =>
    invitation.status === 'delivery-failed' || invitation.status === 'expired',
  ).length
  const availableInviteRoles = getManageableRoles(access)
  const canInvite = access.capabilities.canInvite && availableInviteRoles.length > 0 && Boolean(onInvite)
  const hasManagementCapability = access.capabilities.canInvite ||
    access.capabilities.canManageMembers ||
    access.capabilities.canManageAdmins

  const requestAction = (nextAction: WorkspaceAccessAction) => {
    actionReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setOperationErrorMessage(undefined)
    setAction(nextAction)
  }

  const refreshAfterMutationFailure = async (error: unknown) => {
    const originalErrorMessage = resolveWorkspaceAccessErrorMessage(error, t)

    try {
      await onRetry?.()
    } catch {
      // mutation の元エラーを優先し、再取得失敗で上書きしません。
    }

    setOperationErrorMessage(originalErrorMessage)
  }

  const confirmAction = async () => {
    if (!action || isActionBusy) {
      return
    }

    setIsActionBusy(true)
    setOperationErrorMessage(undefined)

    try {
      if (action.kind === 'member-role') {
        const latestMember = access.members.find(
          (member) => member.memberKey === action.member.memberKey,
        ) ?? action.member
        await onUpdateMember?.(latestMember.memberKey, {
          expectedVersion: latestMember.version,
          role: action.role,
        })
      } else if (action.kind === 'member-status') {
        const latestMember = access.members.find(
          (member) => member.memberKey === action.member.memberKey,
        ) ?? action.member
        await onUpdateMember?.(latestMember.memberKey, {
          expectedVersion: latestMember.version,
          status: action.status,
        })
      } else if (action.action === 'resend') {
        await onResendInvitation?.(action.invitation.id)
      } else if (action.action === 'revoke') {
        await onRevokeInvitation?.(action.invitation.id)
      } else if (action.action === 'acknowledgeCleanup') {
        const latestInvitation = access.invitations.find(
          (invitation) => invitation.id === action.invitation.id,
        ) ?? action.invitation
        await onAcknowledgeInvitationCleanup?.(
          latestInvitation.id,
          latestInvitation.version,
        )
      } else {
        await onReinviteInvitation?.(action.invitation.id)
      }

      setAction(undefined)
    } catch (error) {
      await refreshAfterMutationFailure(error)
    } finally {
      setIsActionBusy(false)
    }
  }

  const handleInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!canInvite || isInviting) {
      return
    }

    const form = event.currentTarget
    const formData = new FormData(form)
    const email = String(formData.get('email') ?? '').trim()
    const name = String(formData.get('name') ?? '').trim()

    setIsInviting(true)
    setOperationErrorMessage(undefined)

    try {
      await onInvite?.({
        email,
        name: name || undefined,
        role: inviteRole,
      })
      form.reset()
      setInviteRole('member')
    } catch (error) {
      await refreshAfterMutationFailure(error)
    } finally {
      setIsInviting(false)
    }
  }

  const actionCopy = action ? createWorkspaceAccessActionCopy(action, t) : undefined

  return (
    <section className="workbench-panel overflow-hidden" data-testid="workspace-access-panel">
      <WorkspaceAccessHeader t={t} />

      <div className="grid grid-cols-4 border-y border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] max-[860px]:grid-cols-2">
        <AccessLedgerMetric label={t('workspace.access.metric.active')} value={activeMemberCount} />
        <AccessLedgerMetric label={t('workspace.access.metric.deactivated')} value={deactivatedMemberCount} />
        <AccessLedgerMetric label={t('workspace.access.metric.openInvitations')} value={openInvitationCount} />
        <AccessLedgerMetric
          attention={attentionInvitationCount > 0}
          label={t('workspace.access.metric.attention')}
          value={attentionInvitationCount}
        />
      </div>

      <div className="grid gap-6 p-5">
        {!hasManagementCapability ? (
          <p className="rounded-lg border border-[#99d7cf] bg-[#e5f7f4] px-4 py-3 text-sm font-semibold leading-6 text-[var(--workbench-primary)]">
            {t('workspace.access.readOnly')}
          </p>
        ) : null}

        {operationErrorMessage && !action ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm font-semibold text-red-700" role="alert">
              {operationErrorMessage}
            </p>
            <button
              className="min-h-9 rounded-md border border-red-300 bg-white px-3 text-sm font-semibold text-red-700 hover:bg-red-100"
              type="button"
              onClick={() => setOperationErrorMessage(undefined)}
            >
              {t('workspace.access.error.dismiss')}
            </button>
          </div>
        ) : null}

        {canInvite ? (
          <form
            className="grid gap-4 rounded-lg border border-[#99d7cf] bg-[#f3fbfa] p-4"
            data-testid="workspace-invite-form"
            onSubmit={handleInvite}
          >
            <div>
              <p className="workbench-eyebrow text-[var(--workbench-primary)]">{t('workspace.access.invite.eyebrow')}</p>
              <h3 className="mt-1 text-base font-semibold text-[var(--workbench-text)]">{t('workspace.access.invite.title')}</h3>
              <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('workspace.access.invite.description')}</p>
            </div>
            <div className="grid grid-cols-[minmax(220px,1fr)_minmax(180px,0.8fr)_180px_auto] items-end gap-3 max-[960px]:grid-cols-2 max-[620px]:grid-cols-1">
              <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.access.invite.email')}
                <input
                  className="workbench-input min-h-10 px-3"
                  name="email"
                  placeholder={t('workspace.access.invite.emailPlaceholder')}
                  required
                  type="email"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.access.invite.name')}
                <input
                  className="workbench-input min-h-10 px-3"
                  name="name"
                  placeholder={t('workspace.access.invite.namePlaceholder')}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.access.roleLabel')}
                <select
                  className="workbench-input min-h-10 px-3"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)}
                >
                  {availableInviteRoles.map((role) => (
                    <option key={role} value={role}>{t(`workspace.access.role.${role}`)}</option>
                  ))}
                </select>
              </label>
              <button
                className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isInviting}
                type="submit"
              >
                {isInviting ? t('workspace.access.invite.sending') : t('workspace.access.invite.submit')}
              </button>
            </div>
          </form>
        ) : null}

        <WorkspaceMemberLedger
          access={access}
          locale={locale}
          t={t}
          onRequestAction={requestAction}
        />

        <WorkspaceInvitationLedger
          access={access}
          locale={locale}
          t={t}
          onRequestAction={requestAction}
        />
      </div>

      {action && actionCopy ? (
        <WorkspaceAccessConfirmationDialog
          confirmLabel={actionCopy.confirmLabel}
          description={actionCopy.description}
          destructive={actionCopy.destructive}
          errorMessage={operationErrorMessage}
          isBusy={isActionBusy}
          returnFocusRef={actionReturnFocusRef}
          t={t}
          title={actionCopy.title}
          onConfirm={confirmAction}
          onRequestClose={() => {
            if (!isActionBusy) {
              setAction(undefined)
              setOperationErrorMessage(undefined)
            }
          }}
        />
      ) : null}
    </section>
  )
}

function WorkspaceAccessHeader({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-4 px-5 py-5">
      <div className="min-w-0 max-w-[760px]">
        <p className="workbench-eyebrow text-[var(--workbench-primary)]">{t('workspace.access.eyebrow')}</p>
        <h2 className="mt-1.5 text-xl font-semibold text-[var(--workbench-text)]">{t('workspace.access.title')}</h2>
        <p className="mt-2 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('workspace.access.description')}</p>
      </div>
      <span className="rounded-full border border-[#99d7cf] bg-[#e5f7f4] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-primary)]">
        {t('workspace.access.ledger')}
      </span>
    </div>
  )
}

function AccessLedgerMetric({
  attention = false,
  label,
  value,
}: {
  attention?: boolean
  label: string
  value: number
}) {
  return (
    <div className="border-r border-[var(--workbench-border)] px-4 py-3 last:border-r-0 max-[860px]:border-b">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${attention ? 'text-red-700' : 'text-[var(--workbench-text)]'}`}>{value}</p>
    </div>
  )
}

function WorkspaceMemberLedger({
  access,
  locale,
  t,
  onRequestAction,
}: {
  access: WorkspaceAccess
  locale: Locale
  t: (key: MessageKey) => string
  onRequestAction: (action: WorkspaceAccessAction) => void
}) {
  const activeOwners = access.members.filter(
    (member) => member.role === 'owner' && member.status === 'active',
  )

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
      <LedgerSectionHeader
        description={t('workspace.access.members.description')}
        title={t('workspace.access.members.title')}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left" data-testid="workspace-member-ledger">
          <thead>
            <tr className="workbench-table-head">
              <th className="px-4 py-3" scope="col">{t('workspace.access.column.member')}</th>
              <th className="px-4 py-3" scope="col">{t('workspace.access.statusLabel')}</th>
              <th className="px-4 py-3" scope="col">{t('workspace.access.roleLabel')}</th>
              <th className="px-4 py-3 text-right" scope="col">{t('workspace.access.column.action')}</th>
            </tr>
          </thead>
          <tbody>
            {access.members.map((member) => {
              const isCurrentMember = member.memberKey === access.currentMember.memberKey
              const canManage = canManageWorkspaceMember(access, member)
              const isLastActiveOwner = member.role === 'owner' &&
                member.status === 'active' &&
                activeOwners.length === 1
              const manageableRoles = getManageableRoles(access)
              const roleOptions = manageableRoles.includes(member.role)
                ? manageableRoles
                : [member.role, ...manageableRoles]
              const nextStatus: WorkspaceMemberStatus = member.status === 'active'
                ? 'deactivated'
                : 'active'
              const cannotChangeStatus = !canManage ||
                (isCurrentMember && nextStatus === 'deactivated') ||
                (isLastActiveOwner && nextStatus === 'deactivated')

              return (
                <tr
                  className="border-t border-[var(--workbench-border)] align-middle"
                  data-testid={`workspace-member-${createAccessTestId(member.memberKey)}`}
                  key={member.id}
                >
                  <td className="px-4 py-4">
                    <div className="min-w-[240px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-[var(--workbench-text)]">{member.name?.trim() || member.email}</p>
                        {isCurrentMember ? (
                          <span className="workbench-badge-primary">{t('workspace.access.members.you')}</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">{member.email}</p>
                      <p className="mt-1 text-xs font-medium text-[var(--workbench-muted-soft)]">
                        {t('workspace.access.updatedAt').replace('{date}', formatAccessDate(member.updatedAt, locale))}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <AccessStatusBadge
                      label={t(`workspace.access.memberStatus.${member.status}`)}
                      tone={member.status === 'active' ? 'success' : 'neutral'}
                    />
                  </td>
                  <td className="px-4 py-4">
                    <label className="grid min-w-[150px] gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
                      <span className="sr-only">{`${member.email} ${t('workspace.access.roleLabel')}`}</span>
                      <select
                        aria-label={`${member.email} ${t('workspace.access.roleLabel')}`}
                        className="workbench-input min-h-10 px-3 text-sm"
                        data-testid={`workspace-member-role-${createAccessTestId(member.memberKey)}`}
                        disabled={!canManage}
                        value={member.role}
                        onChange={(event) =>
                          onRequestAction({
                            kind: 'member-role',
                            member,
                            role: event.target.value as WorkspaceRole,
                          })
                        }
                      >
                        {roleOptions.map((role) => (
                          <option
                            disabled={isLastActiveOwner && role !== 'owner'}
                            key={role}
                            value={role}
                          >
                            {t(`workspace.access.role.${role}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </td>
                  <td className="px-4 py-4 text-right">
                    <button
                      className={member.status === 'active'
                        ? 'min-h-10 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-400'
                        : 'workbench-button-secondary min-h-10 px-3 disabled:cursor-not-allowed disabled:opacity-60'}
                      disabled={cannotChangeStatus}
                      title={isCurrentMember && nextStatus === 'deactivated'
                        ? t('workspace.access.members.selfDeactivateBlocked')
                        : isLastActiveOwner && nextStatus === 'deactivated'
                          ? t('workspace.access.members.lastOwnerBlocked')
                          : undefined}
                      type="button"
                      onClick={() => onRequestAction({ kind: 'member-status', member, status: nextStatus })}
                    >
                      {nextStatus === 'active'
                        ? t('workspace.access.action.reactivate')
                        : t('workspace.access.action.deactivate')}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {access.members.length === 0 ? (
        <p className="border-t border-[var(--workbench-border)] px-4 py-7 text-sm font-medium text-[var(--workbench-muted)]">
          {t('workspace.access.members.empty')}
        </p>
      ) : null}
    </section>
  )
}

function WorkspaceInvitationLedger({
  access,
  locale,
  t,
  onRequestAction,
}: {
  access: WorkspaceAccess
  locale: Locale
  t: (key: MessageKey) => string
  onRequestAction: (action: WorkspaceAccessAction) => void
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
      <LedgerSectionHeader
        description={t('workspace.access.invitations.description')}
        title={t('workspace.access.invitations.title')}
      />
      <div className="grid divide-y divide-[var(--workbench-border)]" data-testid="workspace-invitation-ledger">
        {access.invitations.map((invitation) => {
          const canManage = canManageWorkspaceInvitation(access, invitation)
          const actions = getInvitationActions(invitation)

          return (
            <article
              className={`grid grid-cols-[minmax(220px,1fr)_minmax(190px,0.75fr)_minmax(210px,0.85fr)_auto] items-center gap-4 border-l-4 px-4 py-4 max-[980px]:grid-cols-2 max-[640px]:grid-cols-1 ${getInvitationRailClassName(invitation.status)}`}
              data-testid={`workspace-invitation-${createAccessTestId(invitation.id)}`}
              key={invitation.id}
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-[var(--workbench-text)]">{invitation.name?.trim() || invitation.email}</p>
                <p className="mt-1 truncate text-sm font-medium text-[var(--workbench-muted)]">{invitation.email}</p>
                <p className="mt-2 text-xs font-semibold text-[var(--workbench-muted)]">
                  {t(`workspace.access.role.${invitation.role}`)}
                </p>
              </div>
              <div className="grid gap-2">
                <div className="flex flex-wrap gap-2">
                  <AccessStatusBadge
                    label={t(`workspace.access.invitationStatus.${invitation.status}`)}
                    tone={getInvitationStatusTone(invitation.status)}
                  />
                  <AccessStatusBadge
                    label={t(`workspace.access.deliveryStatus.${invitation.deliveryStatus}`)}
                    tone={invitation.deliveryStatus === 'failed' ? 'danger' : 'neutral'}
                  />
                </div>
                {invitation.failureMessage ? (
                  <p className="text-xs font-semibold leading-5 text-red-700">{invitation.failureMessage}</p>
                ) : null}
              </div>
              <div className="grid gap-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                <p>{t('workspace.access.expiresAt').replace('{date}', formatAccessDate(invitation.expiresAt, locale))}</p>
                <p>{t(`workspace.access.identityOwnership.${invitation.identityOwnership}`)}</p>
                {invitation.lastSentAt ? (
                  <p>{t('workspace.access.lastSentAt').replace('{date}', formatAccessDate(invitation.lastSentAt, locale))}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap justify-end gap-2 max-[980px]:justify-start">
                {actions.map((invitationAction) => (
                  <button
                    className={invitationAction === 'revoke'
                      ? 'min-h-9 rounded-md border border-red-200 bg-white px-3 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-400'
                      : 'workbench-button-secondary min-h-9 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-60'}
                    disabled={!canManage}
                    key={invitationAction}
                    type="button"
                    onClick={() => onRequestAction({
                      action: invitationAction,
                      invitation,
                      kind: 'invitation',
                    })}
                  >
                    {t(`workspace.access.action.${invitationAction}`)}
                  </button>
                ))}
              </div>
            </article>
          )
        })}
        {access.invitations.length === 0 ? (
          <p className="px-4 py-7 text-sm font-medium text-[var(--workbench-muted)]">
            {t('workspace.access.invitations.empty')}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function LedgerSectionHeader({ description, title }: { description: string; title: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 bg-[var(--workbench-surface-muted)] px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{title}</h3>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">{description}</p>
      </div>
    </div>
  )
}

function AccessStatusBadge({
  label,
  tone,
}: {
  label: string
  tone: 'danger' | 'neutral' | 'success' | 'warning'
}) {
  const toneClassNames = {
    danger: 'border-red-200 bg-red-50 text-red-700',
    neutral: 'border-slate-200 bg-slate-50 text-slate-600',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-700',
  } as const

  return (
    <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClassNames[tone]}`}>
      {label}
    </span>
  )
}

function WorkspaceAccessConfirmationDialog({
  confirmLabel,
  description,
  destructive,
  errorMessage,
  isBusy,
  returnFocusRef,
  t,
  title,
  onConfirm,
  onRequestClose,
}: WorkspaceAccessConfirmationDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const dialogId = useId()
  const titleId = `${dialogId}-title`
  const descriptionId = `${dialogId}-description`

  useEffect(() => {
    const returnFocusElement = returnFocusRef.current
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()

    return () => {
      window.requestAnimationFrame(() => returnFocusElement?.isConnected && returnFocusElement.focus())
    }
  }, [returnFocusRef])

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const dialog = dialogRef.current

      if (event.key === 'Tab' && dialog) {
        trapWorkspaceAccessDialogFocus(event, dialog)
        return
      }

      if (event.key === 'Escape' && !isBusy) {
        onRequestClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isBusy, onRequestClose])

  useEffect(() => {
    if (isBusy) {
      dialogRef.current?.focus()
    }
  }, [isBusy])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onMouseDown={() => {
        if (!isBusy) {
          onRequestClose()
        }
      }}
    >
      <section
        aria-busy={isBusy}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="workbench-panel w-full max-w-[480px] overflow-hidden shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-5">
          <h2 className="text-xl font-semibold text-[var(--workbench-text)]" id={titleId}>{title}</h2>
        </div>
        <div className="p-6">
          <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]" id={descriptionId}>{description}</p>
          {errorMessage ? (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-semibold text-red-700" role="alert">{errorMessage}</p>
              <p className="mt-1 text-xs font-medium leading-5 text-red-700">{t('workspace.access.error.retryHint')}</p>
            </div>
          ) : null}
          <div className="mt-6 flex justify-end gap-3">
            <button
              className="workbench-button-secondary min-h-10 px-4"
              data-autofocus
              disabled={isBusy}
              type="button"
              onClick={onRequestClose}
            >
              {t('workspace.access.dialog.cancel')}
            </button>
            <button
              className={destructive
                ? 'min-h-10 rounded-md border border-red-700 bg-red-700 px-4 text-sm font-semibold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60'
                : 'workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60'}
              disabled={isBusy}
              type="button"
              onClick={() => void onConfirm()}
            >
              {isBusy ? t('workspace.access.dialog.working') : confirmLabel}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function getManageableRoles(access: WorkspaceAccess): WorkspaceRole[] {
  if (access.capabilities.canManageAdmins) {
    return [...workspaceRoles]
  }

  if (access.capabilities.canManageMembers) {
    return ['member', 'guest']
  }

  return []
}

function canManageWorkspaceMember(access: WorkspaceAccess, member: WorkspaceMember) {
  return member.role === 'owner' || member.role === 'admin'
    ? access.capabilities.canManageAdmins
    : access.capabilities.canManageMembers
}

function canManageWorkspaceInvitation(
  access: WorkspaceAccess,
  invitation: WorkspaceInvitation,
) {
  if (!access.capabilities.canInvite) {
    return false
  }

  return invitation.role === 'owner' || invitation.role === 'admin'
    ? access.capabilities.canManageAdmins
    : access.capabilities.canManageMembers
}

function getInvitationActions(invitation: WorkspaceInvitation) {
  if (invitation.status === 'provisioning') {
    return ['revoke'] as const
  }

  if (
    invitation.status === 'pending' ||
    invitation.status === 'delivery-failed'
  ) {
    return ['resend', 'revoke'] as const
  }

  if (invitation.status === 'revoked' && invitation.failureMessage) {
    if (invitation.identityCleanupManualRequired) {
      return ['revoke', 'acknowledgeCleanup'] as const
    }

    return ['revoke'] as const
  }

  if (invitation.status === 'expired' || invitation.status === 'revoked') {
    return ['reinvite'] as const
  }

  return []
}

function createWorkspaceAccessActionCopy(
  action: WorkspaceAccessAction,
  t: (key: MessageKey) => string,
): WorkspaceAccessActionCopy {
  if (action.kind === 'member-role') {
    return {
      confirmLabel: t('workspace.access.action.changeRole'),
      description: t('workspace.access.dialog.roleDescription')
        .replace('{name}', action.member.name?.trim() || action.member.email)
        .replace('{role}', t(`workspace.access.role.${action.role}`)),
      destructive: action.role === 'owner' || action.role === 'admin',
      title: t('workspace.access.dialog.roleTitle'),
    }
  }

  if (action.kind === 'member-status') {
    const isDeactivation = action.status === 'deactivated'

    return {
      confirmLabel: isDeactivation
        ? t('workspace.access.action.deactivate')
        : t('workspace.access.action.reactivate'),
      description: t(isDeactivation
        ? 'workspace.access.dialog.deactivateDescription'
        : 'workspace.access.dialog.reactivateDescription')
        .replace('{name}', action.member.name?.trim() || action.member.email),
      destructive: isDeactivation,
      title: t(isDeactivation
        ? 'workspace.access.dialog.deactivateTitle'
        : 'workspace.access.dialog.reactivateTitle'),
    }
  }

  return {
    confirmLabel: t(`workspace.access.action.${action.action}`),
    description: t(`workspace.access.dialog.${action.action}Description`)
      .replace('{email}', action.invitation.email),
    destructive: action.action === 'revoke' || action.action === 'acknowledgeCleanup',
    title: t(`workspace.access.dialog.${action.action}Title`),
  }
}

function getInvitationStatusTone(status: WorkspaceInvitationStatus) {
  if (status === 'delivery-failed') {
    return 'danger' as const
  }

  if (status === 'expired' || status === 'revoked') {
    return 'warning' as const
  }

  if (status === 'accepted') {
    return 'success' as const
  }

  return 'neutral' as const
}

function getInvitationRailClassName(status: WorkspaceInvitationStatus) {
  if (status === 'delivery-failed') {
    return 'border-l-red-500 bg-red-50/30'
  }

  if (status === 'expired' || status === 'revoked') {
    return 'border-l-amber-400 bg-amber-50/25'
  }

  if (status === 'accepted') {
    return 'border-l-emerald-500'
  }

  return 'border-l-[#6fbfb4]'
}

function formatAccessDate(value: string, locale: Locale) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function resolveWorkspaceAccessErrorMessage(
  error: unknown,
  t: (key: MessageKey) => string,
) {
  if (error instanceof WorkspaceAccessApiError) {
    if (error.code === 'CognitoUserDisabled') {
      return t('workspace.access.error.cognitoUserDisabled')
    }

    if (error.status === 409) {
      return t('workspace.access.error.conflict')
    }

    if (error.status === 403) {
      return t('workspace.access.error.forbidden')
    }
  }

  return t('workspace.access.error.operation')
}

function trapWorkspaceAccessDialogFocus(event: KeyboardEvent | globalThis.KeyboardEvent, dialog: HTMLElement) {
  const focusableElements = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  )

  if (focusableElements.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const firstElement = focusableElements[0]
  const lastElement = focusableElements.at(-1)

  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault()
    lastElement?.focus()
  } else if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault()
    firstElement?.focus()
  }
}

function createAccessTestId(value: string) {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
}
