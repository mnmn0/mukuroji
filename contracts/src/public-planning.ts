import type { CursorPage } from './developer-platform'
import type {
  PlanningCadence,
  PlanningDateRange,
  PlanningEntityType,
  PlanningGoalFramework,
  PlanningEntityStatus,
  PlanningHealth,
  PlanningRisk,
  PlanningUpdateProgressSnapshot,
  PlanningUpdateTarget,
} from './planning'

/** Planning entity types `GET /api/v1/planning/entities` lists. */
export const PUBLIC_PLANNING_ENTITY_TYPES = [
  'portfolio',
  'roadmap',
  'initiative',
  'goal',
  'phase',
  'milestone',
  'release',
  'cycle',
] as const satisfies readonly PlanningEntityType[]

/** One Planning entity type the Public API lists. */
export type PublicPlanningEntityType = typeof PUBLIC_PLANNING_ENTITY_TYPES[number]

/**
 * Tells whether a value is a Planning entity type the Public API lists.
 *
 * @param value - Value to test.
 * @returns Whether the value is one of {@link PUBLIC_PLANNING_ENTITY_TYPES}.
 */
export function isPublicPlanningEntityType(value: unknown): value is PublicPlanningEntityType {
  return PUBLIC_PLANNING_ENTITY_TYPES.some((type) => type === value)
}

/** A Planning entity such as a Milestone, Cycle, or Initiative, as the Public API returns it. */
export type PublicPlanningEntity = {
  /** Planning entity ID. */
  id: string
  /** Entity type. */
  type: PublicPlanningEntityType
  /** Title. */
  title: string
  /** Description, up to 20 KB of UTF-8. */
  description?: string
  /** Parent entity in the Planning hierarchy. */
  parentId?: string
  /** Team the entity is scoped to; absent for a Workspace-wide entity. */
  teamId?: string
  /** Project the entity is scoped to, inside `teamId`. */
  projectId?: string
  /** Member ID of the owner. */
  ownerMemberId: string
  /** Lifecycle status. */
  status: PlanningEntityStatus
  /** Health the owner set. */
  health: PlanningHealth
  /** Risk level the owner set. */
  risk: PlanningRisk
  /** Progress from 0 to 100, computed when read. */
  progress: number
  /** Number of distinct Work Items linked to the entity or its descendants. */
  linkedWorkItemCount: number
  /** Planned date range fixed as the baseline; one day for a Milestone. */
  baseline: PlanningDateRange
  /** Current forecast date range; one day, the target date, for a Milestone. */
  forecast: PlanningDateRange
  /** Cycle cadence; Cycles only. */
  cadence?: PlanningCadence
  /** Number of Work Items a Cycle holds; Cycles only. */
  capacity?: number
  /** Role in the Goal / OKR hierarchy; Goals only. */
  goalFramework?: PlanningGoalFramework
  /** When the entity was created. */
  createdAt: string
  /** When the entity last changed. */
  updatedAt: string
}

/** Response of `GET /api/v1/planning/entities`. */
export type PublicPlanningEntityList = {
  /** Response schema version. */
  schemaVersion: 1
  /** Planning graph revision of the read; send it as `expectedRevision` on the next write. */
  revision: number
  /** Unarchived entities the client may read, in Planning order. */
  items: PublicPlanningEntity[]
}

/** Body of `POST /api/v1/planning/milestones`. */
export type CreatePublicMilestoneRequest = {
  /** Title. */
  title: string
  /** Description, up to 20 KB of UTF-8. */
  description?: string
  /** Parent in the Planning hierarchy: a Phase, Goal, Initiative, or Roadmap. */
  parentId: string
  /** Team scope; omitted for a Workspace-wide Milestone. It must match the parent's Team. */
  teamId?: string
  /** Project scope inside `teamId`. */
  projectId?: string
  /** Member ID of the owner; defaults to the credential owner. */
  ownerMemberId?: string
  /** Lifecycle status; defaults to `planned`. */
  status?: PlanningEntityStatus
  /** Health; defaults to `unknown`. */
  health?: PlanningHealth
  /** Risk level; defaults to `none`. */
  risk?: PlanningRisk
  /** Target date as `YYYY-MM-DD`; a Milestone is one day. */
  targetDate: string
  /** Baseline date as `YYYY-MM-DD`; defaults to `targetDate`. */
  baselineDate?: string
  /**
   * Planning graph revision the client read. Omitted, the server applies the write to the latest
   * revision.
   */
  expectedRevision?: number
}

