import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  ProjectMember,
  ProjectUser,
  UpdateProjectMemberInput,
} from '../../projects/api'
import { ProjectPermissionsPanel } from '../../projects/ui/ProjectPermissionsPanel'

/** Resolves a localized task-permissions message. */
type TaskPermissionsTranslator = (key: MessageKey) => string

/** Props for the independent project task permissions view. */
export type TaskPermissionsViewProps = {
  /** Whether the current user can manage project member roles. */
  canManageProjectMembers: boolean
  /** Whether project members are loading. */
  isProjectMembersLoading: boolean
  /** Whether project user candidates are loading. */
  isProjectUsersLoading: boolean
  /** Whether the current user is a system administrator. */
  isSystemAdmin: boolean
  /** Project identifier whose membership is managed. */
  projectId: string
  /** Members currently assigned to the project. */
  projectMembers: ProjectMember[]
  /** Localized project-member loading or mutation error. */
  projectMembersErrorMessage?: string
  /** Display name of the project whose membership is managed. */
  projectName: string
  /** Current project-user search query. */
  projectUserQuery: string
  /** Users available as project membership candidates. */
  projectUsers: ProjectUser[]
  /** Localized project-user loading error. */
  projectUsersErrorMessage?: string
  /** Opaque cursor for the next page of project users. */
  projectUsersNextToken?: string
  /** Translator used for permission-view labels. */
  t: TaskPermissionsTranslator
  /** Loads the next page of project users. */
  onLoadMoreProjectUsers?: () => Promise<void>
  /** Updates the project-user search query. */
  onProjectUserQueryChange?: (query: string) => void
  /** Removes a project member role. */
  onRemoveProjectMember?: (projectId: string, memberKey: string) => Promise<void>
  /** Creates or updates a project member role. */
  onUpdateProjectMember?: (
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberInput,
  ) => Promise<void>
}

/**
 * Adapts project task-screen inputs to the project permissions panel.
 *
 * @param props - Project membership data, permission state, and mutation callbacks.
 * @returns The independent project task permissions view.
 */
export function TaskPermissionsView({
  canManageProjectMembers,
  isProjectMembersLoading,
  isProjectUsersLoading,
  isSystemAdmin,
  projectId,
  projectMembers,
  projectMembersErrorMessage,
  projectName,
  projectUserQuery,
  projectUsers,
  projectUsersErrorMessage,
  projectUsersNextToken,
  t,
  onLoadMoreProjectUsers,
  onProjectUserQueryChange,
  onRemoveProjectMember,
  onUpdateProjectMember,
}: TaskPermissionsViewProps) {
  return (
    <div className="px-[clamp(18px,2.5vw,30px)] py-4">
      <ProjectPermissionsPanel
        canManageMembers={canManageProjectMembers}
        errorMessage={projectMembersErrorMessage}
        isLoading={isProjectMembersLoading}
        isSystemAdmin={isSystemAdmin}
        isUsersLoading={isProjectUsersLoading}
        members={projectMembers}
        projectId={projectId}
        projectName={projectName}
        t={t}
        userQuery={projectUserQuery}
        users={projectUsers}
        usersErrorMessage={projectUsersErrorMessage}
        usersNextToken={projectUsersNextToken}
        onLoadMoreUsers={onLoadMoreProjectUsers}
        onRemoveMember={onRemoveProjectMember}
        onUpdateMember={onUpdateProjectMember}
        onUserQueryChange={onProjectUserQueryChange}
      />
    </div>
  )
}
