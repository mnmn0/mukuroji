/** Webhook resource ACL projection の partition key を作成します。 */
export function createWebhookResourceAuthorizationKey(workspaceId: string) {
  return `WEBHOOK_ACL#RESOURCE#${workspaceId}`
}

/** Webhook Project member ACL projection の partition key を作成します。 */
export function createWebhookMemberAuthorizationKey(
  workspaceId: string,
  memberKey: string,
) {
  return `WEBHOOK_ACL#MEMBER#${workspaceId}#${memberKey}`
}

/** Webhook Team/member grant projection の partition key を作成します。 */
export function createWebhookTeamMemberAuthorizationKey(
  workspaceId: string,
  teamId: string,
  memberKey: string,
) {
  return `WEBHOOK_ACL#TEAM_MEMBER#${workspaceId}#${teamId}#${memberKey}`
}

/** Webhook Team ACL projection の sort key を作成します。 */
export function createWebhookTeamAuthorizationSortKey(teamId: string) {
  return `TEAM#${teamId}`
}

/** Webhook Project ACL projection の sort key を作成します。 */
export function createWebhookProjectAuthorizationSortKey(projectId: string) {
  return `PROJECT#${projectId}`
}

/** Project member の authoritative base-table sort key を作成します。 */
export function createWebhookProjectMemberEntryKey(
  projectId: string,
  memberKey: string,
) {
  return `PROJECT_MEMBER#${projectId}#${memberKey}`
}

/** Team/member grant 専用の base-table partition key を作成します。 */
export function createWebhookTeamGrantDirectoryId(
  workspaceId: string,
  memberKey: string,
) {
  return `WEBHOOK_TEAM_GRANT#${workspaceId}#${memberKey}`
}

/** Team/member grant の base-table sort key prefix を作成します。 */
export function createWebhookTeamGrantEntryKeyPrefix(teamId: string) {
  return `TEAM#${teamId}#PROJECT#`
}

/** Team/member grant の base-table sort key を作成します。 */
export function createWebhookTeamGrantEntryKey(
  teamId: string,
  projectId: string,
) {
  return `${createWebhookTeamGrantEntryKeyPrefix(teamId)}${projectId}`
}

/** Team-only Webhook ACL を直接引く materialized grant row を作成します。 */
export function createWebhookTeamGrantItem(input: {
  /** Workspace ID です。 */
  workspaceId: string
  /** Team ID です。 */
  teamId: string
  /** Project ID です。 */
  projectId: string
  /** Project member key です。 */
  memberKey: string
  /** Team source row の base-table sort key です。 */
  teamSourceEntryKey: string
  /** Project source row の base-table sort key です。 */
  projectSourceEntryKey: string
}) {
  const sourceEntryKey = createWebhookProjectMemberEntryKey(
    input.projectId,
    input.memberKey,
  )
  return {
    directoryId: createWebhookTeamGrantDirectoryId(
      input.workspaceId,
      input.memberKey,
    ),
    entryKey: createWebhookTeamGrantEntryKey(input.teamId, input.projectId),
    entryType: 'webhook-team-grant',
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    projectId: input.projectId,
    memberKey: input.memberKey,
    sourceEntryKey,
    teamSourceEntryKey: input.teamSourceEntryKey,
    projectSourceEntryKey: input.projectSourceEntryKey,
    webhookAuthorizationKey: createWebhookTeamMemberAuthorizationKey(
      input.workspaceId,
      input.teamId,
      input.memberKey,
    ),
    webhookAuthorizationSortKey:
      createWebhookProjectAuthorizationSortKey(input.projectId),
  } as const
}
