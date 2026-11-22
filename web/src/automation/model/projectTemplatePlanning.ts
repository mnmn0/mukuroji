import {
  AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_MAX_LAG_DAYS,
  AUTOMATION_PROJECT_TEMPLATE_MILESTONE_MARKER,
  AUTOMATION_PROJECT_TEMPLATE_PLANNING_ENTITY_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
  WORK_ITEM_TITLE_MAX_LENGTH,
  type AutomationProjectTemplateDependency,
  type AutomationProjectTemplateMilestone,
  type AutomationProjectTemplatePhase,
  type AutomationProjectTemplateWorkItem,
  type ScheduleDependencyType,
} from '@mukuroji/contracts'

/** Why a Phase / Milestone outline line could not be read. */
export type ProjectTemplatePlanningOutlineErrorReason = 'format' | 'indent' | 'title' | 'days' | 'limit'

/** Result of reading a Phase / Milestone outline. */
export type ProjectTemplatePlanningOutlineResult =
  | {
      /** Phases with their Milestones, in outline order. */
      phases: AutomationProjectTemplatePhase[]
      /** Milestones outside any Phase, in outline order. */
      milestones: AutomationProjectTemplateMilestone[]
    }
  | {
      /** Reason the outline was rejected. */
      error: ProjectTemplatePlanningOutlineErrorReason
      /** One-based line number of the first problem. */
      line: number
    }

/** Why a dependency line could not be read. */
export type ProjectTemplateDependencyLinesErrorReason = 'format' | 'reference' | 'self' | 'hierarchy' | 'duplicate' | 'limit'

/** Result of reading dependency lines. */
export type ProjectTemplateDependencyLinesResult =
  | {
      /** Dependencies in line order. */
      dependencies: AutomationProjectTemplateDependency[]
    }
  | {
      /** Reason the lines were rejected. */
      error: ProjectTemplateDependencyLinesErrorReason
      /** One-based line number of the first problem. */
      line: number
    }

/** A Planning entity a Project template's Phases and Milestones can be created under. */
export type AutomationPlanningParentOption = {
  /** Planning entity ID. */
  id: string
  /** Display title. */
  title: string
  /** Entity type: roadmap, initiative, or goal. */
  type: 'roadmap' | 'initiative' | 'goal'
  /** Team scope of the entity; absent for a Workspace entity. */
  teamId?: string
}

/** Loading state of the Planning parent candidates shown when applying a Project template. */
export type AutomationPlanningParentsState = {
  /** Candidates, once loaded. */
  parents?: AutomationPlanningParentOption[]
  /** Whether the candidates are still loading. */
  isLoading: boolean
  /** Whether loading the candidates failed. */
  failed: boolean
  /** Loads the candidates again. */
  onRetry: () => void
}

const indentUnit = '  '

/** Short dependency type codes used in the editor, keyed by code. */
const dependencyTypeByCode: Record<string, ScheduleDependencyType> = {
  FS: 'finish-to-start',
  SS: 'start-to-start',
  FF: 'finish-to-finish',
  SF: 'start-to-finish',
}

/** Editor codes keyed by dependency type. */
const dependencyCodeByType: Record<ScheduleDependencyType, string> = {
  'finish-to-start': 'FS',
  'start-to-start': 'SS',
  'finish-to-finish': 'FF',
  'start-to-finish': 'SF',
}

/**
 * Reads a Phase / Milestone outline written one entry per line.
 *
 * A Phase is `title | start offset | duration`; a Milestone starts with the marker and is
 * `◆ title | offset`, all in working days. The marker, not the number of fields, tells the two
 * apart, so any title round-trips. A Milestone indented two spaces belongs to the Phase above it;
 * an unindented one stands on its own. Blank lines are ignored.
 *
 * @param text - Outline text from the template editor.
 * @returns The parsed Phases and Milestones, or the first error and its line number.
 */
