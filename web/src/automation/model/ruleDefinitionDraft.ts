import type {
  AutomationAction,
  AutomationCondition,
  AutomationConditionOperator,
  AutomationRule,
  AutomationValue,
  UpdateAutomationRuleInput,
} from '@mukuroji/contracts'

/** One choice a rule editor picker offers. */
export type AutomationRulePickerOption = {
  /** Stored identifier. */
  id: string
  /** Label shown to the administrator. */
  label: string
}

/** How the condition rows of a rule combine. */
export type AutomationRuleConditionMatch = 'all' | 'any'

/** One editable field condition. */
export type AutomationRuleConditionDraft = {
  /** Field path such as `workItem.priority`. */
  field: string
  /** Comparison operator. */
  operator: AutomationConditionOperator
  /** Comparison value as typed; ignored by `exists` and `not-exists`. */
  value: string
}

/** Fields of a Work Item an update action can set from the editor. */
export const AUTOMATION_RULE_UPDATE_FIELDS = ['workflowStatusId', 'priority', 'title', 'description'] as const

/** One Work Item field an update action can set from the editor. */
export type AutomationRuleUpdateField = (typeof AUTOMATION_RULE_UPDATE_FIELDS)[number]

/** One editable action, or a saved action the editor keeps as it is. */
export type AutomationRuleActionDraft =
  | {
    /** Assigns the Work Item. */
    type: 'assign'
    /** Member to assign. */
    memberKey: string
  }
  | {
    /** Moves the Work Item to a Project. */
    type: 'move'
    /** Target Project; empty removes the Project. */
    projectId: string
  }
  | {
    /** Sets one Work Item field. */
    type: 'update'
    /** Field to set. */
    field: AutomationRuleUpdateField
    /** New value. */
    value: string
  }
  | {
    /** Creates a Work Item from a template. */
    type: 'create'
    /** Work Item template. */
    templateId: string
  }
  | {
    /** Adds a comment. */
    type: 'comment'
    /** Comment body. */
    body: string
  }
  | {
    /** Sends a notification. */
    type: 'notify'
    /** Recipients. */
    memberKeys: string[]
    /** Notification title. */
    title: string
    /** Optional body. */
    body: string
  }
  | {
    /** Requests approval. */
    type: 'approval'
    /** Reviewers. */
    memberKeys: string[]
    /** Hours until the approval is due. */
    dueInHours: number
    /** Status set after every reviewer approves; empty keeps the status. */
    completionStatusId: string
  }
  | {
    /** Calls an outbound webhook. */
    type: 'webhook'
    /** HTTPS endpoint. */
    url: string
  }
  | {
    /** A saved action the editor cannot show field by field; it is saved unchanged. */
    type: 'saved'
    /** The saved action. */
    action: AutomationAction
  }

/** Editable state of a rule's name, conditions, and actions. */
export type AutomationRuleDraft = {
  /** Rule name. */
  name: string
  /** How the condition rows combine. */
  match: AutomationRuleConditionMatch
  /** Condition rows; empty means the rule always runs once triggered. */
  conditions: AutomationRuleConditionDraft[]
  /**
   * Saved conditions the editor cannot show as rows (nested groups, `not`, non-text values).
   * When set, the rows are not used and these conditions are saved unchanged.
   */
  savedConditions?: AutomationCondition[]
  /** Actions in execution order. */
  actions: AutomationRuleActionDraft[]
}

/** Most condition rows and actions the editor offers. */
export const AUTOMATION_RULE_DRAFT_LIMIT = 20

/** Action types an administrator can add from the editor. */
export const AUTOMATION_RULE_DRAFT_ACTION_TYPES = [
  'assign',
  'move',
  'update',
  'create',
  'comment',
  'notify',
  'approval',
  'webhook',
] as const

/** Action type an administrator can add from the editor. */
export type AutomationRuleDraftActionType = (typeof AUTOMATION_RULE_DRAFT_ACTION_TYPES)[number]

/**
 * Builds the editable state of a saved rule.
 *
 * @param rule - Saved rule.
 * @returns The draft; conditions or actions the editor cannot show are kept as saved.
 */
export function createAutomationRuleDraft(rule: AutomationRule): AutomationRuleDraft {
  const rows = readConditionRows(rule.conditions)
  return {
    name: rule.name,
    match: rows?.match ?? 'all',
    conditions: rows?.conditions ?? [],
    ...(rows ? {} : { savedConditions: structuredClone(rule.conditions) }),
    actions: rule.actions.map(createActionDraft),
  }
}

/**
 * Creates a new action of a type with empty settings.
 *
 * @param type - Action type.
 * @param ruleName - Rule name, used as a notification's default title.
 * @returns The action draft.
 */
