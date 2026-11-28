import type { GitHubPullRequestSnapshot } from '../domain/pull-request-snapshot'
import type { GitHubPullRequestNotification } from '../domain/pull-request-notifications'
import type { GitHubSyncJob } from '../domain/sync-jobs'

/** GitHub App credentials of this deployment (ADR 0079). */
export type GitHubAppCredentials = {
  /** Numeric App ID, as a decimal string; the `iss` of the App JWT. */
  appId: string
  /** PEM private key that signs the App JWT. */
  privateKey: string
  /** Current webhook secret, then the previous one while a rotation is in progress. */
  webhookSecrets: string[]
}

/** Reads the App credentials. */
export interface GitHubAppCredentialSource {
  /**
   * Reads the current credentials.
   *
   * @returns The credentials, or `null` when this deployment has no GitHub App configured.
   * @throws GitHubIntegrationError `unavailable` when the credentials exist but cannot be read.
   */
  read(): Promise<GitHubAppCredentials | null>
}

/** Repository a GitHub read targets. */
export type GitHubRepositoryReference = {
  /** Installation whose token reads the repository. */
  installationId: string
  /** GitHub's numeric repository ID, as a decimal string. */
  repositoryId: string
  /** `owner/repo`. */
  repository: string
}

/** One repository an App installation can read. */
export type GitHubInstallationRepository = GitHubRepositoryReference & {
  /** Whether the repository is private. */
  private: boolean
}

/** Pull requests read by number. */
export type GitHubPullRequestReadResult = {
  /** Snapshots of the pull requests GitHub returned. */
  snapshots: GitHubPullRequestSnapshot[]
  /** Numbers GitHub does not show to the installation any more. */
  missing: number[]
}

/** Open pull requests of a repository. */
export type GitHubOpenPullRequestReadResult = {
  /** Snapshots, most recently updated first. */
  snapshots: GitHubPullRequestSnapshot[]
  /** Whether more open pull requests exist than one read returns. */
  incomplete: boolean
}

/** Reads GitHub through the App's installation tokens. */
export interface GitHubAppGateway {
  /**
   * Lists the repositories of every installation of the App.
   *
   * @returns The repositories, and whether the listing stopped at its bound.
   * @throws GitHubIntegrationError `not-configured` without an App, or `unavailable`.
   */
  listRepositories(): Promise<{ repositories: GitHubInstallationRepository[], incomplete: boolean }>
  /**
   * Reads the current name of a repository.
   *
   * @param reference - Installation and repository ID; the name is ignored.
   * @returns `owner/repo`, or `null` when the installation cannot read the repository any more.
   */
  readRepositoryName(reference: GitHubRepositoryReference): Promise<string | null>
  /**
   * Reads pull requests by number with one GraphQL request.
   *
   * @param reference - Repository.
   * @param numbers - At most 20 numbers.
   * @param syncedAt - Read time recorded on the snapshots.
   * @returns The snapshots and the numbers GitHub no longer shows.
   */
  readPullRequests(reference: GitHubRepositoryReference, numbers: readonly number[], syncedAt: string): Promise<GitHubPullRequestReadResult>
  /**
   * Reads the open pull requests whose head is a commit.
   *
   * @param reference - Repository.
   * @param sha - Commit SHA.
   * @param syncedAt - Read time recorded on the snapshots.
   * @returns The snapshots.
   */
  readCommitPullRequests(reference: GitHubRepositoryReference, sha: string, syncedAt: string): Promise<GitHubPullRequestSnapshot[]>
  /**
   * Reads the open pull requests of a repository, optionally only those targeting one branch.
   *
   * @param reference - Repository.
   * @param options - Base branch filter.
   * @param syncedAt - Read time recorded on the snapshots.
   * @returns The snapshots, and whether more exist.
   */
  readOpenPullRequests(
    reference: GitHubRepositoryReference,
    options: { baseRef?: string },
    syncedAt: string,
  ): Promise<GitHubOpenPullRequestReadResult>
}

/** Link of a repository to the Team its pull requests belong to. */
export type GitHubRepositoryLinkRecord = GitHubInstallationRepository & {
  /** Linked Team. */
  teamId: string
  /** Revision, starting at 1. */
  revision: number
  /** When the link last changed. */
  linkedAt: string
}

/** Input of {@link GitHubIntegrationStore.saveRepositoryLink}. */
export type SaveRepositoryLinkInput<AuditContext> = {
  /** Workspace partition. */
  workspaceId: string
  /** Link to store. */
  record: GitHubRepositoryLinkRecord
  /** Revision of the link being replaced; absent for a new link. */
  expectedRevision?: number
  /** Audit context written in the same transaction. */
  auditContext?: AuditContext
}

/** Input of {@link GitHubIntegrationStore.deleteRepositoryLink}. */
export type DeleteRepositoryLinkInput<AuditContext> = {
  /** Workspace partition. */
  workspaceId: string
  /** Link to delete. */
  record: GitHubRepositoryLinkRecord
  /** Audit context written in the same transaction. */
  auditContext?: AuditContext
  /** Request time. */
  now: string
}

/** Input of {@link GitHubIntegrationStore.saveMemberLogin}. */
export type SaveMemberLoginInput<AuditContext> = {
  /** Workspace partition. */
  workspaceId: string
  /** Member key. */
  memberKey: string
  /** New login. */
  login: string
  /** Login being replaced, if any. */
  previousLogin?: string
  /** Audit context written in the same transaction. */
  auditContext?: AuditContext
  /** Request time. */
  now: string
}

