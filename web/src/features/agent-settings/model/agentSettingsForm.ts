import {
  AGENT_RUN_MAX_LEASE_MINUTES,
  AGENT_RUN_MIN_LEASE_MINUTES,
  AGENT_SETTINGS_BRIEF_MAX_BYTES,
  AGENT_SETTINGS_BRIEFS_MAX_TOTAL_BYTES,
  AGENT_SETTINGS_MAX_PROJECT_BRIEFS,
  AGENT_SETTINGS_MAX_READY_STATUSES,
  type AgentSettings,
  type CustomFieldType,
  type UpdateAgentSettingsRequest,
  type WorkflowDefinition,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'

/** Custom field types whose values are strings or string lists, which can hold acceptance criteria. */
const acceptanceCriteriaFieldTypes: ReadonlySet<CustomFieldType> = new Set<CustomFieldType>([
  'text',
  'select',
  'multi-select',
])

/** Editable values of the Agent settings form, kept as the operator typed them. */
export type AgentSettingsDraft = {
  /** Lease length as typed; validated before a save. */
  leaseMinutes: string
  /** Whether another instance of the same assignee may take over a stalled run. */
  allowTakeoverAfterLeaseExpiry: boolean
  /** Workflow status IDs agents may start from; empty means any backlog or unstarted status. */
  readyStatusIds: string[]
  /** Whether only Work Items with acceptance criteria are ready for agents. */
  requireAcceptanceCriteria: boolean
  /** Custom field that holds acceptance criteria; empty means none. */
  acceptanceCriteriaFieldId: string
  /** Team brief in Markdown; blank means none. */
  brief: string
  /** Project briefs in Markdown keyed by Project ID; blank entries are not saved. */
  projectBriefs: Record<string, string>
  /** Whether failed runs are filed to Triage. */
  fileFailedRunsToTriage: boolean
  /** Whether stalled runs are filed to Triage. */
  fileStalledRunsToTriage: boolean
}

/** Result of checking a draft against the limits the server enforces. */
export type AgentSettingsDraftValidation = {
  /** Whether the lease is an integer within the allowed range. */
  leaseMinutesValid: boolean
  /** UTF-8 size of the Team brief. */
  briefBytes: number
  /** Whether the Team brief exceeds the per-brief limit. */
  briefOverLimit: boolean
  /** Project IDs whose brief exceeds the per-brief limit. */
  overLimitProjectIds: string[]
  /** Number of Project briefs that would be saved. */
  projectBriefCount: number
  /** Whether more Project briefs would be saved than allowed. */
  tooManyProjectBriefs: boolean
  /** Combined UTF-8 size of every brief that would be saved. */
  totalBytes: number
  /** Whether the combined size exceeds the limit. */
  totalOverLimit: boolean
  /** Whether more ready statuses are selected than allowed. */
  tooManyReadyStatuses: boolean
  /** Whether the draft may be saved. */
  valid: boolean
}

/** One workflow status an operator may mark as ready for agents. */
export type AgentReadyStatusOption = {
  /** Workflow status ID. */
  id: string
  /** Status name, or the ID when the status no longer exists. */
  name: string
  /** Name of the workflow that owns the status, when the Team uses several workflows. */
  workflowName?: string
  /** Whether the saved ID is no longer a backlog or unstarted status of the Team. */
  missing: boolean
}

/** One custom field that may hold acceptance criteria. */
export type AgentAcceptanceCriteriaFieldOption = {
  /** Custom field ID. */
  id: string
  /** Field name, or the ID when the field no longer exists. */
  name: string
  /** Whether the saved ID is no longer a string or string-list field of the Team. */
  missing: boolean
}

/** One Project that can carry its own agent brief. */
export type AgentProjectBriefTarget = {
  /** Project ID. */
  projectId: string
  /** Project name, when the Workspace directory lists the Project. */
  name?: string
}

/** Project as listed in the Workspace directory. */
export type AgentSettingsProject = {
  /** Project ID. */
  id: string
  /** Project name. */
  name: string
}

/**
 * Creates the form values for loaded settings.
 *
 * @param settings - Settings as the server returned them.
 * @returns Draft with every value of the settings.
 */
export function createAgentSettingsDraft(settings: AgentSettings): AgentSettingsDraft {
  return {
    leaseMinutes: String(settings.leaseMinutes),
    allowTakeoverAfterLeaseExpiry: settings.allowTakeoverAfterLeaseExpiry,
    readyStatusIds: [...settings.readyStatusIds],
    requireAcceptanceCriteria: settings.requireAcceptanceCriteria,
    acceptanceCriteriaFieldId: settings.acceptanceCriteriaFieldId ?? '',
    brief: settings.brief ?? '',
    projectBriefs: { ...settings.projectBriefs },
    fileFailedRunsToTriage: settings.fileFailedRunsToTriage,
    fileStalledRunsToTriage: settings.fileStalledRunsToTriage,
  }
}

/**
 * Measures text the way the server limits briefs.
 *
 * @param text - Text to measure.
 * @returns UTF-8 size in bytes.
 */
export function measureUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Checks a draft against the limits the server enforces, so an invalid save is never sent.
 *
 * Only the briefs the operator can see are counted; the server checks the combined limit again
 * with the briefs of Projects the operator cannot view.
 *
 * @param draft - Form values.
 * @returns Validation result with sizes for counters.
 */
export function validateAgentSettingsDraft(draft: AgentSettingsDraft): AgentSettingsDraftValidation {
  const leaseMinutes = readLeaseMinutes(draft.leaseMinutes)
  const briefBytes = measureUtf8Bytes(draft.brief)
  const savedProjectBriefs = Object.entries(draft.projectBriefs).filter(([, brief]) => !isBlank(brief))
  const overLimitProjectIds = Object.entries(draft.projectBriefs)
    .filter(([, brief]) => measureUtf8Bytes(brief) > AGENT_SETTINGS_BRIEF_MAX_BYTES)
    .map(([projectId]) => projectId)
  const totalBytes = (isBlank(draft.brief) ? 0 : briefBytes) +
    savedProjectBriefs.reduce((total, [, brief]) => total + measureUtf8Bytes(brief), 0)
  const briefOverLimit = briefBytes > AGENT_SETTINGS_BRIEF_MAX_BYTES
  const tooManyProjectBriefs = savedProjectBriefs.length > AGENT_SETTINGS_MAX_PROJECT_BRIEFS
  const totalOverLimit = totalBytes > AGENT_SETTINGS_BRIEFS_MAX_TOTAL_BYTES
  const tooManyReadyStatuses = draft.readyStatusIds.length > AGENT_SETTINGS_MAX_READY_STATUSES
  const leaseMinutesValid = leaseMinutes !== undefined
  return {
    leaseMinutesValid,
    briefBytes,
    briefOverLimit,
    overLimitProjectIds,
    projectBriefCount: savedProjectBriefs.length,
    tooManyProjectBriefs,
    totalBytes,
    totalOverLimit,
    tooManyReadyStatuses,
    valid: leaseMinutesValid && !briefOverLimit && overLimitProjectIds.length === 0 &&
      !tooManyProjectBriefs && !totalOverLimit && !tooManyReadyStatuses,
  }
}

/**
 * Builds the full-replacement request for a draft. Blank briefs and an empty field selection are
 * omitted, which clears them on the server.
 *
 * @param draft - Form values; the lease must be valid.
 * @param expectedRevision - Revision the draft was edited from.
 * @returns Request body, or undefined when the lease is not valid.
 */
export function createUpdateAgentSettingsRequest(
  draft: AgentSettingsDraft,
  expectedRevision: number,
): UpdateAgentSettingsRequest | undefined {
  const leaseMinutes = readLeaseMinutes(draft.leaseMinutes)
  if (leaseMinutes === undefined) return undefined
  const projectBriefs = Object.fromEntries(
    Object.entries(draft.projectBriefs).filter(([, brief]) => !isBlank(brief)),
  )
  return {
    expectedRevision,
    leaseMinutes,
    allowTakeoverAfterLeaseExpiry: draft.allowTakeoverAfterLeaseExpiry,
    readyStatusIds: [...new Set(draft.readyStatusIds)],
    requireAcceptanceCriteria: draft.requireAcceptanceCriteria,
    ...(draft.acceptanceCriteriaFieldId === '' ? {} : { acceptanceCriteriaFieldId: draft.acceptanceCriteriaFieldId }),
    ...(isBlank(draft.brief) ? {} : { brief: draft.brief }),
    projectBriefs,
    fileFailedRunsToTriage: draft.fileFailedRunsToTriage,
    fileStalledRunsToTriage: draft.fileStalledRunsToTriage,
  }
}

/**
 * Returns whether a draft would save something different from the loaded settings.
 *
 * @param settings - Loaded settings.
 * @param draft - Form values.
 * @returns Whether the draft differs in a saved value.
 */
export function isAgentSettingsDraftChanged(settings: AgentSettings, draft: AgentSettingsDraft): boolean {
  return createDraftComparisonKey(draft) !== createDraftComparisonKey(createAgentSettingsDraft(settings))
}

/**
 * Adds or removes one ready status, keeping the order of the other selections.
 *
 * @param readyStatusIds - Current selection.
 * @param statusId - Status to toggle.
 * @param selected - Whether the status should be selected.
 * @returns New selection.
 */
export function toggleAgentReadyStatus(
  readyStatusIds: readonly string[],
  statusId: string,
  selected: boolean,
): string[] {
  const others = readyStatusIds.filter((id) => id !== statusId)
  return selected ? [...others, statusId] : others
}

/**
 * Lists the backlog and unstarted statuses of every workflow of a Team, followed by saved IDs that
 * are no longer such a status, so a save never drops them silently.
 *
 * @param configuration - Team's resolved Work Item configuration, if loaded.
 * @param selectedIds - Saved or selected status IDs.
 * @returns Status options in workflow order.
 */
export function listAgentReadyStatusOptions(
  configuration: WorkItemConfiguration | undefined,
  selectedIds: readonly string[],
): AgentReadyStatusOption[] {
  const workflows = configuration ? listWorkflows(configuration) : []
  const options = new Map<string, AgentReadyStatusOption>()
  for (const workflow of workflows) {
    const statuses = [...workflow.statuses]
      .filter((status) => status.category === 'backlog' || status.category === 'unstarted')
      .sort((left, right) => left.sortOrder - right.sortOrder)
    for (const status of statuses) {
      if (options.has(status.id)) continue
      options.set(status.id, {
        id: status.id,
        name: status.name,
        ...(workflows.length > 1 ? { workflowName: workflow.name } : {}),
        missing: false,
      })
    }
  }
  for (const id of selectedIds) {
    if (!options.has(id)) options.set(id, { id, name: id, missing: true })
  }
  return [...options.values()]
}

/**
 * Lists the custom fields that may hold acceptance criteria, followed by the saved field when it no
 * longer qualifies, so a save never drops it silently.
 *
 * @param configuration - Team's resolved Work Item configuration, if loaded.
 * @param selectedId - Saved or selected field ID; empty means none.
 * @returns Field options in display order.
 */
export function listAgentAcceptanceCriteriaFieldOptions(
  configuration: WorkItemConfiguration | undefined,
  selectedId: string,
): AgentAcceptanceCriteriaFieldOption[] {
  const options: AgentAcceptanceCriteriaFieldOption[] = [...(configuration?.customFields ?? [])]
    .filter((field) => acceptanceCriteriaFieldTypes.has(field.type))
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((field) => ({ id: field.id, name: field.name, missing: false }))
  if (selectedId !== '' && !options.some((option) => option.id === selectedId)) {
    options.push({ id: selectedId, name: selectedId, missing: true })
  }
  return options
}

/**
 * Lists the Projects that can carry a brief: the Team's Projects from the Workspace directory, then
 * Projects that already have a brief but are not listed there.
 *
 * @param projects - Team's Projects from the Workspace directory.
 * @param projectBriefs - Briefs from the loaded settings.
 * @returns Brief targets in directory order.
 */
export function listAgentProjectBriefTargets(
  projects: readonly AgentSettingsProject[],
  projectBriefs: Readonly<Record<string, string>>,
): AgentProjectBriefTarget[] {
  const targets: AgentProjectBriefTarget[] = []
  const seen = new Set<string>()
  for (const project of projects) {
    if (seen.has(project.id)) continue
    seen.add(project.id)
    targets.push({ projectId: project.id, name: project.name })
  }
  for (const projectId of Object.keys(projectBriefs)) {
    if (!seen.has(projectId)) targets.push({ projectId })
  }
  return targets
}

/**
 * Reads the typed lease length.
 *
 * @param value - Lease as typed.
 * @returns Lease minutes, or undefined when it is not an integer within the allowed range.
 */
function readLeaseMinutes(value: string): number | undefined {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const minutes = Number(trimmed)
  return Number.isSafeInteger(minutes) &&
    minutes >= AGENT_RUN_MIN_LEASE_MINUTES &&
    minutes <= AGENT_RUN_MAX_LEASE_MINUTES
    ? minutes
    : undefined
}

/**
 * Returns whether a brief has no visible content, which the server stores as no brief.
 *
 * @param text - Brief text.
 * @returns Whether the text is empty or whitespace.
 */
function isBlank(text: string): boolean {
  return text.trim() === ''
}

/**
 * Lists every workflow of a configuration once.
 *
 * @param configuration - Resolved Work Item configuration.
 * @returns The primary workflow followed by additional ones.
 */
function listWorkflows(configuration: WorkItemConfiguration): WorkflowDefinition[] {
  const workflows = [configuration.workflow, ...(configuration.workflows ?? [])]
  return workflows.filter((workflow, index) => workflows.findIndex((candidate) => candidate.id === workflow.id) === index)
}

/**
 * Builds a value that is equal for drafts that would save the same settings.
 *
 * @param draft - Form values.
 * @returns Comparison key.
 */
function createDraftComparisonKey(draft: AgentSettingsDraft): string {
  return JSON.stringify([
    draft.leaseMinutes.trim(),
    draft.allowTakeoverAfterLeaseExpiry,
    [...new Set(draft.readyStatusIds)].sort(),
    draft.requireAcceptanceCriteria,
    draft.fileFailedRunsToTriage,
    draft.fileStalledRunsToTriage,
    draft.acceptanceCriteriaFieldId,
    isBlank(draft.brief) ? '' : draft.brief,
    Object.entries(draft.projectBriefs)
      .filter(([, brief]) => !isBlank(brief))
      .sort(([left], [right]) => left.localeCompare(right)),
  ])
}
