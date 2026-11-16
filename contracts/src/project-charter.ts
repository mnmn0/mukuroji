/** Lifecycle states a Project moves through from proposal to archive. */
export type ProjectLifecycleState =
  | 'proposed'
  | 'approved'
  | 'active'
  | 'on-hold'
  | 'closed'
  | 'archived'

/** Every Project lifecycle state in display order. */
export const PROJECT_LIFECYCLE_STATES: readonly ProjectLifecycleState[] = [
  'proposed',
  'approved',
  'active',
  'on-hold',
  'closed',
  'archived',
]

/** Lifecycle state assumed for Projects stored before the charter existed. */
export const DEFAULT_PROJECT_LIFECYCLE_STATE: ProjectLifecycleState = 'active'

/** Lifecycle states that a newly created Project may start in. */
export const PROJECT_INITIAL_LIFECYCLE_STATES: readonly ProjectLifecycleState[] = [
  'proposed',
  'approved',
  'active',
]

/**
 * Allowed lifecycle transitions through the lifecycle endpoint.
 *
 * `archived` is reached only through the existing Project archive operation, which also
 * releases Planning scope, so it is not a target here even though `closed` leads to it.
 */
export const PROJECT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ProjectLifecycleState, readonly ProjectLifecycleState[]>
> = {
  proposed: ['approved', 'closed'],
  approved: ['active', 'on-hold', 'closed'],
  active: ['on-hold', 'closed'],
  'on-hold': ['active', 'closed'],
  closed: ['active'],
  archived: [],
}

/** Lifecycle states in which new Work Items cannot be created in the Project. */
export const PROJECT_LIFECYCLE_STATES_REJECTING_NEW_WORK_ITEMS: readonly ProjectLifecycleState[] = [
  'closed',
  'archived',
]

/** Maximum length of a Project code. */
export const PROJECT_CHARTER_CODE_MAX_LENGTH = 32
/** Maximum length of the description and purpose texts. */
export const PROJECT_CHARTER_TEXT_MAX_LENGTH = 2_000
/** Maximum number of classification tags. */
export const PROJECT_CHARTER_TAGS_MAX_ITEMS = 20
/** Maximum length of one classification tag. */
export const PROJECT_CHARTER_TAG_MAX_LENGTH = 40
/**
 * Matches the separators of the comma-separated tag input. A tag cannot contain one, so the
 * stored list and its comma-separated form always convert back and forth without loss.
 */
export const PROJECT_CHARTER_TAG_SEPARATOR_PATTERN = /[,，、]/u
/** Maximum number of related repository URLs. */
export const PROJECT_CHARTER_REPOSITORY_URLS_MAX_ITEMS = 10
/** Maximum length of one related repository URL. */
export const PROJECT_CHARTER_REPOSITORY_URL_MAX_LENGTH = 500

/** Pattern of a normalized (upper-case) Project code. */
export const PROJECT_CHARTER_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/u

/** One Workspace member referenced by the charter, with a display snapshot. */
export type ProjectCharterPerson = {
  /** Workspace member key of the person. */
  userId: string
  /** Name or email captured when the charter was saved. */
  displayName: string
}

/** Descriptive charter of one Project. Every field is optional for legacy Projects. */
export type ProjectCharter = {
  /** Workspace-unique Project code, normalized to upper case. */
  code?: string
  /** What the Project delivers. */
  description?: string
  /** Why the Project exists. */
  purpose?: string
  /** Accountable Project manager. */
  owner?: ProjectCharterPerson
  /** Sponsor who approved or funds the Project. */
  sponsor?: ProjectCharterPerson
  /** Planned start date in `YYYY-MM-DD`. */
  plannedStartDate?: string
  /** Planned end date in `YYYY-MM-DD`, never before the start date. */
  plannedEndDate?: string
  /** Classification tags in the order the user entered them. */
  tags: string[]
  /** Related source repository HTTPS URLs. */
  repositoryUrls: string[]
}

/** Charter fields shown in the Project directory. */
export type ProjectCharterSummary = Pick<
  ProjectCharter,
  'code' | 'owner' | 'plannedStartDate' | 'plannedEndDate'
>

/** Charter and lifecycle of one Team-owned Project. */
export type ProjectCharterState = {
  /** Team that owns the Project. */
  teamId: string
  /** Project identifier. */
  projectId: string
  /** Current lifecycle state. */
  lifecycleState: ProjectLifecycleState
  /** Current charter. */
  charter: ProjectCharter
  /** Compare-and-swap revision shared by charter and lifecycle changes. */
  revision: number
  /** ISO 8601 timestamp of the last charter or lifecycle change. */
  updatedAt?: string
  /** What the requesting member may do, decided by the server from the effective permissions. */
  viewer?: ProjectCharterViewerCapabilities
}

/** Charter actions the requesting member may take. */
export type ProjectCharterViewerCapabilities = {
  /** Whether the member may edit the charter and move the lifecycle. */
  canEdit: boolean
  /** Whether the member may approve or reject a proposed Project. */
  canDecideProposal: boolean
}

/** Complete replacement of a Project charter. People are referenced by member key. */
export type UpdateProjectCharterInput = {
  /** Revision read before constructing this update. */
  expectedRevision: number
  /** Next charter. Omitted optional fields are cleared. */
  charter: {
    /** Workspace-unique Project code. */
    code?: string
    /** What the Project delivers. */
    description?: string
    /** Why the Project exists. */
    purpose?: string
    /** Member key of the accountable Project manager. */
    ownerUserId?: string
    /** Member key of the sponsor. */
    sponsorUserId?: string
    /** Planned start date in `YYYY-MM-DD`. */
    plannedStartDate?: string
    /** Planned end date in `YYYY-MM-DD`. */
    plannedEndDate?: string
    /** Classification tags. */
    tags?: string[]
    /** Related repository HTTPS URLs. */
    repositoryUrls?: string[]
  }
}

/** Request that moves a Project to another lifecycle state. */
export type TransitionProjectLifecycleInput = {
  /** Revision read before constructing this transition. */
  expectedRevision: number
  /** Target lifecycle state. */
  state: ProjectLifecycleState
}

/**
 * Checks whether a value is a known Project lifecycle state.
 *
 * @param value - Untrusted candidate value.
 * @returns Whether the value names a lifecycle state.
 */
export function isProjectLifecycleState(value: unknown): value is ProjectLifecycleState {
  return typeof value === 'string' &&
    (PROJECT_LIFECYCLE_STATES as readonly string[]).includes(value)
}

/**
 * Checks whether the lifecycle endpoint may move a Project between two states.
 *
 * @param from - Current lifecycle state.
 * @param to - Requested lifecycle state.
 * @returns Whether the transition is allowed.
 */
export function canTransitionProjectLifecycle(
  from: ProjectLifecycleState,
  to: ProjectLifecycleState,
): boolean {
  return PROJECT_LIFECYCLE_TRANSITIONS[from].includes(to)
}

/**
 * Checks whether a Project in the given state accepts newly created Work Items.
 *
 * @param state - Current lifecycle state.
 * @returns Whether new Work Items may be created.
 */
export function projectLifecycleAcceptsNewWorkItems(state: ProjectLifecycleState): boolean {
  return !PROJECT_LIFECYCLE_STATES_REJECTING_NEW_WORK_ITEMS.includes(state)
}