export function parseProjectTemplatePlanningOutline(text: string): ProjectTemplatePlanningOutlineResult {
  const phases: AutomationProjectTemplatePhase[] = []
  const milestones: AutomationProjectTemplateMilestone[] = []
  let currentPhase: AutomationProjectTemplatePhase | undefined
  let count = 0
  for (const [lineIndex, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = lineIndex + 1
    if (!rawLine.trim()) continue
    const indent = /^ */u.exec(rawLine)?.[0].length ?? 0
    if ((indent !== 0 && indent !== indentUnit.length) || rawLine[indent] === '\t') return { error: 'indent', line }
    const content = rawLine.trim()
    const isMilestone = content.startsWith(AUTOMATION_PROJECT_TEMPLATE_MILESTONE_MARKER)
    const segments = (isMilestone ? content.slice(AUTOMATION_PROJECT_TEMPLATE_MILESTONE_MARKER.length) : content).split('|')
    if (segments.length < (isMilestone ? 2 : 3)) return { error: 'format', line }
    const fieldCount = isMilestone ? 1 : 2
    const title = segments.slice(0, -fieldCount).join('|').trim()
    if (!title || [...title].length > WORK_ITEM_TITLE_MAX_LENGTH) return { error: 'title', line }
    count += 1
    if (count > AUTOMATION_PROJECT_TEMPLATE_PLANNING_ENTITY_LIMIT) return { error: 'limit', line }
    if (!isMilestone) {
      if (indent !== 0) return { error: 'indent', line }
      const startOffsetWorkingDays = readWholeDays(segments.at(-2) ?? '', 0)
      const durationWorkingDays = readWholeDays(segments.at(-1) ?? '', 1)
      if (startOffsetWorkingDays === undefined || durationWorkingDays === undefined) return { error: 'days', line }
      currentPhase = { title, startOffsetWorkingDays, durationWorkingDays }
      phases.push(currentPhase)
      continue
    }
    const offsetWorkingDays = readWholeDays(segments.at(-1) ?? '', 0)
    if (offsetWorkingDays === undefined) return { error: 'days', line }
    const milestone = { title, offsetWorkingDays }
    if (indent === 0) {
      milestones.push(milestone)
    } else if (currentPhase) {
      currentPhase.milestones = [...(currentPhase.milestones ?? []), milestone]
    } else {
      return { error: 'indent', line }
    }
  }
  return { phases, milestones }
}

/**
 * Writes Phases and Milestones as the text that {@link parseProjectTemplatePlanningOutline} reads.
 *
 * @param phases - Phases with their Milestones, or undefined for none.
 * @param milestones - Milestones outside any Phase, or undefined for none.
 * @returns One line per entry.
 */
export function formatProjectTemplatePlanningOutline(
  phases: readonly AutomationProjectTemplatePhase[] | undefined,
  milestones: readonly AutomationProjectTemplateMilestone[] | undefined,
): string {
  const lines: string[] = []
  const formatMilestone = (milestone: AutomationProjectTemplateMilestone) =>
    `${AUTOMATION_PROJECT_TEMPLATE_MILESTONE_MARKER} ${milestone.title} | ${milestone.offsetWorkingDays}`
  for (const phase of phases ?? []) {
    lines.push(`${phase.title} | ${phase.startOffsetWorkingDays} | ${phase.durationWorkingDays}`)
    for (const milestone of phase.milestones ?? []) lines.push(`${indentUnit}${formatMilestone(milestone)}`)
  }
  for (const milestone of milestones ?? []) lines.push(formatMilestone(milestone))
  return lines.join('\n')
}

/**
 * Lists the WBS numbers of a template outline in display order.
 *
 * @param workItems - Top-level Work Items with their children.
 * @returns WBS numbers such as `1`, `1.1`, and `2`.
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
 * Reads dependency lines written as `1.1 -> 2`, optionally followed by a type code
 * (`FS`, `SS`, `FF`, `SF`; finish-to-start by default) and a signed calendar-day lag such as `+2`.
 *
 * @param text - Dependency text from the template editor.
 * @param workItems - Parsed WBS the WBS numbers refer to.
 * @returns The dependencies, or the first error and its line number.
 */
export function parseProjectTemplateDependencyLines(
  text: string,
  workItems: readonly AutomationProjectTemplateWorkItem[],
): ProjectTemplateDependencyLinesResult {
  const wbsNumbers = new Set(listProjectTemplateWbsNumbers(workItems))
  const pairs = new Set<string>()
  const dependencies: AutomationProjectTemplateDependency[] = []
  for (const [lineIndex, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = lineIndex + 1
    if (!rawLine.trim()) continue
    const match = /^(\d+(?:\.\d+)*)\s*->\s*(\d+(?:\.\d+)*)(?:\s+(FS|SS|FF|SF))?(?:\s+([+-]?\d+))?$/iu.exec(rawLine.trim())
    if (!match) return { error: 'format', line }
    const predecessor = match[1] ?? ''
    const successor = match[2] ?? ''
    const type = dependencyTypeByCode[(match[3] ?? 'FS').toUpperCase()]
    const lagDays = Number(match[4] ?? '0')
    if (!type || !Number.isSafeInteger(lagDays) || Math.abs(lagDays) > AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_MAX_LAG_DAYS) {
      return { error: 'format', line }
    }
    if (!wbsNumbers.has(predecessor) || !wbsNumbers.has(successor)) return { error: 'reference', line }
    if (predecessor === successor) return { error: 'self', line }
    if (predecessor.startsWith(`${successor}.`) || successor.startsWith(`${predecessor}.`)) {
      return { error: 'hierarchy', line }
    }
    if (pairs.has(`${predecessor}>${successor}`) || pairs.has(`${successor}>${predecessor}`)) {
      return { error: 'duplicate', line }
    }
    pairs.add(`${predecessor}>${successor}`)
    if (dependencies.length >= AUTOMATION_PROJECT_TEMPLATE_DEPENDENCY_LIMIT) return { error: 'limit', line }
    dependencies.push({ predecessor, successor, type, lagDays })
  }
  return { dependencies }
}

/**
 * Writes dependencies as the lines that {@link parseProjectTemplateDependencyLines} reads.
 *
 * @param dependencies - Template dependencies, or undefined for none.
 * @returns One line per dependency.
 */
export function formatProjectTemplateDependencyLines(
  dependencies: readonly AutomationProjectTemplateDependency[] | undefined,
): string {
  return (dependencies ?? []).map((dependency) => {
    const lag = dependency.lagDays === 0
      ? ''
      : ` ${dependency.lagDays > 0 ? '+' : ''}${dependency.lagDays}`
    return `${dependency.predecessor} -> ${dependency.successor} ${dependencyCodeByType[dependency.type]}${lag}`
  }).join('\n')
}

/**
 * Tells whether a segment is a whole number, ignoring surrounding spaces.
 *
 * @param value - Raw segment text.
 * @returns True for digits only.
 */
function isWholeNumber(value: string) {
  return /^\d+$/u.test(value.trim())
}

/**
 * Reads a whole number of working days within the template bounds.
 *
 * @param value - Raw segment text.
 * @param minimum - Smallest accepted value.
 * @returns The number, or undefined when it is out of range.
 */
function readWholeDays(value: string, minimum: number): number | undefined {
  if (!isWholeNumber(value)) return undefined
  const days = Number(value.trim())
  return days >= minimum && days <= AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS ? days : undefined
}
