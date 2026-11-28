import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  TIME_BUDGET_ALERT_PERCENT_DEFAULT,
  type ProjectExpense,
  type TimeBudget,
  type TimeEntry,
  type TenantProfile,
  type EnterpriseIdentitySnapshot,
} from '@mukuroji/contracts'
import { evaluateEnterpriseProjectManager, listEnterpriseProjectManagerKeys } from '../../modules/enterprise-identity'
import type {
  BudgetAlertProject,
  ScheduledBudgetThresholdReader,
  ScheduledProjectBudgetStatus,
} from '../../modules/notifications'
import { loadProjectBudgetConsumption, type ProjectBudgetConsumptionPorts } from '../../modules/project-budget'
import { isWorkspaceMemberRowActive } from '../../modules/workspace-access'

/** Reads the budget threshold reader needs (ADR 0105). */
export type BudgetThresholdReaderSources = {
  /** Lists a Workspace's active Projects with their charter owner and managers. */
  readProjects(workspaceId: string): Promise<readonly BudgetAlertProject[]>
  /** Reads the Workspace profile for its time zone and status. */
  readProfile(workspaceId: string): Promise<Pick<TenantProfile, 'calendar' | 'status' | 'agentCost'> | undefined>
  /** Reads the default budget of a Project. */
  getBudget(workspaceId: string, teamId: string, projectId: string): Promise<TimeBudget | undefined>
  /** Lists the time entries of a Project that start within the UTC instants. */
  listEntries(input: {
    /** Workspace directory ID. */
    workspaceId: string
    /** Team ID. */
    teamId: string
    /** Project ID. */
    projectId: string
    /** Inclusive lower instant, or undefined to read from the first entry. */
    from?: string
    /** Upper instant. */
    to: string
  }): Promise<readonly TimeEntry[]>
  /** Reads every expense of a Project. */
  listExpenses(workspaceId: string, teamId: string, projectId: string): Promise<readonly ProjectExpense[]>
  /** Reads one page of a Team's Work Items to find a Project's Work Items (ADR 0119). */
  listWorkItems?: ProjectBudgetConsumptionPorts['listWorkItems']
  /** Reads Agent Run cost; absent when the deployment has no Software factory (ADR 0119). */
  listAgentRunCosts?: ProjectBudgetConsumptionPorts['listAgentRunCosts']
  /** Reads the Workspace's Enterprise roles, when the deployment has them. */
  readEnterpriseSnapshot?(workspaceId: string): Promise<EnterpriseIdentitySnapshot>
  /** Lists every member row of the Workspace, deactivated and expired members included. */
  listWorkspaceMembers(workspaceId: string): Promise<readonly BudgetAlertWorkspaceMember[]>
}

/** The parts of a Workspace member row that tell whether the member can still be notified. */
export type BudgetAlertWorkspaceMember = {
  /** Member key. */
  memberKey: string
  /** Membership status; only `active` members are notified. */
  status: string
  /** Instant the member's access ends, when it is limited. */
  accessExpiresAt?: string
}

/**
 * Narrows a Project's managers to those delivery will accept. A member an Enterprise role governs
 * counts only while that role manages the Project, and a member it does not govern counts by their
 * manager row. Members an Enterprise role makes managers are added. An owner whose standing
 * depends on sign-in groups is not preferred, so the other managers are told as well (ADR 0105).
 *
 * @param snapshot - Enterprise state of the Workspace.
 * @param project - Project with its charter owner and manager members.
 * @returns The effective managers and the owner to prefer.
 */
function selectEffectiveManagers(
  snapshot: EnterpriseIdentitySnapshot,
  project: BudgetAlertProject,
): Pick<BudgetAlertProject, 'managerMemberKeys' | 'ownerMemberKey'> {
  const legacy = new Set(project.managerMemberKeys)
  const statusOf = (memberKey: string) => evaluateEnterpriseProjectManager(snapshot, memberKey, project.teamId, project.projectId)
  const candidates = [...new Set([...project.managerMemberKeys, ...listEnterpriseProjectManagerKeys(snapshot, project.teamId, project.projectId)])]
  const managerMemberKeys = candidates.filter((memberKey) => {
    const status = statusOf(memberKey)
    return status === 'manager' || (status !== 'not-manager' && legacy.has(memberKey))
  })
  const owner = project.ownerMemberKey
  return {
    managerMemberKeys,
    ...(owner === undefined || statusOf(owner) === 'unknown' ? {} : { ownerMemberKey: owner }),
  }
}