/** Body of `PATCH /api/v1/planning/milestones/{milestoneId}`; only the fields sent change. */
export type UpdatePublicMilestoneRequest = {
  /**
   * Planning graph revision the client read. Omitted, the server applies the write to the latest
   * revision.
   */
  expectedRevision?: number
  /** New title. */
  title?: string
  /** New description; null removes it. */
  description?: string | null
  /** New owner member ID. */
  ownerMemberId?: string
  /** New lifecycle status. */
  status?: PlanningEntityStatus
  /** New health. */
  health?: PlanningHealth
  /** New risk level. */
  risk?: PlanningRisk
  /** New target date as `YYYY-MM-DD`. */
  targetDate?: string
  /** New baseline date as `YYYY-MM-DD`. */
  baselineDate?: string
}

/** Response of creating or updating a Milestone through the Public API. */
export type PublicPlanningEntityMutation = {
  /** Response schema version. */
  schemaVersion: 1
  /** Planning graph revision after the write. */
  revision: number
  /** The saved entity. */
  item: PublicPlanningEntity
}

/** Response of `GET` and `PUT /api/v1/work-items/{workItemId}/planning`. */
export type PublicWorkItemPlanning = {
  /** Response schema version. */
  schemaVersion: 1
  /** Planning graph revision of the read or write. */
  revision: number
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
  /** Cycle the Work Item is in. */
  cycleId?: string
  /** Milestone the Work Item contributes to. */
  milestoneId?: string
  /** Goal or OKR entities the Work Item contributes to. */
  goalIds: string[]
}

/** Body of `PUT /api/v1/work-items/{workItemId}/planning`; omitted fields keep their value. */
export type UpdatePublicWorkItemPlanningRequest = {
  /**
   * Planning graph revision the client read. Omitted, the server applies the write to the latest
   * revision.
   */
  expectedRevision?: number
  /** Cycle to put the Work Item in; null takes it out of its Cycle. */
  cycleId?: string | null
  /** Milestone the Work Item contributes to; null removes it. */
  milestoneId?: string | null
}

/** A health update of a Project, Team, or Initiative, as the Public API returns it. */
export type PublicPlanningStatusUpdate = {
  /** Update ID. */
  id: string
  /** Version within the target, increasing by one per update. */
  version: number
  /** Project, Team, or Initiative the update is about. */
  target: PlanningUpdateTarget
  /** Health the author stated. */
  health: PlanningHealth
  /** Risk level the author stated. */
  risk: PlanningRisk
  /** Summary. */
  summary: string
  /** Background and impact of the risk. */
  riskSummary: string
  /** Decisions made. */
  decisionSummary: string
  /** Help needed. */
  helpNeeded: string
  /** Next action. */
  nextAction: string
  /** Progress the server recorded when the update was published. */
  progress: PlanningUpdateProgressSnapshot
  /** Member ID of the author. */
  authorMemberId: string
  /** Due occurrence the update covered. */
  coveredDueAt: string
  /** When the update was published. */
  createdAt: string
  /** When the reviewer acknowledged the update. */
  acknowledgedAt?: string
}

/** Response of `GET /api/v1/planning/status-updates`, newest first. */
export type PublicPlanningStatusUpdatePage = CursorPage<PublicPlanningStatusUpdate> & {
  /** Response schema version. */
  schemaVersion: 1
  /** Planning graph revision of the read; send it as `expectedRevision` when publishing. */
  revision: number
}

/** Body of `POST /api/v1/planning/status-updates`. */
export type CreatePublicPlanningStatusUpdateRequest = {
  /** Project, Team, or Initiative the update is about; it needs an update cadence. */
  target: PlanningUpdateTarget
  /** Health. */
  health: PlanningHealth
  /** Risk level; defaults to `none`. */
  risk?: PlanningRisk
  /** Summary. */
  summary: string
  /** Background and impact of the risk. */
  riskSummary?: string
  /** Decisions made. */
  decisionSummary?: string
  /** Help needed. */
  helpNeeded?: string
  /** Next action. */
  nextAction?: string
  /**
   * Planning graph revision the client read. Omitted, the server applies the write to the latest
   * revision.
   */
  expectedRevision?: number
}

/** Response of `POST /api/v1/planning/status-updates`. */
export type PublicPlanningStatusUpdateMutation = {
  /** Response schema version. */
  schemaVersion: 1
  /** Planning graph revision after the publish. */
  revision: number
  /** The published update. */
  item: PublicPlanningStatusUpdate
}
