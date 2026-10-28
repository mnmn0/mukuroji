import {
  DynamoDbProjectDirectoryClient,
  ProjectDataError,
  normalizeProjectMemberKey,
} from '../../modules/directory'
import {
  TriageError,
  type TriageAdmissionValidator,
  type TriageAuthorizationConditionChecks,
} from '../../modules/triage'
import {
  DynamoDbWorkspaceAccessClient,
  type WorkspaceActiveMemberConditionOptions,
} from '../../modules/workspace-access'

/** Workspace roles that may own a Triage entry or escalation. */
export const TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS: WorkspaceActiveMemberConditionOptions = {
  allowedRoles: ['owner', 'admin', 'member'],
}

/** Identifies one configured owner that must retain access to a destination Project. */
export type TriageOwnerProjectReference = {
  /** Workspace member selected as the owner. */
  memberUserId: string
  /** Project that the owner must be able to operate in. */
  projectId: string
}

/** Builds commit-time Project membership fences for configured Triage owners.
 *
 * @param projectDirectory Authoritative Project membership reader.
 * @param workspaceId Owning Workspace identifier.
 * @param references Owner and destination Project pairs to fence.
 * @param errorCode Stable error code when an owner lacks Project access.
 * @param errorMessage Safe error message when an owner lacks Project access.
 * @returns Deduplicated Project membership condition checks.
 */
export async function createTriageOwnerProjectConditionChecks(
  projectDirectory: Pick<DynamoDbProjectDirectoryClient, 'createProjectAccessConditionCheck'>,
  workspaceId: string,
  references: readonly TriageOwnerProjectReference[],
  errorCode: string,
  errorMessage: string,
): Promise<TriageAuthorizationConditionChecks> {
  const uniqueReferences = new Map<string, TriageOwnerProjectReference>()
  for (const reference of references) {
    const memberUserId = normalizeProjectMemberKey(reference.memberUserId)
    uniqueReferences.set(`${reference.projectId}\u0000${memberUserId}`, {
      memberUserId,
      projectId: reference.projectId,
    })
  }
  const conditionChecks = await Promise.all([...uniqueReferences.values()].map(async (reference) =>
    await projectDirectory.createProjectAccessConditionCheck(
      workspaceId,
      reference.projectId,
      reference.memberUserId,
      'member',
    )
  ))
  if (conditionChecks.some((conditionCheck) => conditionCheck === undefined)) {
    throw new TriageError(409, errorCode, errorMessage)
  }
  return conditionChecks.flatMap((conditionCheck) =>
    conditionCheck === undefined ? [] : [conditionCheck]
  )
}

/** Creates live Project/member validation for every Triage admission attempt.
 *
 * @param projectDirectory Authoritative active Team and Project directory reader.
 * @param workspaceAccess Authoritative active Workspace member reader.
 * @returns A validator invoked after each current configuration evaluation.
 */
export function createTriageAdmissionValidator(
  projectDirectory: Pick<
    DynamoDbProjectDirectoryClient,
    'createActiveReferenceConditionChecks' | 'createProjectAccessConditionCheck'
  >,
  workspaceAccess: Pick<DynamoDbWorkspaceAccessClient, 'createActiveMemberConditionCheck'>,
): TriageAdmissionValidator {
  return async (entry, configuration) => {
    let directoryConditionChecks
    try {
      directoryConditionChecks = await projectDirectory.createActiveReferenceConditionChecks(
        entry.workspaceId,
        entry.teamId,
        entry.projectId,
      )
    } catch (error) {
      if (error instanceof ProjectDataError && error.code === 'TeamNotFound') {
        throw new TriageError(
          409,
          'TriageAdmissionTeamUnavailable',
          'The target Triage Team is not active.',
          { cause: error },
        )
      }
      if (error instanceof ProjectDataError && error.code === 'ProjectNotFound') {
        throw new TriageError(
          409,
          'TriageAdmissionProjectUnavailable',
          'The configured Triage Project is not active in the target Team.',
          { cause: error },
        )
      }
      throw error
    }
    const memberUserIds = new Set<string>()
    if (entry.ownerUserId) memberUserIds.add(normalizeProjectMemberKey(entry.ownerUserId))
    const slaPolicy = entry.sla
      ? configuration.slaPolicies.find((candidate) => candidate.id === entry.sla?.policyId)
      : undefined
    if (slaPolicy?.escalationOwnerUserId) {
      memberUserIds.add(normalizeProjectMemberKey(slaPolicy.escalationOwnerUserId))
    }
    const memberConditionChecks = await Promise.all([...memberUserIds].map(async (memberUserId) =>
      await workspaceAccess.createActiveMemberConditionCheck(
        entry.workspaceId,
        memberUserId,
        TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
      )
    ))
    if (memberConditionChecks.some((conditionCheck) => conditionCheck === undefined)) {
      throw new TriageError(
        409,
        'TriageAdmissionOwnerUnavailable',
        'A configured Triage owner is not an active Workspace member.',
      )
    }
    const admissionProjectId = entry.projectId
    const ownerProjectConditionChecks = await createTriageOwnerProjectConditionChecks(
      projectDirectory,
      entry.workspaceId,
      admissionProjectId
        ? [...memberUserIds].map((memberUserId) => ({
            memberUserId,
            projectId: admissionProjectId,
          }))
        : [],
      'TriageAdmissionOwnerProjectUnavailable',
      'A configured Triage owner cannot access the destination Project.',
    )
    return {
      transactItems: [
        ...directoryConditionChecks,
        ...memberConditionChecks.flatMap((conditionCheck) =>
          conditionCheck === undefined ? [] : [conditionCheck]
        ),
        ...ownerProjectConditionChecks,
      ],
    }
  }
}