/**
 * Adapts the Project Directory, time tracking, and Project expenses to the schedule's budget
 * threshold reader.
 *
 * Each Project's use is measured in the Workspace time zone the same way as the Project budget
 * report: time cost plus approved expenses in the budget currency, plus Agent Run cost when the
 * Workspace counts it (ADR 0119). A Workspace being closed is
 * not checked. The managers are the Project's manager members and the members an Enterprise role
 * makes managers of the Project or its Team.
 *
 * @param sources - Directory, profile, budget, entry, and expense reads.
 * @returns Reader of budget use per active Project.
 */
export function createBudgetThresholdReader(sources: BudgetThresholdReaderSources): ScheduledBudgetThresholdReader {
  return {
    async listProjectBudgetStatuses(workspaceId, now) {
      const profile = await sources.readProfile(workspaceId)
      if (profile && profile.status !== 'active') return []
      const timeZone = (profile?.calendar ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS).timeZone
      const statuses: ScheduledProjectBudgetStatus[] = []
      let enterprise: EnterpriseIdentitySnapshot | undefined
      let activeMembers: ReadonlySet<string> | undefined
      for (const project of await sources.readProjects(workspaceId)) {
        const consumption = await loadProjectBudgetConsumption(
          { workspaceId, teamId: project.teamId, projectId: project.projectId },
          timeZone,
          now,
          {
            getBudget: sources.getBudget,
            listEntries: sources.listEntries,
            listExpenses: sources.listExpenses,
            // The profile was read above, so the agent cost settings come from it.
            readAgentCostSettings: async () => profile?.agentCost,
            ...(sources.listWorkItems ? { listWorkItems: sources.listWorkItems } : {}),
            ...(sources.listAgentRunCosts ? { listAgentRunCosts: sources.listAgentRunCosts } : {}),
          },
        )
        if (!consumption) continue
        const { budget } = consumption
        enterprise ??= await sources.readEnterpriseSnapshot?.(workspaceId)
        const active = activeMembers ??= await readActiveMemberKeys(sources, workspaceId, now)
        const effective = enterprise ? selectEffectiveManagers(enterprise, project) : project
        // Delivery skips a member whose Workspace access ended, so such a manager is left out before
        // the owner is preferred; otherwise an expired owner would leave the alert with no reader.
        const managerMemberKeys = effective.managerMemberKeys.filter((key) => active.has(key))
        const ownerMemberKey = effective.ownerMemberKey !== undefined && active.has(effective.ownerMemberKey)
          ? effective.ownerMemberKey
          : undefined
        statuses.push({
          teamId: project.teamId,
          projectId: project.projectId,
          amountMinor: budget.amountMinor,
          currency: budget.currency,
          ...(budget.periodFrom === undefined ? {} : { periodFrom: budget.periodFrom }),
          ...(budget.periodTo === undefined ? {} : { periodTo: budget.periodTo }),
          alertPercent: budget.alertPercent ?? TIME_BUDGET_ALERT_PERCENT_DEFAULT,
          actualCostMinor: consumption.actualCostMinor,
          consumedPercent: consumption.consumedPercent,
          ...(ownerMemberKey === undefined ? {} : { ownerMemberKey }),
          managerMemberKeys,
        })
      }
      return statuses
    },
  }
}

/**
 * Reads the members of a Workspace who can still be notified.
 *
 * @param sources - Reader of the Workspace's member rows.
 * @param workspaceId - Workspace to read.
 * @param now - Schedule execution instant.
 * @returns Lower-case member keys of the active members whose access has not ended.
 */
async function readActiveMemberKeys(
  sources: Pick<BudgetThresholdReaderSources, 'listWorkspaceMembers'>,
  workspaceId: string,
  now: Date,
): Promise<ReadonlySet<string>> {
  return new Set((await sources.listWorkspaceMembers(workspaceId))
    .filter((member) => isWorkspaceMemberRowActive(member, now))
    .map((member) => member.memberKey.trim().toLowerCase()))
}
