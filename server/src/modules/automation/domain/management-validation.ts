import {
  AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_MAX_LAG_DAYS,
  AUTOMATION_PROJECT_TEMPLATE_MILESTONE_MARKER,
  AUTOMATION_PROJECT_TEMPLATE_PLANNING_TITLE_MAX_UTF16_LENGTH,
  AUTOMATION_PROJECT_TEMPLATE_PLANNING_ENTITY_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
  type ApplyAutomationTemplateInput,
  type AutomationInboundWebhookLifecycleInput,
  type AutomationProjectTemplateDependency,
  type AutomationProjectTemplateMilestone,
  type AutomationProjectTemplatePhase,
  type AutomationProjectTemplateWorkItem,
  type AutomationValue,
  type CreateAutomationInboundWebhookEndpointInput,
  type CreateAutomationTemplateInput,
  type CreateRecurringWorkInput,
  type ScheduleDependencyType,
  type UpdateAutomationInboundWebhookEndpointInput,
  WORK_ITEM_TITLE_MAX_LENGTH,
} from '@mukuroji/contracts'
import {
  validateWorkflowDefinition,
  WorkflowDefinitionValidationError,
} from '../../work-item-workflow'
import { AutomationError } from './automation-error'
import { isAutomationValue } from './automation-value'
import { validateRecurringSchedule } from './recurring-schedule'
import { normalizeAutomationWorkItemSchedule } from './work-item-schedule-validation'

/** Longest routing Team ID; matches the Triage identifier boundary and canonical Team IDs. */
const TRIAGE_ROUTING_TEAM_ID_MAX_LENGTH = 200

/**
 * Validates and normalizes an untrusted Automation template definition.
 *
 * @param value - Untrusted template input.
 * @returns Normalized template creation input.
 */
