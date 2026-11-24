import { useMemo } from 'react'
import type { WorkspaceMemberOffboarding } from '@mukuroji/contracts'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { updateProjectMember } from '../../projects/api/members'
import { updatePlanningEntity } from '../../planning/api/entities'
import { revokeWorkspaceMemberCredentials } from '../api/members'

/** Handover actions of the member offboarding dialog. */
export type MemberOffboardingActions = {
  /**
   * Makes the successor a manager of every Project the member manages, then makes the member a
   * plain member of it.
   *
   * @param offboarding - Summary the dialog shows.
   * @param successorKey - Member who takes over.
   */
  transferProjects: (offboarding: WorkspaceMemberOffboarding, successorKey: string) => Promise<void>
  /**
   * Makes the successor the owner of every active Planning entity the member owns.
   *
   * @param offboarding - Summary the dialog shows; its Planning revision fences the first change.
   * @param successorKey - Member who takes over.
   */
  transferPlanningEntities: (offboarding: WorkspaceMemberOffboarding, successorKey: string) => Promise<void>
  /** Revokes every API key and OAuth application the member created. */
  revokeCredentials: () => Promise<void>
}

/**
 * Hands a leaving member's Project manager roles and Planning ownership to a successor, and
 * revokes the member's credentials, reading the summary again after each step.
 *
 * Each step uses the existing Project member and Planning APIs, so their own permission and
 * revision checks apply. A step that fails part way leaves the summary showing what remains.
 *
 * @param accessToken - Access token of the session.
 * @param memberKey - Member who is leaving.
 * @param reload - Reads the summary again.
 * @returns The handover actions.
 */
export function useMemberOffboardingActions(
  accessToken: string,
  memberKey: string,
  reload: () => Promise<unknown>,
): MemberOffboardingActions {
  return useMemo(() => {
    const runner = createMutationRequestRunner()
    /**
     * Runs a handover step and reads the summary again whatever its outcome.
     *
     * @param step - Requests of the step.
     */
    const withReload = async (step: () => Promise<void>) => {
      try {
        await step()
      } finally {
        await reload()
      }
    }
    return {
      transferProjects: (offboarding, successorKey) => withReload(async () => {
        for (const project of offboarding.managedProjects) {
          // The successor becomes a manager first, so the Project never lacks one.
          for (const [key, role] of [[successorKey, 'manager'], [memberKey, 'member']] as const) {
            await runner.run(
              `project-member:update:${project.projectId}:${key}`,
              JSON.stringify({ role }),
              (context) => updateProjectMember(accessToken, project.projectId, key, { role }, context),
            )
          }
        }
      }),
      transferPlanningEntities: (offboarding, successorKey) => withReload(async () => {
        let expectedRevision = offboarding.planningRevision
        for (const entity of offboarding.ownedPlanningEntities) {
          const input = { expectedRevision, patch: { ownerMemberKey: successorKey } }
          const snapshot = await runner.run(
            `planning-entity:owner:${entity.id}`,
            JSON.stringify(input),
            (context) => updatePlanningEntity(accessToken, entity.id, input, context),
          )
          expectedRevision = snapshot.revision
        }
      }),
      revokeCredentials: () => withReload(async () => {
        await runner.run(
          `workspace-member:credentials-revoke:${memberKey}`,
          '{}',
          (context) => revokeWorkspaceMemberCredentials(accessToken, memberKey, context),
        )
      }),
    }
  }, [accessToken, memberKey, reload])
}
