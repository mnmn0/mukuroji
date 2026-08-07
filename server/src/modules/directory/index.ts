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
  type RemoveProjectMemberResponse,
  type UpdateProjectMemberRequestBody,
  type UpdateProjectMemberResponse,
  type WorkspaceMemberAuthorizationGeneration,
} from './adapter-out/dynamodb/project-directory-client'
export { createDirectoryProjectId } from './domain/project-key'
export {
  createProjectQuickAccessIdentity,
  isProjectQuickAccessIdentifier,
  isProjectQuickAccessItems,
} from './domain/project-quick-access'
export { ProjectDataError } from './project-data-error'