export function validateCreateAutomationTemplateInput(
  value: unknown,
): CreateAutomationTemplateInput {
  const input = requireRecord(value, 'Automation template')
  assertOnlyKeys(input, ['enabled', 'kind', 'name', 'payload'], 'Automation template')
  if (input.kind !== 'work-item' && input.kind !== 'project' && input.kind !== 'workflow') {
    throw invalidInput('Automation template kind is invalid.')
  }
  const name = requireBoundedText(input.name, 'Automation template name', 160)
  const enabled = requireBoolean(input.enabled, 'Automation template enabled')
  const payload = requireRecord(input.payload, 'Automation template payload')
  switch (input.kind) {
    case 'work-item': {
      assertOnlyKeys(payload, [
        'assignedProjectId',
        'assigneeUserId',
        'customFieldValues',
        'description',
        'priority',
        'schedule',
        'teamId',
        'title',
        'workItemTypeId',
        'workflowStatusId',
      ], 'Work Item template payload')
      const title = requireBoundedText(payload.title, 'Work Item template title', WORK_ITEM_TITLE_MAX_LENGTH * 2)
      // Work Item titles are bounded in code points, so a valid template always creates a Work Item.
      if ([...title].length > WORK_ITEM_TITLE_MAX_LENGTH) {
        throw invalidInput(`Work Item template title must be ${WORK_ITEM_TITLE_MAX_LENGTH} characters or fewer.`)
      }
      const assignedProjectId = payload.assignedProjectId
      if (
        assignedProjectId !== undefined &&
        assignedProjectId !== null &&
        typeof assignedProjectId !== 'string'
      ) {
        throw invalidInput('Work Item template assigned Project ID must be a string or null.')
      }
      const assigneeUserId = readOptionalTemplateString(
        payload.assigneeUserId,
        'Work Item template assignee user ID',
      )
      const description = readOptionalTemplateString(
        payload.description,
        'Work Item template description',
      )
      const schedule = normalizeAutomationWorkItemSchedule(
        payload.schedule,
        'Work Item template schedule',
      )
      const teamId = readOptionalTemplateString(
        payload.teamId,
        'Work Item template Team ID',
      )
      const workflowStatusId = readOptionalTemplateString(
        payload.workflowStatusId,
        'Work Item template Workflow status ID',
      )
      const workItemTypeId = readOptionalTemplateString(
        payload.workItemTypeId,
        'Work Item template Work Item Type ID',
      )
      const customFieldValues = payload.customFieldValues === undefined
        ? undefined
        : validateAutomationValueRecord(
          payload.customFieldValues,
          'Work Item template custom field values',
        )
      if (
        payload.priority !== undefined &&
        payload.priority !== 'low' &&
        payload.priority !== 'medium' &&
        payload.priority !== 'high'
      ) {
        throw invalidInput('Work Item template priority is invalid.')
      }
      return {
        kind: input.kind,
        name,
        enabled,
        payload: {
          title,
          ...(assignedProjectId === undefined ? {} : { assignedProjectId }),
          ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
          ...(customFieldValues === undefined ? {} : { customFieldValues }),
          ...(description === undefined ? {} : { description }),
          ...(payload.priority === undefined ? {} : { priority: payload.priority }),
          schedule,
          ...(teamId === undefined ? {} : { teamId }),
          ...(workItemTypeId === undefined ? {} : { workItemTypeId }),
          ...(workflowStatusId === undefined ? {} : { workflowStatusId }),
        },
      }
    }
    case 'project': {
      assertOnlyKeys(
        payload,
        ['dependencies', 'milestones', 'name', 'nameEn', 'nameJa', 'phases', 'tone', 'workItems'],
        'Project template payload',
      )
      const rawName = typeof payload.name === 'string' ? payload.name.trim() : ''
      const rawNameJa = typeof payload.nameJa === 'string' ? payload.nameJa.trim() : ''
      const rawNameEn = typeof payload.nameEn === 'string' ? payload.nameEn.trim() : ''
      const primaryName = rawNameJa || rawName || rawNameEn
      if (!primaryName) throw invalidInput('Project template name is required.')
      for (const [label, candidate] of [
        ['Project template name', rawName],
        ['Project template Japanese name', rawNameJa],
        ['Project template English name', rawNameEn],
      ] as const) {
        if (candidate.length > 160) throw invalidInput(`${label} must be 160 characters or fewer.`)
        // Matches the Team and Project name rule, so a saved template can always be applied.
        if (/\p{Cc}/u.test(candidate)) throw invalidInput(`${label} must not contain control characters.`)
      }
      const tone = payload.tone ?? 'blue'
      if (tone !== 'blue' && tone !== 'purple' && tone !== 'green' && tone !== 'yellow') {
        throw invalidInput('Project template tone is invalid.')
      }
      const workItems = payload.workItems === undefined
        ? undefined
        : validateProjectTemplateWorkItems(payload.workItems)
      const dependencies = payload.dependencies === undefined
        ? []
        : validateProjectTemplateDependencies(payload.dependencies, workItems ?? [])
      const planningCounter = { count: 0 }
      const phases = payload.phases === undefined
        ? []
        : validateProjectTemplatePhases(payload.phases, planningCounter)
      const milestones = payload.milestones === undefined
        ? []
        : validateProjectTemplateMilestones(payload.milestones, planningCounter)
      return {
        kind: input.kind,
        name,
        enabled,
        payload: {
          ...(rawName ? { name: rawName } : {}),
          ...(rawNameJa ? { nameJa: rawNameJa } : {}),
          ...(rawNameEn ? { nameEn: rawNameEn } : {}),
          tone,
          ...(workItems && workItems.length > 0 ? { workItems } : {}),
          ...(dependencies.length > 0 ? { dependencies } : {}),
          ...(phases.length > 0 ? { phases } : {}),
          ...(milestones.length > 0 ? { milestones } : {}),
        },
      }
    }
    case 'workflow': {
      assertOnlyKeys(
        payload,
        ['id', 'initialStatusId', 'name', 'statuses', 'transitions'],
        'Workflow template payload',
      )
      if (Array.isArray(payload.statuses)) {
        for (const status of payload.statuses) {
          assertOnlyKeys(
            requireRecord(status, 'Workflow template status'),
            ['category', 'color', 'id', 'name', 'sortOrder'],
            'Workflow template status',
          )
        }
      }
      if (Array.isArray(payload.transitions)) {
        for (const transition of payload.transitions) {
          assertOnlyKeys(
            requireRecord(transition, 'Workflow template transition'),
            ['fromStatusId', 'toStatusId'],
            'Workflow template transition',
          )
        }
      }
      return {
        kind: input.kind,
        name,
        enabled,
        payload: validateAutomationWorkflowTemplate(payload),
      }
    }
  }
}

