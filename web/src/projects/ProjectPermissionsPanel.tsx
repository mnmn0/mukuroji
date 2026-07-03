import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../i18n'
import type {
  ProjectMember,
  ProjectMemberRole,
  ProjectUser,
  UpdateProjectMemberInput,
} from './api'

/**
 * プロジェクト権限管理パネルが受け取る props です。
 */
type ProjectPermissionsPanelProps = {
  /**
   * 現在表示中の project ID です。
   */
  projectId: string
  /**
   * 現在表示中の project 名です。
   */
  projectName: string
  /**
   * 権限 API のエラーメッセージです。
   */
  errorMessage?: string
  /**
   * member 一覧を読み込み中かどうかです。
   */
  isLoading?: boolean
  /**
   * Cognito user 候補を読み込み中かどうかです。
   */
  isUsersLoading?: boolean
  /**
   * ログインユーザーがシステム管理者かどうかです。
   */
  isSystemAdmin?: boolean
  /**
   * ログインユーザーがこの project の member role を管理できるかどうかです。
   */
  canManageMembers?: boolean
  /**
   * 選択中 project の member 一覧です。
   */
  members: ProjectMember[]
  /**
   * 選択可能な Cognito user 候補です。
   */
  users: ProjectUser[]
  /**
   * Cognito user 一覧の次 page token です。
   */
  usersNextToken?: string
  /**
   * Cognito user 検索 query です。
   */
  userQuery: string
  /**
   * Cognito user 候補取得エラーです。
   */
  usersErrorMessage?: string
  /**
   * i18n message 解決関数です。
   */
  t: (key: MessageKey) => string
  /**
   * member role 削除 callback です。
   */
  onRemoveMember?: (projectId: string, memberKey: string) => Promise<void>
  /**
   * Cognito user 一覧の次 page 読み込み callback です。
   */
  onLoadMoreUsers?: () => Promise<void>
  /**
   * Cognito user 検索 query 変更 callback です。
   */
  onUserQueryChange?: (query: string) => void
  /**
   * member role 保存 callback です。
   */
  onUpdateMember?: (
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => Promise<void>
}

/**
 * 権限管理フォームの入力状態です。
 */
type ProjectMemberFormState = {
  /**
   * 選択中の Cognito user ID です。
   */
  userId: string
  /**
   * 付与するプロジェクトロールです。
   */
  role: ProjectMemberRole
}

/**
 * RoleSelect が受け取る props です。
 */
type RoleSelectProps = {
  /**
   * select の id 属性です。
   */
  id: string
  /**
   * select を disabled にするかどうかです。
   */
  disabled?: boolean
  /**
   * select に表示するラベルです。
   */
  label: string
  /**
   * i18n message 解決関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Playwright で参照する test id です。
   */
  testId?: string
  /**
   * 選択中の project member role です。
   */
  value: ProjectMemberRole
  /**
   * role 変更 callback です。
   */
  onChange: (role: ProjectMemberRole) => void
}

const projectMemberRoleOptions = ['manager', 'member', 'viewer'] as const satisfies readonly ProjectMemberRole[]

/**
 * プロジェクト画面内で現在の project だけの member role を管理するパネルです。
 */
export function ProjectPermissionsPanel({
  projectId,
  projectName,
  errorMessage,
  isLoading,
  isUsersLoading,
  isSystemAdmin,
  canManageMembers,
  members,
  users,
  usersErrorMessage,
  usersNextToken,
  userQuery,
  t,
  onLoadMoreUsers,
  onRemoveMember,
  onUserQueryChange,
  onUpdateMember,
}: ProjectPermissionsPanelProps) {
  const [formState, setFormState] = useState<ProjectMemberFormState>({
    userId: '',
    role: 'member',
  })
  const [savingMemberKey, setSavingMemberKey] = useState<string | undefined>()
  const [isLoadingMoreUsers, setIsLoadingMoreUsers] = useState(false)
  const [localErrorMessage, setLocalErrorMessage] = useState<string | undefined>()
  const selectedUserId = formState.userId && users.some((user) => user.id === formState.userId)
    ? formState.userId
    : users[0]?.id ?? ''
  const isManagementEnabled = Boolean(canManageMembers)
  const managerMemberIds = members.filter((member) => member.role === 'manager').map((member) => member.id)
  const lastManagerId = managerMemberIds.length === 1 ? managerMemberIds[0] : undefined
  const isSelectedUserLastManager = selectedUserId === lastManagerId
  const isLastManagerAssignmentBlocked = isSelectedUserLastManager && formState.role !== 'manager'

  const saveMember = async (memberKey: string, input: UpdateProjectMemberInput) => {
    if (!isManagementEnabled || !onUpdateMember) {
      return false
    }

    setSavingMemberKey(memberKey)
    setLocalErrorMessage(undefined)

    try {
      await onUpdateMember(projectId, memberKey, input)
      return true
    } catch {
      setLocalErrorMessage(t('workspace.permissions.error'))
      return false
    } finally {
      setSavingMemberKey(undefined)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedUserId) {
      setLocalErrorMessage(t('workspace.permissions.error'))
      return
    }

    const saved = await saveMember(selectedUserId, {
      role: formState.role,
    })

    if (saved) {
      setFormState({ userId: '', role: 'member' })
    }
  }

  const handleLoadMoreUsers = async () => {
    if (!isManagementEnabled || !onLoadMoreUsers) {
      return
    }

    setIsLoadingMoreUsers(true)
    setLocalErrorMessage(undefined)

    try {
      await onLoadMoreUsers()
    } catch {
      setLocalErrorMessage(t('workspace.permissions.usersError'))
    } finally {
      setIsLoadingMoreUsers(false)
    }
  }

  const handleRemoveMember = async (member: ProjectMember) => {
    if (!isManagementEnabled || !onRemoveMember) {
      return
    }

    setSavingMemberKey(member.id)
    setLocalErrorMessage(undefined)

    try {
      await onRemoveMember(projectId, member.id)
    } catch {
      setLocalErrorMessage(t('workspace.permissions.error'))
    } finally {
      setSavingMemberKey(undefined)
    }
  }

  return (
    <div className="grid gap-5" data-testid="permissions-view">
      <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4 max-[1080px]:grid-cols-1">
        <section className="rounded-md border border-[#d3d8df] bg-white p-4">
          <div className="grid gap-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-[#505967]">
                  {t('workspace.permissions.projectLabel')}
                </p>
                <p className="mt-1 text-xl font-semibold leading-tight text-[#1c1d1f]">
                  {projectName}
                </p>
              </div>
              {isSystemAdmin ? (
                <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                  {t('workspace.permissions.systemAdmin')}
                </span>
              ) : null}
            </div>

            {isManagementEnabled ? (
              <form className="grid grid-cols-2 gap-3 max-[780px]:grid-cols-1" onSubmit={handleSubmit}>
                <label className="grid gap-1.5 text-sm font-semibold text-[#505967]" htmlFor="permissions-user-search">
                  {t('workspace.permissions.userSearch')}
                  <input
                    className="h-10 rounded-md border border-[#d3d8df] px-3 text-sm font-medium text-[#1c1d1f] outline-none transition focus:border-[#2563eb] focus:ring-4 focus:ring-[#2563eb]/10"
                    data-testid="permissions-user-search"
                    id="permissions-user-search"
                    placeholder={t('workspace.permissions.userSearchPlaceholder')}
                    type="search"
                    value={userQuery}
                    onChange={(event) => onUserQueryChange?.(event.target.value)}
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-semibold text-[#505967]" htmlFor="permissions-user-select">
                  {t('workspace.permissions.memberEmail')}
                  <select
                    className="h-10 rounded-md border border-[#d3d8df] bg-white px-3 text-sm font-medium text-[#1c1d1f] outline-none transition focus:border-[#2563eb] focus:ring-4 focus:ring-[#2563eb]/10"
                    data-testid="permissions-user-select"
                    disabled={users.length === 0}
                    id="permissions-user-select"
                    value={selectedUserId}
                    onChange={(event) => setFormState((current) => ({ ...current, userId: event.target.value }))}
                  >
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {formatProjectUserOption(user)}
                      </option>
                    ))}
                  </select>
                </label>
                <RoleSelect
                  disabled={isSelectedUserLastManager}
                  id="permissions-member-role"
                  label={t('workspace.permissions.roleLabel')}
                  t={t}
                  value={formState.role}
                  onChange={(role) => setFormState((current) => ({ ...current, role }))}
                />
                <button
                  className="self-end min-h-10 rounded-md bg-[#1c1d1f] px-5 text-sm font-semibold text-white transition hover:bg-[#343941] disabled:cursor-not-allowed disabled:bg-[#b5bdc9]"
                  data-testid="permissions-submit"
                  disabled={!selectedUserId || isLastManagerAssignmentBlocked || savingMemberKey === selectedUserId}
                  type="submit"
                >
                  {savingMemberKey === selectedUserId
                    ? t('workspace.permissions.saving')
                    : t('workspace.permissions.save')}
                </button>
                <div className="col-span-full flex flex-wrap items-center gap-3 text-sm font-medium text-[#5f6874]">
                  {isUsersLoading ? <span>{t('workspace.permissions.usersLoading')}</span> : null}
                  {usersErrorMessage ? <span className="font-semibold text-red-700">{usersErrorMessage}</span> : null}
                  {!isUsersLoading && users.length === 0 ? <span>{t('workspace.permissions.usersEmpty')}</span> : null}
                  {usersNextToken ? (
                    <button
                      className="min-h-9 rounded-md border border-[#d3d8df] bg-white px-3 text-xs font-semibold text-[#1c1d1f] transition hover:border-[#2563eb] hover:text-[#2563eb] disabled:cursor-not-allowed disabled:text-[#b5bdc9]"
                      data-testid="permissions-load-more-users"
                      disabled={isLoadingMoreUsers}
                      type="button"
                      onClick={handleLoadMoreUsers}
                    >
                      {isLoadingMoreUsers
                        ? t('workspace.permissions.saving')
                        : t('workspace.permissions.loadMoreUsers')}
                    </button>
                  ) : null}
                </div>
              </form>
            ) : (
              <p className="rounded-md border border-[#d3d8df] bg-[#fbfcfd] px-4 py-3 text-sm font-medium leading-6 text-[#505967]">
                {t('workspace.permissions.managerOnly')}
              </p>
            )}
            {errorMessage || localErrorMessage ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
                {localErrorMessage ?? errorMessage}
              </p>
            ) : null}
          </div>
        </section>

        <section className="rounded-md border border-[#d3d8df] bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#5f6874]">
            {t('workspace.permissions.policyTitle')}
          </p>
          <div className="mt-3 grid gap-2.5">
            {projectMemberRoleOptions.map((role) => (
              <div className="rounded-md border border-[#e4e7ec] bg-[#fbfcfd] p-3" key={role}>
                <p className="text-sm font-semibold text-[#1c1d1f]">
                  {t(`workspace.permissions.role.${role}`)}
                </p>
                <p className="mt-1 text-sm font-medium leading-6 text-[#505967]">
                  {t(`workspace.permissions.${role}Policy`)}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-md border border-[#d3d8df] bg-white">
        <SectionHeader
          title={t('workspace.permissions.directoryTitle')}
          meta={projectName}
        />
        {isLoading ? (
          <p className="px-4 py-7 text-sm font-medium text-[#5f6874]">
            {t('workspace.permissions.loading')}
          </p>
        ) : (
          <div className="grid divide-y divide-[#e4e7ec]">
            {members.map((member) => {
              const isLastManager = member.role === 'manager' && member.id === lastManagerId

              return (
                <div
                  className="grid grid-cols-[minmax(0,1fr)_180px_100px] items-center gap-4 px-4 py-3 max-[820px]:grid-cols-1"
                  data-testid={`permission-member-row-${createProjectMemberTestId(member.id)}`}
                  key={member.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#1c1d1f]">{member.name ?? member.email}</p>
                    <p className="mt-1 truncate text-sm font-medium text-[#5f6874]">
                      {member.email}
                      {member.status ? ` / ${member.status}` : ''}
                    </p>
                  </div>
                  <RoleSelect
                    disabled={!isManagementEnabled || isLastManager || savingMemberKey === member.id}
                    id={`permissions-role-${member.id}`}
                    label={t('workspace.permissions.roleLabel')}
                    t={t}
                    testId={`permission-role-select-${createProjectMemberTestId(member.id)}`}
                    value={member.role}
                    onChange={(role) =>
                      saveMember(member.id, {
                        role,
                      })
                    }
                  />
                  <button
                    className="min-h-10 rounded-md border border-[#d3d8df] bg-white px-3 text-sm font-semibold text-[#1c1d1f] transition hover:border-red-300 hover:text-red-700 disabled:cursor-not-allowed disabled:text-[#b5bdc9]"
                    data-testid={`permission-remove-${createProjectMemberTestId(member.id)}`}
                    disabled={!isManagementEnabled || isLastManager || savingMemberKey === member.id}
                    type="button"
                    onClick={() => handleRemoveMember(member)}
                  >
                    {savingMemberKey === member.id
                      ? t('workspace.permissions.saving')
                      : t('workspace.permissions.remove')}
                  </button>
                </div>
              )
            })}
            {members.length === 0 ? (
              <p className="px-4 py-7 text-sm font-medium text-[#5f6874]">
                {t('workspace.permissions.empty')}
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}

function RoleSelect({
  id,
  disabled,
  label,
  t,
  testId,
  value,
  onChange,
}: RoleSelectProps) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold text-[#505967]" htmlFor={id}>
      {label}
      <select
        className="h-10 rounded-md border border-[#d3d8df] bg-white px-3 text-sm font-medium text-[#1c1d1f] outline-none transition focus:border-[#2563eb] focus:ring-4 focus:ring-[#2563eb]/10 disabled:cursor-not-allowed disabled:bg-[#f3f4f6] disabled:text-[#8f99a8]"
        data-testid={testId}
        disabled={disabled}
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as ProjectMemberRole)}
      >
        {projectMemberRoleOptions.map((role) => (
          <option key={role} value={role}>
            {t(`workspace.permissions.role.${role}`)}
          </option>
        ))}
      </select>
    </label>
  )
}

function SectionHeader({
  title,
  meta,
}: {
  /**
   * section 見出しです。
   */
  title: string
  /**
   * section 補助情報です。
   */
  meta: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e4e7ec] bg-[#fbfcfd] px-4 py-3">
      <h2 className="text-sm font-semibold text-[#1c1d1f]">{title}</h2>
      <span className="rounded-full border border-[#d3d8df] bg-white px-2.5 py-1 text-xs font-semibold text-[#505967]">
        {meta}
      </span>
    </div>
  )
}

function createProjectMemberTestId(memberKey: string) {
  return memberKey.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function formatProjectUserOption(user: ProjectUser) {
  return `${user.name ?? user.email} / ${user.email}`
}
