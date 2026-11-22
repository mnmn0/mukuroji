import { useMemo, useState, type FormEvent } from 'react'
import {
  DIRECTORY_TEAM_DESCRIPTION_MAX_LENGTH,
  DIRECTORY_TEAM_MEMBER_ROLES,
  isDirectoryTeamMemberRole,
  type AddDirectoryTeamMemberResponse,
  type DirectoryAdministrationTeam,
  type DirectoryTeamMemberRole,
  type UpdateDirectoryTeamProfileInput,
} from '@mukuroji/contracts'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import { useWorkspaceAccess } from '../../workspace/queries/useWorkspaceAccess'
import { listActiveDirectoryTeams } from '../model/directoryAdministration'
import {
  listTeamProfileProjects,
  summarizeTeamProfileMembers,
  type TeamProfileMember,
} from '../model/teamProfile'
import { useTeamProfileActions } from '../mutations/useTeamProfileActions'
import { useDirectoryAdministration } from '../queries/useDirectoryAdministration'
import { useTeamProjectMembers } from '../queries/useProjectMembers'

/** Props of the Team settings container. */
type TeamProfilePanelContainerProps = {
  /** Bearer token of the Workspace administrator. */
  accessToken: string
  /** Locale of labels and names. */
  locale: Locale
}

/**
 * Loads the Teams, the Workspace members, and the members of the chosen Team's Projects, and
 * connects the Team settings changes to the API.
 *
 * @param props - Authenticated settings inputs.
 * @returns The Team settings panel.
 */