/**
 * Validates a Project template WBS and returns a normalized copy.
 *
 * @param value - Untrusted top-level Work Item list.
 * @returns Work Items with trimmed titles and only supported fields.
 */
function validateProjectTemplateWorkItems(value: unknown): AutomationProjectTemplateWorkItem[] {
  const counter = { count: 0 }
  return readProjectTemplateWorkItemLevel(value, 1, counter)
}

/**
 * Validates one sibling list of a Project template WBS.
 *
 * @param value - Untrusted sibling list.
 * @param depth - One-based WBS level of the siblings.
 * @param counter - Running Work Item count across the whole template.
 * @returns Normalized siblings in input order.
 */
function readProjectTemplateWorkItemLevel(
  value: unknown,
  depth: number,
  counter: { count: number },
): AutomationProjectTemplateWorkItem[] {
  if (!Array.isArray(value)) throw invalidInput('Project template Work Items must be an array.')
  if (depth > AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT) {
    throw invalidInput(
      `Project template Work Items can be nested at most ${AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT} levels deep.`,
    )
  }
  return value.map((candidate) => {
    counter.count += 1
    if (counter.count > AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT) {
      throw invalidInput(
        `Project template can hold at most ${AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT} Work Items.`,
      )
    }
    const item = requireRecord(candidate, 'Project template Work Item')
    assertOnlyKeys(
      item,
      ['children', 'durationWorkingDays', 'startOffsetWorkingDays', 'title'],
      'Project template Work Item',
    )
    const title = requireBoundedText(item.title, 'Project template Work Item title', WORK_ITEM_TITLE_MAX_LENGTH * 2)
    if ([...title].length > WORK_ITEM_TITLE_MAX_LENGTH) {
      throw invalidInput(
        `Project template Work Item title must be ${WORK_ITEM_TITLE_MAX_LENGTH} characters or fewer.`,
      )
    }
    // The template editor shows the WBS one Work Item per line, so a line break would split it.
    if (/[\r\n\u2028\u2029]/u.test(title)) {
      throw invalidInput('Project template Work Item title must not contain line breaks.')
    }
    const startOffsetWorkingDays = requireInteger(
      item.startOffsetWorkingDays,
      'Project template Work Item start offset',
      0,
      AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
    )
    const durationWorkingDays = requireInteger(
      item.durationWorkingDays,
      'Project template Work Item duration',
      1,
      AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
    )
    const children = item.children === undefined
      ? []
      : readProjectTemplateWorkItemLevel(item.children, depth + 1, counter)
    return {
      title,
      startOffsetWorkingDays,
      durationWorkingDays,
      ...(children.length > 0 ? { children } : {}),
    }
  })
}

/**
 * Lists the WBS numbers of a template outline in display order.
 *
 * @param workItems - Top-level template Work Items with their children.
 * @returns WBS numbers such as `1`, `1.1`, and `2`, in depth-first order.
 */
export function listProjectTemplateWbsNumbers(
  workItems: readonly AutomationProjectTemplateWorkItem[],
): string[] {
  const numbers: string[] = []
  const visit = (items: readonly AutomationProjectTemplateWorkItem[], prefix: string) => {
    items.forEach((item, index) => {
      const wbsNumber = `${prefix}${index + 1}`
      numbers.push(wbsNumber)
      if (item.children) visit(item.children, `${wbsNumber}.`)
    })
  }
  visit(workItems, '')
  return numbers
}

