/** Canonical scheduling dependency types shared by planning entities and Work Items. */
export type ScheduleDependencyType =
  | 'finish-to-start'
  | 'start-to-start'
  | 'finish-to-finish'
  | 'start-to-finish'

/** An explicit date constraint applied to one successor schedule anchor. */
export type ScheduleDependencyConstraint = {
  /** Successor schedule boundary constrained by this rule. */
  anchor: 'start' | 'finish'
  /** Whether the anchor must equal, follow, or precede the constraint date. */
  kind: 'on' | 'not-before' | 'not-after'
  /** Local constraint date in `YYYY-MM-DD` form. */
  date: string
}

/** Stable identity of one Team-owned Work Item in a Workspace dependency graph. */
export type WorkItemDependencyEndpoint = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local canonical Work Item identifier. */
  workItemId: string
}

/** Canonical scheduling dependency between two Work Items. */
export type WorkItemScheduleDependency = {
  /** Workspace-local dependency identifier. */
  id: string
  /** Work Item whose start or finish drives the dependency. */
  predecessor: WorkItemDependencyEndpoint
  /** Work Item whose schedule is constrained by the dependency. */
  successor: WorkItemDependencyEndpoint
  /** Start/finish boundary relationship. */
  type: ScheduleDependencyType
  /** Signed calendar-day offset; positive values are lag and negative values are lead. */
  lagDays: number
  /** Optional explicit date constraint on the successor schedule. */
  constraint?: ScheduleDependencyConstraint
  /** Creation timestamp in ISO 8601 form. */
  createdAt: string
  /** Last update timestamp in ISO 8601 form. */
  updatedAt: string
}

/** Stable schedule conflict reported from the canonical Work Item dependency graph. */
export type WorkItemScheduleDependencyConflict = {
  /** Machine-readable conflict category. */
  code: 'missing-schedule' | 'dependency-violation' | 'constraint-violation'
  /** Dependency whose rule cannot be satisfied by the current schedule. */
  dependencyId: string
  /** Constrained successor Work Item. */
  workItem: WorkItemDependencyEndpoint
  /** Earliest or exact date required by the dependency, when one can be derived. */
  requiredDate?: string
  /** Current successor anchor date, when one exists. */
  actualDate?: string
}

/** Critical path calculated from the visible canonical Work Item dependency graph. */
export type WorkItemDependencyCriticalPath = {
  /** Work Items on the longest dependency path in predecessor-to-successor order. */
  workItems: WorkItemDependencyEndpoint[]
  /** Total calendar-day duration of the critical path. */
  totalDurationDays: number
  /** Total slack keyed by percent-encoded `teamId/workItemId` endpoint identities. */
  slackByWorkItemKey: Record<string, number>
}

/** Management summary derived from the same Work Item dependencies used by task views. */
export type PlanningWorkItemDependencySummary = {
  /** Longest visible Work Item schedule path. */
  criticalPath: WorkItemDependencyCriticalPath
  /** Current schedule or explicit-constraint conflicts. */
  conflicts: WorkItemScheduleDependencyConflict[]
  /** Dependencies whose predecessor is not completed or canceled. */
  unresolvedBlockerCount: number
  /** Projects reached by at least one visible dependency endpoint. */
  affectedProjectIds: string[]
  /** Milestones linked to at least one visible dependency endpoint. */
  affectedMilestoneIds: string[]
}
