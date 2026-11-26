import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  TIME_BUDGET_ALERT_PERCENT_DEFAULT,
  type ProjectExpense,
  type TimeBudget,
  type TimeEntry,
  type TenantProfile,
  type EnterpriseIdentitySnapshot,
} from '@mukuroji/contracts'
import { listEnterpriseProjectManagerKeys } from '../../modules/enterprise-identity'
import type {
  BudgetAlertProject,
  ScheduledBudgetThresholdReader,
  ScheduledProjectBudgetStatus,
} from '../../modules/notifications'
import { loadProjectBudgetConsumption } from '../../modules/project-budget'

/** Reads the budget threshold reader needs (ADR 0105). */
export type BudgetThresholdReaderSources = {
  /** Lists a Workspace's active Projects with their charter owner and managers. */
  readProjects(workspaceId: string): Promise<readonly BudgetAlertProject[]>
  /** Reads the Workspace profile for its time zone and status. */
  readProfile(workspaceId: string): Promise<Pick<TenantProfile, 'calendar' | 'status'> | undefined>
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
    /** Inclusive lower instant. */
    from: string
    /** Upper instant. */
    to: string
  }): Promise<readonly TimeEntry[]>
  /** Reads every expense of a Project. */
  listExpenses(workspaceId: string, teamId: string, projectId: string): Promise<readonly ProjectExpense[]>
  /** Reads the Workspace's Enterprise roles, when the deployment has them. */
  readEnterpriseSnapshot?(workspaceId: string): Promise<Pick<EnterpriseIdentitySnapshot, 'customRoles' | 'roleAssignments'>>
}

/**
 * Adapts the Project Directory, time tracking, and Project expenses to the schedule's budget
 * threshold reader.
 *
 * Each Project's use is measured in the Workspace time zone the same way as the Project budget
 * report: time cost plus approved expenses in the budget currency. A Workspace being closed is
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
      let enterprise: Pick<EnterpriseIdentitySnapshot, 'customRoles' | 'roleAssignments'> | undefined
      for (const project of await sources.readProjects(workspaceId)) {
        const consumption = await loadProjectBudgetConsumption(
          { workspaceId, teamId: project.teamId, projectId: project.projectId },
          timeZone,
          now,
          sources,
        )
        if (!consumption) continue
        const { budget } = consumption
        enterprise ??= await sources.readEnterpriseSnapshot?.(workspaceId)
        const managerMemberKeys = enterprise
          ? [...new Set([...project.managerMemberKeys, ...listEnterpriseProjectManagerKeys(enterprise, project.teamId, project.projectId)])]
          : project.managerMemberKeys
        statuses.push({
          teamId: project.teamId,
          projectId: project.projectId,
          amountMinor: budget.amountMinor,
          currency: budget.currency,
          ...(budget.periodFrom === undefined ? {} : { periodFrom: budget.periodFrom }),
          ...(budget.periodTo === undefined ? {} : { periodTo: budget.periodTo }),
          alertPercent: budget.alertPercent ?? TIME_BUDGET_ALERT_PERCENT_DEFAULT,
          consumedPercent: consumption.consumedPercent,
          ...(project.ownerMemberKey === undefined ? {} : { ownerMemberKey: project.ownerMemberKey }),
          managerMemberKeys,
        })
      }
      return statuses
    },
  }
}