/**
 * Validates the schedule dependencies of a Project template against its WBS.
 *
 * Both ends must name Work Items of the outline by WBS number. A Work Item cannot depend on
 * itself, two dependencies cannot join the same pair, a parent and its descendant cannot depend on
 * each other, and the dependencies cannot form a cycle. Whether the dates satisfy them depends on
 * the start date and calendar, so that is checked when the template is previewed or applied.
 *
 * @param value - Untrusted dependency list.
 * @param workItems - Validated template WBS.
 * @returns Normalized dependencies in input order.
 */
function validateProjectTemplateDependencies(
  value: unknown,
  workItems: readonly AutomationProjectTemplateWorkItem[],
): AutomationProjectTemplateDependency[] {
  if (!Array.isArray(value)) throw invalidInput('Project template dependencies must be an array.')
  if (value.length > AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_LIMIT) {
    throw invalidInput(
      `Project template can hold at most ${AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_LIMIT} dependencies.`,
    )
  }
  const wbsNumbers = new Set(listProjectTemplateWbsNumbers(workItems))
  const edges = new Set<string>()
  const adjacency = new Map<string, string[]>()
  const dependencies = value.map((candidate, index) => {
    const label = `Project template dependency ${index + 1}`
    const dependency = requireRecord(candidate, label)
    assertOnlyKeys(dependency, ['lagDays', 'predecessor', 'successor', 'type'], label)
    const predecessor = requireBoundedText(dependency.predecessor, `${label} predecessor`, 32)
    const successor = requireBoundedText(dependency.successor, `${label} successor`, 32)
    for (const wbsNumber of [predecessor, successor]) {
      if (!wbsNumbers.has(wbsNumber)) {
        throw invalidInput(`${label} refers to WBS number ${wbsNumber}, which the template does not have.`)
      }
    }
    if (predecessor === successor) throw invalidInput(`${label} cannot connect a Work Item to itself.`)
    if (predecessor.startsWith(`${successor}.`) || successor.startsWith(`${predecessor}.`)) {
      throw invalidInput(`${label} cannot connect a Work Item to its own parent or child.`)
    }
    const edge = `${predecessor}\u0000${successor}`
    const reverse = `${successor}\u0000${predecessor}`
    if (edges.has(edge) || edges.has(reverse)) {
      throw invalidInput(`${label} joins the same Work Items as another dependency.`)
    }
    edges.add(edge)
    adjacency.set(predecessor, [...(adjacency.get(predecessor) ?? []), successor])
    return {
      predecessor,
      successor,
      type: readScheduleDependencyType(dependency.type, label),
      lagDays: requireInteger(
        dependency.lagDays,
        `${label} lag days`,
        -AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_MAX_LAG_DAYS,
        AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_MAX_LAG_DAYS,
      ),
    }
  })
  assertProjectTemplateDependenciesAcyclic(adjacency)
  return dependencies
}

/**
 * Rejects template dependencies that lead back to where they start.
 *
 * @param adjacency - Successor WBS numbers keyed by predecessor WBS number.
 */
function assertProjectTemplateDependenciesAcyclic(adjacency: ReadonlyMap<string, readonly string[]>) {
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (node: string) => {
    const current = state.get(node)
    if (current === 'done') return
    if (current === 'visiting') throw invalidInput('Project template dependencies must not form a cycle.')
    state.set(node, 'visiting')
    for (const next of adjacency.get(node) ?? []) visit(next)
    state.set(node, 'done')
  }
  for (const node of adjacency.keys()) visit(node)
}

/**
 * Reads a schedule dependency type.
 *
 * @param value - Untrusted type.
 * @param label - Field owner used in the error message.
 * @returns The dependency type.
 */
function readScheduleDependencyType(value: unknown, label: string): ScheduleDependencyType {
  if (
    value === 'finish-to-start' ||
    value === 'start-to-start' ||
    value === 'finish-to-finish' ||
    value === 'start-to-finish'
  ) {
    return value
  }
  throw invalidInput(`${label} type is invalid.`)
}

/**
 * Validates the Planning Phases of a Project template.
 *
 * @param value - Untrusted Phase list.
 * @param counter - Running Phase and Milestone count across the whole template.
 * @returns Normalized Phases with their Milestones.
 */
