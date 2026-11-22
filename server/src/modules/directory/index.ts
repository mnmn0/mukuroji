/** Directory module public domain surface. */
export {
  DynamoDbProjectDirectoryClient,
  normalizeProjectMemberKey,
  projectRoleWeights,
  readLocalizedNames,
  type ArchiveProjectResponse,
  type ArchiveTeamResponse,
  type CreateProjectRequestBody,
  type CreateProjectResponse,
  type CreateTeamRequestBody,
  type CreateTeamResponse,
  type Locale,
  type ProjectAccessEntry,
  type ProjectCreatorContext,
  type ProjectDirectoryClient,
  type ProjectDirectoryProjectResponse,
  type ProjectDirectoryResponse,
  type ProjectDirectoryTeamResponse,
  type ProjectArchiveWorkItemRevisionGuard,
  type ProjectMemberResponseItem,
  type ProjectMembersResponse,
  type ProjectRole,
  type ProjectSearchSource,
  type TeamSearchSource,
  type RemoveProjectMemberResponse,
  type UpdateProjectMemberRequestBody,
  type UpdateProjectMemberResponse,
  type WorkspaceMemberAuthorizationGeneration,
} from './adapter-out/dynamodb/project-directory-client'
export { createDirectoryProjectId } from './domain/project-key'
export {
  createProjectCharter,
  createProjectCharterPerson,
  isStoredProjectCharter,
  normalizeProjectCode,
  readProjectCharterUpdate,
  readProjectLifecycleTransition,
  decideProjectLifecycleTransition,
  type ProjectCharterUpdate,
} from './domain/project-charter'
export {
  createProjectQuickAccessIdentity,
  isProjectQuickAccessIdentifier,
  isProjectQuickAccessItems,
} from './domain/project-quick-access'
export {
  isMemberPreferencesRevision,
  readMemberPreferenceValues,
  readUpdateMemberPreferencesInput,
} from './domain/member-preferences'
export { ProjectDataError } from './project-data-error'
export {
  transitionProjectLifecycleUseCase,
  updateProjectCharterUseCase,
  type ProjectCharterCallerAuthorization,
  type ProjectCharterScope,
  type ProjectCharterStore,
  type ResolvedProjectCharterPerson,
} from './application/project-charter-use-cases'
export {
  addMemberToTeamProjectsUseCase,
  type TeamMemberGrantCaller,
  type TeamMemberGrantInput,
  type TeamMemberGrantMember,
  type TeamMemberGrantPorts,
} from './application/team-member-grant-use-case'
