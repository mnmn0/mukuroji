import type {
  GitHubLoginResponse,
  GitHubPullRequestInboxResponse,
  GitHubPullRequestInboxView,
  GitHubRepositoryLink,
  GitHubRepositoryLinkListResponse,
  SaveGitHubRepositoryLinkRequest,
} from '@mukuroji/contracts'
import { GitHubIntegrationError } from '../domain/github-integration-error'
import { selectPullRequestInboxItems } from '../domain/pull-request-inbox'
import type {
  GitHubAppCredentialSource,
  GitHubAppGateway,
  GitHubIntegrationStore,
  GitHubSyncQueue,
} from './ports'

/** Member a use case acts for. */
export type GitHubIntegrationMember = {
  /** Workspace. */
  workspaceId: string
  /** Member key. */
  memberKey: string
}

/** Dependencies of the member-facing use cases. */
export type GitHubMemberDependencies<AuditContext> = {
  /** Store. */
  store: GitHubIntegrationStore<AuditContext>
  /** App credentials, which tell whether the App is configured. */
  credentials: GitHubAppCredentialSource
}

/**
 * Lists one tab of the caller's pull request review inbox (ADR 0079).
 *
 * @param dependencies - Store and credentials.
 * @param member - Caller.
 * @param view - Tab.
 * @param readableTeamIds - Reads the Teams whose Work Items the caller may read.
 * @param now - Request time.
 * @returns The inbox response.
 */
export async function readGitHubPullRequestInbox<AuditContext>(
  dependencies: GitHubMemberDependencies<AuditContext>,
  member: GitHubIntegrationMember,
  view: GitHubPullRequestInboxView,
  readableTeamIds: () => Promise<ReadonlySet<string>>,
  now: Date,
): Promise<GitHubPullRequestInboxResponse> {
  const [credentials, login] = await Promise.all([
    dependencies.credentials.read(),
    dependencies.store.getMemberLogin(member.workspaceId, member.memberKey),
  ])
  const configured = credentials !== null
  if (!login) return { configured, view, items: [] }
  const [links, page, teams] = await Promise.all([
    dependencies.store.listRepositoryLinks(member.workspaceId),
    dependencies.store.listPullRequestSnapshots(member.workspaceId),
    readableTeamIds(),
  ])
  const items = selectPullRequestInboxItems(page.snapshots, {
    view,
    login,
    repositoryTeams: new Map(links.map((link) => [link.repositoryId, link.teamId])),
    readableTeamIds: teams,
    now,
  })
  return { configured, githubLogin: login, view, items, ...(page.incomplete ? { incomplete: true } : {}) }
}

/**
 * Reads the caller's GitHub login.
 *
 * @param store - Store.
 * @param member - Caller.
 * @returns The login response.
 */
export async function readGitHubLogin(
  store: GitHubIntegrationStore,
  member: GitHubIntegrationMember,
): Promise<GitHubLoginResponse> {
  const login = await store.getMemberLogin(member.workspaceId, member.memberKey)
  return login ? { githubLogin: login } : {}
}

/**
 * Registers the caller's GitHub login. A login another member registered is refused, so
 * notifications meant for one person never reach two.
 *
 * @param store - Store.
 * @param member - Caller.
 * @param login - Validated login.
 * @param context - Audit context and request time.
 * @returns The login response.
 */
export async function saveGitHubLogin<AuditContext>(
  store: GitHubIntegrationStore<AuditContext>,
  member: GitHubIntegrationMember,
  login: string,
  context: { auditContext?: AuditContext, now: string },
): Promise<GitHubLoginResponse> {
  const holder = await store.findMemberByLogin(member.workspaceId, login)
  if (holder !== null && holder !== member.memberKey) {
    throw new GitHubIntegrationError(
      'conflict',
      'GitHubLoginTaken',
      'Another member has registered this GitHub login. Ask a Workspace administrator to remove it.',
    )
  }
  const previous = await store.getMemberLogin(member.workspaceId, member.memberKey)
  if (previous === login) return { githubLogin: login }
  await store.saveMemberLogin({
    workspaceId: member.workspaceId,
    memberKey: member.memberKey,
    login,
    ...(previous ? { previousLogin: previous } : {}),
    ...context,
  })
  return { githubLogin: login }
}