function validateProjectTemplatePhases(
  value: unknown,
  counter: { count: number },
): AutomationProjectTemplatePhase[] {
  if (!Array.isArray(value)) throw invalidInput('Project template Phases must be an array.')
  return value.map((candidate) => {
    countProjectTemplatePlanningEntity(counter)
    const phase = requireRecord(candidate, 'Project template Phase')
    assertOnlyKeys(
      phase,
      ['durationWorkingDays', 'milestones', 'startOffsetWorkingDays', 'title'],
      'Project template Phase',
    )
    const milestones = phase.milestones === undefined
      ? []
      : validateProjectTemplateMilestones(phase.milestones, counter)
    const title = readProjectTemplateLineTitle(phase.title, 'Project template Phase title')
    if (title.startsWith(AUTOMATION_PROJECT_TEMPLATE_MILESTONE_MARKER)) {
      throw invalidInput(`Project template Phase title must not start with ${AUTOMATION_PROJECT_TEMPLATE_MILESTONE_MARKER}.`)
    }
    return {
      title,
      startOffsetWorkingDays: requireInteger(
        phase.startOffsetWorkingDays,
        'Project template Phase start offset',
        0,
        AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
      ),
      durationWorkingDays: requireInteger(
        phase.durationWorkingDays,
        'Project template Phase duration',
        1,
        AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
      ),
      ...(milestones.length > 0 ? { milestones } : {}),
    }
  })
}

/**
 * Validates a list of Project template Milestones.
 *
 * @param value - Untrusted Milestone list.
 * @param counter - Running Phase and Milestone count across the whole template.
 * @returns Normalized Milestones in input order.
 */
function validateProjectTemplateMilestones(
  value: unknown,
  counter: { count: number },
): AutomationProjectTemplateMilestone[] {
  if (!Array.isArray(value)) throw invalidInput('Project template Milestones must be an array.')
  return value.map((candidate) => {
    countProjectTemplatePlanningEntity(counter)
    const milestone = requireRecord(candidate, 'Project template Milestone')
    assertOnlyKeys(milestone, ['offsetWorkingDays', 'title'], 'Project template Milestone')
    return {
      title: readProjectTemplateLineTitle(milestone.title, 'Project template Milestone title'),
      offsetWorkingDays: requireInteger(
        milestone.offsetWorkingDays,
        'Project template Milestone offset',
        0,
        AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
      ),
    }
  })
}

/**
 * Counts one Phase or Milestone against the template limit.
 *
 * @param counter - Running count, incremented in place.
 */
function countProjectTemplatePlanningEntity(counter: { count: number }) {
  counter.count += 1
  if (counter.count > AUTOMATION_PROJECT_TEMPLATE_PLANNING_ENTITY_LIMIT) {
    throw invalidInput(
      `Project template can hold at most ${AUTOMATION_PROJECT_TEMPLATE_PLANNING_ENTITY_LIMIT} Phases and Milestones.`,
    )
  }
}

/**
 * Reads a title that the template editor shows on one line.
 *
 * @param value - Untrusted title.
 * @param label - Field name used in error messages.
 * @returns The trimmed title.
 */
function readProjectTemplateLineTitle(value: unknown, label: string) {
  // Planning stores the title, so its UTF-16 limit applies as well as the editor's character limit.
  const title = requireBoundedText(value, label, AUTOMATION_PROJECT_TEMPLATE_PLANNING_TITLE_MAX_UTF16_LENGTH)
  if ([...title].length > WORK_ITEM_TITLE_MAX_LENGTH) {
    throw invalidInput(`${label} must be ${WORK_ITEM_TITLE_MAX_LENGTH} characters or fewer.`)
  }
  if (/\p{Cs}/u.test(title)) throw invalidInput(`${label} must be well-formed text.`)
  if (/[\r\n\u2028\u2029]/u.test(title)) throw invalidInput(`${label} must not contain line breaks.`)
  return title
}