/** Input of {@link GitHubIntegrationStore.deleteMemberLogin}. */
export type DeleteMemberLoginInput<AuditContext> = {
  /** Workspace partition. */
  workspaceId: string
  /** Member key. */
  memberKey: string
  /** Login to delete. */
  login: string
  /** Audit context written in the same transaction. */
  auditContext?: AuditContext
  /** Request time. */
  now: string
}

/** Stored snapshots of a Workspace. */
export type GitHubPullRequestSnapshotPage = {
  /** Snapshots. */
  snapshots: GitHubPullRequestSnapshot[]
  /** Whether more exist than one read returns. */
  incomplete: boolean
}

/** Persistence of repository links, member logins, and pull request snapshots. */
export interface GitHubIntegrationStore<AuditContext = unknown> {
  /**
   * Lists the repository links of a Workspace.
   *
   * @param workspaceId - Workspace.
   * @returns The links.
   */
  listRepositoryLinks(workspaceId: string): Promise<GitHubRepositoryLinkRecord[]>
  /**
   * Reads one repository link.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @returns The link, or `null`.
   */
  getRepositoryLink(workspaceId: string, repositoryId: string): Promise<GitHubRepositoryLinkRecord | null>
  /**
   * Reads the last revision a repository's link reached, kept after the link is removed, so a link
   * made again continues the revisions and a stale request from the old link cannot change it.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @returns The last revision, or `0` when the repository was never linked.
   */
  getLastRepositoryLinkRevision(workspaceId: string, repositoryId: string): Promise<number>
  /**
   * Creates or replaces a link when the expected revision is still current.
   *
   * @param input - Link, expected revision, and audit context.
   * @throws GitHubIntegrationError `conflict` when another change came first.
   */
  saveRepositoryLink(input: SaveRepositoryLinkInput<AuditContext>): Promise<void>
  /**
   * Deletes a link when its revision is still current.
   *
   * @param input - Link and audit context.
   * @throws GitHubIntegrationError `conflict` when another change came first.
   */
  deleteRepositoryLink(input: DeleteRepositoryLinkInput<AuditContext>): Promise<void>
  /**
   * Reads a member's GitHub login.
   *
   * @param workspaceId - Workspace.
   * @param memberKey - Member key.
   * @returns The login, or `null`.
   */
  getMemberLogin(workspaceId: string, memberKey: string): Promise<string | null>
  /**
   * Finds the member who registered a login.
   *
   * @param workspaceId - Workspace.
   * @param login - GitHub login, in any case.
   * @returns The member key, or `null`.
   */
  findMemberByLogin(workspaceId: string, login: string): Promise<string | null>
  /**
   * Registers a member's login, which no other member may hold.
   *
   * @param input - Member, login, previous login, and audit context.
   * @throws GitHubIntegrationError `conflict` when another member holds the login or a concurrent
   * change came first.
   */
  saveMemberLogin(input: SaveMemberLoginInput<AuditContext>): Promise<void>
  /**
   * Removes a member's login.
   *
   * @param input - Member, login, and audit context.
   * @throws GitHubIntegrationError `conflict` when the login changed first.
   */
  deleteMemberLogin(input: DeleteMemberLoginInput<AuditContext>): Promise<void>
  /**
   * Lists the snapshots of a Workspace.
   *
   * @param workspaceId - Workspace.
   * @param options - Whether to read past the usual bound, for maintenance.
   * @param options.exhaustive - Whether every snapshot is read; the result is then never incomplete.
   * @returns The snapshots, and whether the read stopped at its bound.
   */
  listPullRequestSnapshots(workspaceId: string, options?: { exhaustive?: boolean }): Promise<GitHubPullRequestSnapshotPage>
  /**
   * Reads one snapshot with a consistent read.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @param number - Pull request number.
   * @returns The snapshot, or `null` when none is stored or the stored row cannot be read.
   */
  getPullRequestSnapshot(workspaceId: string, repositoryId: string, number: number): Promise<GitHubPullRequestSnapshot | null>
  /**
   * Writes a snapshot unless a snapshot read later is already stored.
   *
   * @param workspaceId - Workspace.
   * @param snapshot - Snapshot.
   * @returns `written`, or `stale` when a later read is already stored.
   */
  putPullRequestSnapshot(workspaceId: string, snapshot: GitHubPullRequestSnapshot): Promise<'written' | 'stale'>
  /**
   * Deletes a snapshot.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @param number - Pull request number.
   * @param expectedSyncedAt - When given, deletes only the snapshot read at this time, so a newer
   *   snapshot a concurrent sync wrote is kept.
   * @returns `deleted`, or `stale` when a newer snapshot was kept.
   */
  deletePullRequestSnapshot(workspaceId: string, repositoryId: string, number: number, expectedSyncedAt?: string): Promise<'deleted' | 'stale'>
}

/** Queue of sync jobs. */
export interface GitHubSyncQueue {
  /**
   * Sends a job.
   *
   * @param job - Job.
   * @param delaySeconds - Seconds before the worker may receive it, at most 900.
   */
  send(job: GitHubSyncJob, delaySeconds?: number): Promise<void>
}

/** One Inbox notification to deliver, resolved to a member. */
export type GitHubPullRequestNotificationDelivery = GitHubPullRequestNotification & {
  /** Workspace. */
  workspaceId: string
  /** Member key of the recipient. */
  memberKey: string
  /** Team the repository is linked to; the recipient must still read it when it is delivered. */
  teamId: string
  /** Pull request the notification is about. */
  pullRequest: GitHubPullRequestSnapshot
}

/** Writes Inbox notifications of pull request changes (#775). */
export interface GitHubPullRequestNotificationSink {
  /**
   * Writes one notification; writing the same key again does nothing.
   *
   * @param delivery - Notification and its recipient.
   */
  publish(delivery: GitHubPullRequestNotificationDelivery): Promise<void>
}