/**
 * Removes a member's GitHub login; members remove their own, administrators anyone's.
 *
 * @param store - Store.
 * @param member - Member whose login is removed.
 * @param context - Audit context and request time.
 */
export async function deleteGitHubLogin<AuditContext>(
  store: GitHubIntegrationStore<AuditContext>,
  member: GitHubIntegrationMember,
  context: { auditContext?: AuditContext, now: string },
): Promise<void> {
  const login = await store.getMemberLogin(member.workspaceId, member.memberKey)
  if (!login) return
  await store.deleteMemberLogin({ workspaceId: member.workspaceId, memberKey: member.memberKey, login, ...context })
}

/**
 * Removes whichever member holds a login, for an administrator resolving a wrong registration.
 *
 * @param store - Store.
 * @param workspaceId - Workspace.
 * @param login - Login.
 * @param context - Audit context and request time.
 * @throws GitHubIntegrationError `not-found` when nobody holds the login.
 */
export async function deleteGitHubLoginHolder<AuditContext>(
  store: GitHubIntegrationStore<AuditContext>,
  workspaceId: string,
  login: string,
  context: { auditContext?: AuditContext, now: string },
): Promise<void> {
  const memberKey = await store.findMemberByLogin(workspaceId, login)
  if (!memberKey) throw new GitHubIntegrationError('not-found', 'GitHubLoginNotFound', 'No member has registered this GitHub login.')
  await deleteGitHubLogin(store, { workspaceId, memberKey }, context)
}

/** Dependencies of the administrator use cases. */
export type GitHubAdministrationDependencies<AuditContext> = {
  /** Store. */
  store: GitHubIntegrationStore<AuditContext>
  /** App credentials. */
  credentials: GitHubAppCredentialSource
  /** GitHub reads. */
  gateway: GitHubAppGateway
  /** Queue that takes the first sync of a new link. */
  queue: GitHubSyncQueue
}

/**
 * Lists the repositories the App can read with their Team links.
 *
 * Links of repositories the App can no longer read are listed too, so an administrator can remove
 * them.
 *
 * @param dependencies - Store, credentials, and gateway.
 * @param workspaceId - Workspace.
 * @returns The listing; `configured: false` without an App.
 */
export async function listGitHubRepositoryLinks<AuditContext>(
  dependencies: GitHubAdministrationDependencies<AuditContext>,
  workspaceId: string,
): Promise<GitHubRepositoryLinkListResponse> {
  const links = await dependencies.store.listRepositoryLinks(workspaceId)
  if (!await dependencies.credentials.read()) {
    return { configured: false, repositories: links.map(toLinkView) }
  }
  const available = await dependencies.gateway.listRepositories()
  const linked = new Map(links.map((link) => [link.repositoryId, link]))
  const repositories: GitHubRepositoryLink[] = available.repositories.map((repository) => {
    const link = linked.get(repository.repositoryId)
    linked.delete(repository.repositoryId)
    return link
      ? { ...toLinkView(link), repository: repository.repository, installationId: repository.installationId, private: repository.private }
      : { ...repository }
  })
  repositories.push(...[...linked.values()].map(toLinkView))
  repositories.sort((left, right) =>
    Number(right.teamId !== undefined) - Number(left.teamId !== undefined) ||
    left.repository.localeCompare(right.repository))
  return { configured: true, repositories, ...(available.incomplete ? { incomplete: true } : {}) }
}

/**
 * Links a repository the App can read to a Team, and queues the first sync of its open pull
 * requests.
 *
 * @param dependencies - Store, credentials, gateway, and queue.
 * @param workspaceId - Workspace.
 * @param repositoryId - Validated repository ID.
 * @param request - Team and expected revision.
 * @param context - Team existence check, audit context, and request time.
 * @returns The stored link.
 * @throws GitHubIntegrationError `not-configured`, `not-found` for a repository the App cannot read
 * or an unknown Team, or `conflict`.
 */