/** Maps pure workflow validation failures to the stable Automation error contract. */
function validateAutomationWorkflowTemplate(value: unknown) {
  try {
    return validateWorkflowDefinition(value)
  } catch (error) {
    if (error instanceof WorkflowDefinitionValidationError) {
      throw new AutomationError(
        'invalid-input',
        error.code,
        error.message,
      )
    }
    throw error
  }
}

/**
 * Validates an untrusted Automation template application target.
 *
 * @param value - Untrusted application input.
 * @returns Normalized application input.
 */
export function validateApplyAutomationTemplateInput(
  value: unknown,
): ApplyAutomationTemplateInput {
  const input = requireRecord(value, 'Template application')
  assertOnlyKeys(input, ['target'], 'Template application')
  const target = requireRecord(input.target, 'Template application target')
  if (target.kind === 'project') {
    assertOnlyKeys(
      target,
      ['kind', 'planningParentId', 'startDate', 'teamId'],
      'Project template application target',
    )
    const startDate = target.startDate === undefined
      ? undefined
      : requireCalendarDate(target.startDate, 'Project template start date')
    const planningParentId = target.planningParentId === undefined
      ? undefined
      : requireBoundedText(target.planningParentId, 'Project template Planning parent ID', 256)
    return {
      target: {
        kind: 'project',
        teamId: requireBoundedText(target.teamId, 'Project template Team ID', 256),
        ...(startDate === undefined ? {} : { startDate }),
        ...(planningParentId === undefined ? {} : { planningParentId }),
      },
    }
  }
  if (target.kind === 'workflow') {
    assertOnlyKeys(
      target,
      ['expectedRevision', 'kind', 'scopeId', 'scopeType'],
      'Workflow template application target',
    )
    if (target.scopeType !== 'workspace' && target.scopeType !== 'team') {
      throw invalidInput('Workflow template scope type is invalid.')
    }
    return {
      target: {
        kind: 'workflow',
        scopeType: target.scopeType,
        scopeId: requireBoundedText(target.scopeId, 'Workflow template scope ID', 256),
        expectedRevision: requireInteger(
          target.expectedRevision,
          'Workflow template expected revision',
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      },
    }
  }
  throw invalidInput('Template application target kind is invalid.')
}

/**
 * Validates an untrusted inbound webhook endpoint creation request.
 *
 * @param value - Untrusted endpoint input.
 * @returns Normalized endpoint creation input.
 */
export function validateCreateAutomationInboundWebhookEndpointInput(
  value: unknown,
): CreateAutomationInboundWebhookEndpointInput {
  const input = requireRecord(value, 'Inbound webhook endpoint')
  assertOnlyKeys(input, ['name', 'purpose', 'triageRouting'], 'Inbound webhook endpoint')
  const name = requireBoundedText(input.name, 'Inbound webhook endpoint name', 160)
  const purpose = input.purpose === undefined ? 'automation' : input.purpose
  if (purpose !== 'automation' && purpose !== 'triage') {
    throw new AutomationError('invalid-input', 'AutomationInboundWebhookPurposeInvalid', 'Inbound webhook purpose must be automation or triage.')
  }
  if (purpose === 'automation') {
    if (input.triageRouting !== undefined) {
      throw new AutomationError('invalid-input', 'AutomationInboundWebhookRoutingInvalid', 'Only Triage endpoints take Triage routing.')
    }
    // Automation stays the implicit default so existing create fingerprints are unchanged.
    return { name }
  }
  const routing = requireRecord(input.triageRouting, 'Inbound webhook Triage routing')
  assertOnlyKeys(routing, ['teamId'], 'Inbound webhook Triage routing')
  return { name, purpose, triageRouting: { teamId: requireBoundedText(routing.teamId, 'Triage routing Team ID', TRIAGE_ROUTING_TEAM_ID_MAX_LENGTH) } }
}

/**
 * Validates an untrusted inbound webhook endpoint update request.
 *
 * @param value - Untrusted endpoint update input.
 * @returns Normalized endpoint update input.
 */
export function validateUpdateAutomationInboundWebhookEndpointInput(
  value: unknown,
): UpdateAutomationInboundWebhookEndpointInput {
  const input = requireRecord(value, 'Inbound webhook endpoint update')
  assertOnlyKeys(input, ['expectedRevision', 'name'], 'Inbound webhook endpoint update')
  return {
    expectedRevision: requireInteger(
      input.expectedRevision,
      'Inbound webhook endpoint expected revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    name: requireBoundedText(input.name, 'Inbound webhook endpoint name', 160),
  }
}

/**
 * Validates an untrusted inbound webhook lifecycle request.
 *
 * @param value - Untrusted lifecycle input.
 * @returns Normalized lifecycle input.
 */
export function validateAutomationInboundWebhookLifecycleInput(
  value: unknown,
): AutomationInboundWebhookLifecycleInput {
  const input = requireRecord(value, 'Inbound webhook endpoint lifecycle')
  assertOnlyKeys(input, ['expectedRevision'], 'Inbound webhook endpoint lifecycle')
  return {
    expectedRevision: requireInteger(
      input.expectedRevision,
      'Inbound webhook endpoint expected revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  }
}

/**
 * Validates and normalizes an untrusted recurring Work definition.
 *
 * @param value - Untrusted recurring input.
 * @returns Normalized recurring Work creation input.
 */
export function validateCreateRecurringWorkInput(value: unknown): CreateRecurringWorkInput {
  const input = requireRecord(value, 'Recurring Work')
  return {
    name: requireBoundedText(input.name, 'Recurring Work name', 160),
    teamId: requireBoundedText(input.teamId, 'Recurring Work Team ID', 256),
    enabled: requireBoolean(input.enabled, 'Recurring Work enabled'),
    templateId: requireBoundedText(input.templateId, 'Recurring Work template ID', 256),
    schedule: validateRecurringSchedule(input.schedule),
  }
}

/** Creates a stable invalid-input error. */
function invalidInput(message: string) {
  return new AutomationError('invalid-input', 'InvalidAutomationInput', message)
}

/** Narrows an unknown value to a record or throws a validation error. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidInput(`${label} must be an object.`)
  return value
}

/** Rejects properties outside a request's explicit allowlist. */
function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const allowed = new Set(keys)
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key))
  if (unsupported.length > 0) {
    throw invalidInput(`${label} contains unsupported fields: ${unsupported.join(', ')}.`)
  }
}

/** Reads a trimmed non-empty string within a maximum length. */
function requireBoundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidInput(`${label} is required.`)
  }
  const text = value.trim()
  if (text.length > maximum) {
    throw invalidInput(`${label} must be ${maximum} characters or fewer.`)
  }
  return text
}