export function TeamProfilePanelContainer({ accessToken, locale }: TeamProfilePanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const directory = useDirectoryAdministration(accessToken)
  const access = useWorkspaceAccess(accessToken)
  const actions = useTeamProfileActions(accessToken)
  const teams = useMemo(() => listActiveDirectoryTeams(directory.data ?? []), [directory.data])
  const [selectedTeamId, setSelectedTeamId] = useState<string>()
  const team = teams.find((candidate) => candidate.id === selectedTeamId) ?? teams[0]
  const projects = useMemo(
    () => (team ? listTeamProfileProjects(team, locale) : []),
    [team, locale],
  )
  const projectMembers = useTeamProjectMembers(accessToken, team?.id, projects)
  const members = useMemo(
    () => summarizeTeamProfileMembers(projectMembers.data?.members ?? [], projects),
    [projectMembers.data, projects],
  )
  const workspaceMembers = useMemo(
    () => (access.data?.members ?? [])
      .filter((member) => member.status === 'active')
      .map((member) => ({ memberKey: member.memberKey, label: member.name ?? member.email }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    [access.data],
  )
  // A failed member list is not an empty one: the panel says so and offers a retry.
  const workspaceMembersStatus: TeamProfileWorkspaceMembersStatus = access.error
    ? 'error'
    : access.data
      ? 'ready'
      : 'loading'

  if (directory.isLoading) {
    return (
      <section className="workbench-panel p-5" data-testid="team-profile-loading">
        {t('projects.administration.loading')}
      </section>
    )
  }

  if (directory.error || !directory.data) {
    return (
      <section className="workbench-panel p-5" data-testid="team-profile-error">
        <SectionHeader meta={t('projects.administration.loadError')} title={t('projects.teamProfile.title')} />
        <button
          className="workbench-button-secondary mt-4 min-h-10 px-4"
          onClick={() => void directory.mutate()}
          type="button"
        >
          {t('projects.administration.retry')}
        </button>
      </section>
    )
  }

  return (
    <TeamProfilePanel
      errorMessage={actions.errorMessageKey ? t(actions.errorMessageKey) : undefined}
      locale={locale}
      members={members}
      membersLoading={projectMembers.isLoading}
      membersPartial={(projectMembers.data?.failedProjectIds.length ?? 0) > 0 || Boolean(projectMembers.error)}
      pending={actions.pending}
      projectCount={projects.length}
      t={t}
      team={team}
      teams={teams}
      workspaceMembers={workspaceMembers}
      workspaceMembersStatus={workspaceMembersStatus}
      onAddMember={actions.addMember}
      onRetryWorkspaceMembers={() => void access.mutate()}
      onRetryMembers={() => void projectMembers.mutate()}
      onSaveProfile={actions.saveProfile}
      onSelectTeam={setSelectedTeamId}
    />
  )
}

/** Active Workspace member offered as a leader or as a member to add. */
export type TeamProfileWorkspaceMember = {
  /** Member key sent to the API. */
  memberKey: string
  /** Display name, or the email address when no name is known. */
  label: string
}

/** Load state of the Workspace member list that leader and member choices come from. */
export type TeamProfileWorkspaceMembersStatus = 'loading' | 'error' | 'ready'

/** Props of the Team settings panel. */
export type TeamProfilePanelProps = {
  /** Active Teams in display order. */
  teams: readonly DirectoryAdministrationTeam[]
  /** Team being edited; undefined when the Workspace has no active Team. */
  team?: DirectoryAdministrationTeam
  /** Number of active Projects of the Team. */
  projectCount: number
  /** Members of the Team's Projects, one row per member. */
  members: readonly TeamProfileMember[]
  /** Whether the member list is still loading. */
  membersLoading: boolean
  /** Whether the members of some Projects could not be read. */
  membersPartial: boolean
  /** Active Workspace members offered as leader or as a member to add. */
  workspaceMembers: readonly TeamProfileWorkspaceMember[]
  /** Whether the Workspace member list is loading, failed, or loaded. */
  workspaceMembersStatus: TeamProfileWorkspaceMembersStatus
  /** Loads the Workspace member list again after it failed. */
  onRetryWorkspaceMembers: () => void
  /** Loads the members of the Team's Projects again after some failed. */
  onRetryMembers: () => void
  /** Whether a change is in flight. */
  pending: boolean
  /** Message of the last failed change. */
  errorMessage?: string
  /** Locale of Team names. */
  locale: Locale
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Chooses the Team to edit. */
  onSelectTeam: (teamId: string) => void
  /** Saves the description and leader; resolves to whether it succeeded. */
  onSaveProfile: (teamId: string, input: UpdateDirectoryTeamProfileInput) => Promise<boolean>
  /** Adds a member to every active Project of the Team. */
  onAddMember: (
    teamId: string,
    input: { memberKey: string; role: DirectoryTeamMemberRole },
  ) => Promise<AddDirectoryTeamMemberResponse | undefined>
}

/**
 * Lets a Workspace administrator set a Team's description and leader, see who belongs to its
 * Projects, and add a member to every Project of the Team at once.
 *
 * @param props - Team rows, members, and actions.
 * @returns The Team settings panel.
 */
export function TeamProfilePanel({
  teams,
  team,
  projectCount,
  members,
  membersLoading,
  membersPartial,
  workspaceMembers,
  workspaceMembersStatus,
  onRetryWorkspaceMembers,
  onRetryMembers,
  pending,
  errorMessage,
  locale,
  t,
  onSelectTeam,
  onSaveProfile,
  onAddMember,
}: TeamProfilePanelProps) {
  // Kept above the keyed form: a real save reloads the Team and remounts the form, and the
  // confirmation must survive that.
  const [savedTeamId, setSavedTeamId] = useState<string>()
  return (
    <section className="workbench-panel grid gap-5 p-5" data-testid="team-profile-panel">
      <SectionHeader meta={t('projects.teamProfile.description')} title={t('projects.teamProfile.title')} />
      {team ? (
        <>
          <label className="grid max-w-md gap-1 text-xs font-semibold">
            {t('projects.teamProfile.team')}
            <select
              className="workbench-input min-h-10 px-3 text-sm font-normal"
              onChange={(event) => onSelectTeam(event.target.value)}
              value={team.id}
            >
              {teams.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {locale === 'en' ? candidate.nameEn : candidate.nameJa}
                </option>
              ))}
            </select>
          </label>
          {errorMessage ? (
            <p className="m-0 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-fg-red-700" role="alert">
              {errorMessage}
            </p>
          ) : null}
          {workspaceMembersStatus === 'loading' ? (
            <p className="m-0 text-sm text-[var(--workbench-muted)]" role="status">
              {t('projects.teamProfile.workspaceMembersLoading')}
            </p>
          ) : workspaceMembersStatus === 'error' ? (
            <div
              className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
              data-testid="team-profile-workspace-members-error"
              role="alert"
            >
              <span className="text-sm text-fg-red-700">{t('projects.teamProfile.workspaceMembersError')}</span>
              <button
                className="workbench-button-secondary min-h-10 px-4"
                onClick={onRetryWorkspaceMembers}
                type="button"
              >
                {t('projects.administration.retry')}
              </button>
            </div>
          ) : null}
          <TeamProfileForm
            // A new Team or a saved profile starts the form from the stored values.
            key={`${team.id}\u0000${team.profileRevision ?? 0}\u0000${team.description ?? ''}\u0000${team.leaderMemberKey ?? ''}`}
            pending={pending}
            saved={savedTeamId === team.id}
            t={t}
            team={team}
            workspaceMembers={workspaceMembers}
            workspaceMembersReady={workspaceMembersStatus === 'ready'}
            onEdit={() => setSavedTeamId(undefined)}
            onSave={async (input) => {
              setSavedTeamId(undefined)
              const succeeded = await onSaveProfile(team.id, input)
              if (succeeded) setSavedTeamId(team.id)
              return succeeded
            }}
          />
          <TeamProfileMembers
            key={team.id}
            members={members}
            membersLoading={membersLoading}
            membersPartial={membersPartial}
            onRetryMembers={onRetryMembers}
            pending={pending}
            projectCount={projectCount}
            t={t}
            workspaceMembers={workspaceMembers}
            workspaceMembersReady={workspaceMembersStatus === 'ready'}
            onAdd={(input) => onAddMember(team.id, input)}
          />
        </>
      ) : (
        <p className="m-0 text-sm text-[var(--workbench-muted)]">{t('projects.administration.empty')}</p>
      )}
    </section>
  )
}