export async function saveGitHubRepositoryLink<AuditContext>(
  dependencies: GitHubAdministrationDependencies<AuditContext>,
  workspaceId: string,
  repositoryId: string,
  request: SaveGitHubRepositoryLinkRequest,
  context: { teamExists: (teamId: string) => Promise<boolean>, auditContext?: AuditContext, now: string },
): Promise<GitHubRepositoryLink> {
  if (!await dependencies.credentials.read()) throw notConfigured()
  if (!await context.teamExists(request.teamId)) {
    throw new GitHubIntegrationError('not-found', 'GitHubLinkTeamNotFound', 'The Team does not exist.')
  }
  const available = await dependencies.gateway.listRepositories()
  const repository = available.repositories.find((candidate) => candidate.repositoryId === repositoryId)
  if (!repository) {
    throw new GitHubIntegrationError('not-found', 'GitHubRepositoryNotFound', 'The GitHub App cannot read this repository.')
  }
  const current = await dependencies.store.getRepositoryLink(workspaceId, repositoryId)
  if (current && current.teamId === request.teamId && current.revision === (request.expectedRevision ?? 0) + 1) {
    // A retry of a save whose link was written but whose first sync job was not queued: queue it
    // again instead of failing on the revision the first attempt already advanced.
    await dependencies.queue.send({ ...repository, attempt: 0, kind: 'repository' })
    return toLinkView(current)
  }
  if (current?.revision !== request.expectedRevision) throw linkConflict()
  const record = {
    ...repository,
    teamId: request.teamId,
    revision: (current?.revision ?? 0) + 1,
    linkedAt: context.now,
  }
  await dependencies.store.saveRepositoryLink({
    workspaceId,
    record,
    ...(current ? { expectedRevision: current.revision } : {}),
    ...(context.auditContext === undefined ? {} : { auditContext: context.auditContext }),
  })
  await dependencies.queue.send({ ...repository, attempt: 0, kind: 'repository' })
  return toLinkView(record)
}

/**
 * Removes a repository's Team link; its pull requests leave every inbox at once, and the next
 * reconcile deletes their snapshots.
 *
 * @param store - Store.
 * @param workspaceId - Workspace.
 * @param repositoryId - Validated repository ID.
 * @param expectedRevision - Revision of the link the administrator saw.
 * @param context - Audit context and request time.
 * @throws GitHubIntegrationError `not-found` or `conflict`.
 */
export async function deleteGitHubRepositoryLink<AuditContext>(
  store: GitHubIntegrationStore<AuditContext>,
  workspaceId: string,
  repositoryId: string,
  expectedRevision: number,
  context: { auditContext?: AuditContext, now: string },
): Promise<void> {
  const current = await store.getRepositoryLink(workspaceId, repositoryId)
  if (!current) throw new GitHubIntegrationError('not-found', 'GitHubRepositoryLinkNotFound', 'The repository is not linked.')
  if (current.revision !== expectedRevision) throw linkConflict()
  await store.deleteRepositoryLink({ workspaceId, record: current, ...context })
}

/**
 * Builds the response view of a link.
 *
 * @param link - Stored link.
 * @returns The view.
 */
function toLinkView(link: {
  repositoryId: string
  repository: string
  installationId: string
  private: boolean
  teamId: string
  revision: number
  linkedAt: string
}): GitHubRepositoryLink {
  return {
    repositoryId: link.repositoryId,
    repository: link.repository,
    installationId: link.installationId,
    private: link.private,
    teamId: link.teamId,
    revision: link.revision,
    linkedAt: link.linkedAt,
  }
}

/**
 * Builds the error of a deployment without a GitHub App.
 *
 * @returns The error.
 */
function notConfigured(): GitHubIntegrationError {
  return new GitHubIntegrationError('not-configured', 'GitHubAppNotConfigured', 'No GitHub App is configured for this deployment.')
}

/**
 * Builds the error of a link another administrator changed first.
 *
 * @returns The error.
 */
function linkConflict(): GitHubIntegrationError {
  return new GitHubIntegrationError('conflict', 'GitHubRepositoryLinkConflict', 'The repository link changed. Reload and try again.')
}