/** Reads an optional template string while preserving meaningful empty values. */
function readOptionalTemplateString(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidInput(`${label} must be a string.`)
  return value
}

/**
 * Reads a real calendar date in `YYYY-MM-DD` form between 1970 and 2999, which leaves room for
 * the longest template WBS to stay within the supported schedule range.
 *
 * @param value - Untrusted date value.
 * @param label - Field name used in the error message.
 * @returns The validated date string.
 */
function requireCalendarDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw invalidInput(`${label} must be a YYYY-MM-DD date.`)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value ||
    value < '1970-01-01' ||
    value > '2999-12-31'
  ) {
    throw invalidInput(`${label} must be a real calendar date between 1970 and 2999.`)
  }
  return value
}

/** Reads a required boolean. */
function requireBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw invalidInput(`${label} must be boolean.`)
  return value
}

/** Reads a safe integer within inclusive bounds. */
function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw invalidInput(`${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

/** Validates and clones an Automation value record without type assertions. */
function validateAutomationValueRecord(value: unknown, label: string): Record<string, AutomationValue> {
  if (!isRecord(value) || !isAutomationValue(value)) {
    throw invalidInput(`${label} must be an object.`)
  }
  const result: Record<string, AutomationValue> = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (!isAutomationValue(candidate)) throw invalidInput(`${label} contains an invalid value.`)
    result[key] = structuredClone(candidate)
  }
  return result
}

/** Narrows an unknown value to a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