export function createEmptyAutomationRuleActionDraft(
  type: AutomationRuleDraftActionType,
  ruleName: string,
): AutomationRuleActionDraft {
  switch (type) {
    case 'assign':
      return { type, memberKey: '' }
    case 'move':
      return { type, projectId: '' }
    case 'update':
      return { type, field: 'workflowStatusId', value: '' }
    case 'create':
      return { type, templateId: '' }
    case 'comment':
      return { type, body: '' }
    case 'notify':
      return { type, memberKeys: [], title: ruleName, body: '' }
    case 'approval':
      return { type, memberKeys: [], dueInHours: 24, completionStatusId: '' }
    case 'webhook':
      return { type, url: '' }
  }
}

/**
 * Moves one entry of a list up or down.
 *
 * @param items - List to reorder.
 * @param index - Entry to move.
 * @param offset - -1 moves it earlier, 1 later.
 * @returns A new list; the same order when the move would leave the list.
 */
export function moveAutomationRuleDraftItem<TItem>(items: readonly TItem[], index: number, offset: -1 | 1): TItem[] {
  const target = index + offset
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items]
  const next = [...items]
  const [moved] = next.splice(index, 1)
  if (moved !== undefined) next.splice(target, 0, moved)
  return next
}

/**
 * Reports whether a condition row is complete.
 *
 * @param condition - Condition row.
 * @returns Whether it names a supported field and has the value its operator needs.
 */
export function isAutomationRuleConditionDraftValid(condition: AutomationRuleConditionDraft): boolean {
  const field = condition.field.trim()
  if (!/^(event|workItem|variables)\.[A-Za-z0-9_.-]+$/.test(field)) return false
  return isExistenceOperator(condition.operator) || condition.value.trim().length > 0
}

/**
 * Reports whether an action has every setting it needs.
 *
 * @param action - Action draft.
 * @returns Whether the action can be saved.
 */
export function isAutomationRuleActionDraftValid(action: AutomationRuleActionDraft): boolean {
  switch (action.type) {
    case 'assign':
      return action.memberKey.trim().length > 0
    case 'move':
      return true
    case 'update':
      return action.field === 'description' || action.value.trim().length > 0
    case 'create':
      return action.templateId.trim().length > 0
    case 'comment':
      return action.body.trim().length > 0
    case 'notify':
      return action.memberKeys.length > 0 && action.title.trim().length > 0
    case 'approval':
      return action.memberKeys.length > 0 && Number.isInteger(action.dueInHours) && action.dueInHours >= 1
    case 'webhook':
      return isHttpsUrl(action.url.trim())
    case 'saved':
      return true
  }
}

/**
 * Reports whether a draft can be saved.
 *
 * @param draft - Rule draft.
 * @returns Whether the name, every condition row, and every action are complete.
 */
export function isAutomationRuleDraftValid(draft: AutomationRuleDraft): boolean {
  return draft.name.trim().length > 0 &&
    draft.actions.length > 0 &&
    draft.actions.length <= AUTOMATION_RULE_DRAFT_LIMIT &&
    draft.conditions.length <= AUTOMATION_RULE_DRAFT_LIMIT &&
    (draft.savedConditions !== undefined || draft.conditions.every(isAutomationRuleConditionDraftValid)) &&
    draft.actions.every(isAutomationRuleActionDraftValid)
}

/**
 * Builds the conditions a draft saves.
 *
 * @param draft - Rule draft.
 * @returns Saved conditions when the editor kept them, otherwise one group of the rows.
 */
export function createAutomationRuleDraftConditions(draft: AutomationRuleDraft): AutomationCondition[] {
  if (draft.savedConditions) return structuredClone(draft.savedConditions)
  if (draft.conditions.length === 0) return []
  const rows: AutomationCondition[] = draft.conditions.map((condition) => ({
    type: 'field',
    field: condition.field.trim(),
    operator: condition.operator,
    ...(isExistenceOperator(condition.operator) ? {} : { value: condition.value.trim() }),
  }))
  return draft.match === 'any' ? [{ type: 'any', conditions: rows }] : rows
}

/**
 * Builds the actions a draft saves.
 *
 * @param draft - Rule draft.
 * @returns Actions in execution order.
 */
export function createAutomationRuleDraftActions(draft: AutomationRuleDraft): AutomationAction[] {
  return draft.actions.map(createActionFromDraft)
}

/**
 * Builds the update request that saves a draft as the rule's next version.
 *
 * @param rule - Rule the draft was made from.
 * @param draft - Edited draft.
 * @returns Update input with the revision the editor read.
 */
export function createAutomationRuleDraftUpdate(
  rule: AutomationRule,
  draft: AutomationRuleDraft,
): UpdateAutomationRuleInput {
  return {
    expectedRevision: rule.revision,
    name: draft.name.trim(),
    conditions: createAutomationRuleDraftConditions(draft),
    actions: createAutomationRuleDraftActions(draft),
  }
}

/**
 * Reads conditions the editor can show as rows: field conditions with text values, either at the
 * top level (all must hold) or inside one `any` or `all` group.
 *
 * @param conditions - Saved conditions.
 * @returns The rows and how they combine, or undefined when the editor cannot show them.
 */