/** Props of {@link TeamProfileForm}. */
type TeamProfileFormProps = {
  /** Team being edited. */
  team: DirectoryAdministrationTeam
  /** Active Workspace members offered as leader. */
  workspaceMembers: readonly TeamProfileWorkspaceMember[]
  /** Whether the Workspace member list loaded, so a leader can be chosen. */
  workspaceMembersReady: boolean
  /** Whether a change is in flight. */
  pending: boolean
  /** Whether the last save of this Team succeeded and nothing was edited since. */
  saved: boolean
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Reports that a field was edited, so an earlier confirmation no longer applies. */
  onEdit: () => void
  /** Saves the description and leader. */
  onSave: (input: UpdateDirectoryTeamProfileInput) => Promise<boolean>
}

/**
 * Edits the description and leader of one Team.
 *
 * @param props - Team, leader candidates, and the save action.
 * @returns The profile form.
 */
function TeamProfileForm({
  team,
  workspaceMembers,
  workspaceMembersReady,
  pending,
  saved,
  t,
  onEdit,
  onSave,
}: TeamProfileFormProps) {
  const [description, setDescription] = useState(team.description ?? '')
  const [leaderMemberKey, setLeaderMemberKey] = useState(team.leaderMemberKey ?? '')
  // Until the list loads, the stored leader is shown as is and cannot be changed.
  const leaderMissing = leaderMemberKey !== '' &&
    !workspaceMembers.some((member) => member.memberKey === leaderMemberKey)

  /**
   * Saves the form.
   *
   * @param event - Form submit event.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await onSave({
      description,
      leaderMemberKey: leaderMemberKey === '' ? null : leaderMemberKey,
      // The stored revision this form was loaded from; a newer one refuses the save.
      expectedProfileRevision: team.profileRevision ?? 0,
    })
  }

  return (
    <form className="grid gap-3" data-testid="team-profile-form" onSubmit={(event) => void submit(event)}>
      <label className="grid gap-1 text-xs font-semibold">
        {t('projects.teamProfile.teamDescription')}
        <textarea
          className="workbench-input min-h-24 px-3 py-2 text-sm font-normal"
          maxLength={DIRECTORY_TEAM_DESCRIPTION_MAX_LENGTH}
          onChange={(event) => {
            onEdit()
            setDescription(event.target.value)
          }}
          value={description}
        />
      </label>
      <label className="grid max-w-md gap-1 text-xs font-semibold">
        {t('projects.teamProfile.leader')}
        <select
          className="workbench-input min-h-10 px-3 text-sm font-normal"
          disabled={!workspaceMembersReady}
          onChange={(event) => {
            onEdit()
            setLeaderMemberKey(event.target.value)
          }}
          value={leaderMemberKey}
        >
          <option value="">{t('projects.teamProfile.noLeader')}</option>
          {leaderMissing ? (
            // A leader who left the Workspace stays visible until another one is chosen.
            <option value={leaderMemberKey}>{leaderMemberKey}</option>
          ) : null}
          {workspaceMembers.map((member) => (
            <option key={member.memberKey} value={member.memberKey}>{member.label}</option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button className="workbench-button-primary min-h-10 px-4" disabled={pending} type="submit">
          {t('projects.administration.save')}
        </button>
        {saved ? (
          <span className="text-sm text-[var(--workbench-muted)]" role="status">
            {t('projects.teamProfile.saved')}
          </span>
        ) : null}
      </div>
    </form>
  )
}

/** Props of {@link TeamProfileMembers}. */
type TeamProfileMembersProps = {
  /** Members of the Team's Projects. */
  members: readonly TeamProfileMember[]
  /** Whether the member list is still loading. */
  membersLoading: boolean
  /** Whether the members of some Projects could not be read. */
  membersPartial: boolean
  /** Loads the members of the Team's Projects again after some failed. */
  onRetryMembers: () => void
  /** Number of active Projects of the Team. */
  projectCount: number
  /** Active Workspace members offered to add. */
  workspaceMembers: readonly TeamProfileWorkspaceMember[]
  /** Whether the Workspace member list loaded, so a member can be chosen. */
  workspaceMembersReady: boolean
  /** Whether a change is in flight. */
  pending: boolean
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Adds a member to every active Project of the Team. */
  onAdd: (
    input: { memberKey: string; role: DirectoryTeamMemberRole },
  ) => Promise<AddDirectoryTeamMemberResponse | undefined>
}

/**
 * Lists the members of a Team's Projects and adds a member to every Project of the Team.
 *
 * @param props - Members, candidates, and the add action.
 * @returns The member section.
 */
function TeamProfileMembers({
  members,
  membersLoading,
  membersPartial,
  onRetryMembers,
  projectCount,
  workspaceMembers,
  workspaceMembersReady,
  pending,
  t,
  onAdd,
}: TeamProfileMembersProps) {
  const [memberKey, setMemberKey] = useState('')
  const [role, setRole] = useState<DirectoryTeamMemberRole>('member')
  const [result, setResult] = useState<AddDirectoryTeamMemberResponse>()

  /**
   * Adds the chosen member.
   *
   * @param event - Form submit event.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setResult(undefined)
    const added = await onAdd({ memberKey, role })
    if (added) {
      setResult(added)
      setMemberKey('')
    }
  }

  return (
    <div className="grid gap-3">
      <h3 className="m-0 text-sm font-semibold">{t('projects.teamProfile.members')}</h3>
      {membersLoading ? (
        <p className="m-0 text-sm text-[var(--workbench-muted)]" role="status">{t('projects.teamProfile.membersLoading')}</p>
      ) : members.length === 0 ? (
        <p className="m-0 text-sm text-[var(--workbench-muted)]">{t('projects.teamProfile.membersEmpty')}</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0" data-testid="team-profile-members">
          {members.map((member) => (
            <li className="rounded-lg border border-[var(--workbench-border)] px-3 py-2 text-sm" key={member.id}>
              <span className="font-semibold">{member.label}</span>
              {member.label !== member.email ? (
                <span className="ml-2 text-[var(--workbench-muted)]">{member.email}</span>
              ) : null}
              <span className="mt-1 block text-xs text-[var(--workbench-muted)]">
                {member.projects
                  .map((project) => `${project.projectName}（${t(`workspace.permissions.role.${project.role}`)}）`)
                  .join('、')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {membersPartial ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="team-profile-members-partial" role="status">
          <span className="text-sm text-fg-amber-900">{t('projects.teamProfile.membersPartial')}</span>
          <button className="workbench-button-secondary min-h-10 px-4" onClick={onRetryMembers} type="button">
            {t('projects.administration.retry')}
          </button>
        </div>
      ) : null}
      {projectCount === 0 ? (
        <p className="m-0 text-sm text-[var(--workbench-muted)]">{t('projects.teamProfile.noProjects')}</p>
      ) : (
        <form
          className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end"
          data-testid="team-profile-add-member"
          onSubmit={(event) => void submit(event)}
        >
          <label className="grid gap-1 text-xs font-semibold">
            {t('projects.teamProfile.addMemberLabel')}
            <select
              className="workbench-input min-h-10 px-3 text-sm font-normal"
              disabled={!workspaceMembersReady}
              onChange={(event) => setMemberKey(event.target.value)}
              required
              value={memberKey}
            >
              <option value="">{t('projects.teamProfile.chooseMember')}</option>
              {workspaceMembers.map((member) => (
                <option key={member.memberKey} value={member.memberKey}>{member.label}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold">
            {t('workspace.permissions.roleLabel')}
            <select
              className="workbench-input min-h-10 px-3 text-sm font-normal"
              onChange={(event) => {
                const value = event.target.value
                if (isDirectoryTeamMemberRole(value)) setRole(value)
              }}
              value={role}
            >
              {DIRECTORY_TEAM_MEMBER_ROLES.map((candidate) => (
                <option key={candidate} value={candidate}>{t(`workspace.permissions.role.${candidate}`)}</option>
              ))}
            </select>
          </label>
          <button
            className="workbench-button-primary min-h-10 px-4"
            disabled={pending || memberKey === ''}
            type="submit"
          >
            {t('projects.teamProfile.addMember')}
          </button>
        </form>
      )}
      {result ? (
        <p className="m-0 text-sm text-[var(--workbench-muted)]" role="status">
          {t('projects.teamProfile.added')
            .replace('{added}', String(result.addedProjectIds.length))
            .replace('{existing}', String(result.existingProjectIds.length))}
        </p>
      ) : null}
    </div>
  )
}