function readConditionRows(
  conditions: readonly AutomationCondition[],
): { match: AutomationRuleConditionMatch; conditions: AutomationRuleConditionDraft[] } | undefined {
  const [first] = conditions
  if (conditions.length === 1 && first && (first.type === 'any' || first.type === 'all')) {
    const rows = readFieldRows(first.conditions)
    return rows ? { match: first.type, conditions: rows } : undefined
  }
  const rows = readFieldRows(conditions)
  return rows ? { match: 'all', conditions: rows } : undefined
}

/**
 * Reads field conditions with text values as rows.
 *
 * @param conditions - Conditions of one level.
 * @returns The rows, or undefined when any condition is not such a field condition.
 */
function readFieldRows(conditions: readonly AutomationCondition[]): AutomationRuleConditionDraft[] | undefined {
  const rows: AutomationRuleConditionDraft[] = []
  for (const condition of conditions) {
    if (condition.type !== 'field') return undefined
    if (condition.value !== undefined && typeof condition.value !== 'string') return undefined
    rows.push({ field: condition.field, operator: condition.operator, value: condition.value ?? '' })
  }
  return rows
}

/**
 * Builds the draft of one saved action.
 *
 * @param action - Saved action.
 * @returns An editable draft, or the saved action kept as it is.
 */
function createActionDraft(action: AutomationAction): AutomationRuleActionDraft {
  switch (action.type) {
    case 'assign':
      return { type: 'assign', memberKey: action.assigneeMemberKey }
    case 'move':
      return { type: 'move', projectId: action.targetProjectId ?? '' }
    case 'update': {
      const entries = Object.entries(action.patch)
      const [entry] = entries
      if (entries.length === 1 && entry && isUpdateField(entry[0]) && typeof entry[1] === 'string') {
        return { type: 'update', field: entry[0], value: entry[1] }
      }
      return { type: 'saved', action: structuredClone(action) }
    }
    case 'create':
      return action.templateId && action.values === undefined
        ? { type: 'create', templateId: action.templateId }
        : { type: 'saved', action: structuredClone(action) }
    case 'comment':
      return { type: 'comment', body: action.body }
    case 'notify':
      return { type: 'notify', memberKeys: [...action.recipientMemberKeys], title: action.title, body: action.body ?? '' }
    case 'approval':
      return {
        type: 'approval',
        memberKeys: [...action.reviewerMemberKeys],
        dueInHours: action.dueInHours,
        completionStatusId: action.completionStatusId ?? '',
      }
    case 'webhook':
      return action.secretReference === undefined && action.body === undefined
        ? { type: 'webhook', url: action.url }
        : { type: 'saved', action: structuredClone(action) }
  }
}

/**
 * Builds the saved action of one draft.
 *
 * @param draft - Action draft.
 * @returns The action to save.
 */
function createActionFromDraft(draft: AutomationRuleActionDraft): AutomationAction {
  switch (draft.type) {
    case 'assign':
      return { type: 'assign', assigneeMemberKey: draft.memberKey.trim() }
    case 'move':
      return { type: 'move', targetProjectId: draft.projectId.trim() || null }
    case 'update': {
      const value: AutomationValue = draft.value.trim()
      return { type: 'update', patch: { [draft.field]: value } }
    }
    case 'create':
      return { type: 'create', templateId: draft.templateId.trim() }
    case 'comment':
      return { type: 'comment', body: draft.body.trim() }
    case 'notify':
      return {
        type: 'notify',
        recipientMemberKeys: [...draft.memberKeys],
        title: draft.title.trim(),
        ...(draft.body.trim() ? { body: draft.body.trim() } : {}),
      }
    case 'approval':
      return {
        type: 'approval',
        reviewerMemberKeys: [...draft.memberKeys],
        dueInHours: draft.dueInHours,
        ...(draft.completionStatusId ? { completionStatusId: draft.completionStatusId } : {}),
      }
    case 'webhook':
      return { type: 'webhook', url: draft.url.trim() }
    case 'saved':
      return structuredClone(draft.action)
  }
}

/**
 * Narrows a patch key to a field the editor can set.
 *
 * @param value - Patch key.
 * @returns Whether the editor offers the field.
 */
function isUpdateField(value: string): value is AutomationRuleUpdateField {
  return AUTOMATION_RULE_UPDATE_FIELDS.some((field) => field === value)
}

/**
 * Reports whether an operator compares no value.
 *
 * @param operator - Condition operator.
 * @returns Whether the operator only checks presence.
 */
function isExistenceOperator(operator: AutomationConditionOperator): boolean {
  return operator === 'exists' || operator === 'not-exists'
}

/**
 * Reports whether a string is an HTTPS URL.
 *
 * @param value - Candidate URL.
 * @returns Whether it parses with the `https:` scheme.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
