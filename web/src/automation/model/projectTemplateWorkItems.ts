import {
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT,
  AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS,
  WORK_ITEM_TITLE_MAX_LENGTH,
  type AutomationProjectTemplateWorkItem,
} from '@mukuroji/contracts'

/** Why a WBS outline line could not be read. */
export type ProjectTemplateWorkItemOutlineErrorReason =
  | 'format'
  | 'indent'
  | 'title'
  | 'days'
  | 'limit'
  | 'depth'

/** Result of reading a WBS outline: the Work Items, or the first problem and its line. */
export type ProjectTemplateWorkItemOutlineResult =
  | {
      /** Top-level Work Items with their children, in outline order. */
      workItems: AutomationProjectTemplateWorkItem[]
    }
  | {
      /** Reason the outline was rejected. */
      error: ProjectTemplateWorkItemOutlineErrorReason
      /** One-based line number of the first problem. */
      line: number
    }

const indentUnit = '  '

/**
 * Reads a WBS outline written one Work Item per line.
 *
 * Each line is `title | start offset | duration`, with both numbers in working days. A child is
 * indented two spaces deeper than its parent. Blank lines are ignored. The title may contain `|`
 * because the last two separators split the numbers.
 *
 * @param text - Outline text from the template editor.
 * @returns The parsed Work Items, or the first error and its line number.
 */
export function parseProjectTemplateWorkItemOutline(text: string): ProjectTemplateWorkItemOutlineResult {
  const roots: AutomationProjectTemplateWorkItem[] = []
  const stack: AutomationProjectTemplateWorkItem[] = []
  let count = 0
  const lines = text.split(/\r?\n/u)
  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = lineIndex + 1
    if (!rawLine.trim()) continue
    const indent = /^ */u.exec(rawLine)?.[0].length ?? 0
    if (indent % indentUnit.length !== 0 || rawLine[indent] === '\t') return { error: 'indent', line }
    const level = indent / indentUnit.length
    if (level > stack.length) return { error: 'indent', line }
    if (level >= AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_DEPTH_LIMIT) return { error: 'depth', line }
    const content = rawLine.trim()
    const durationSeparator = content.lastIndexOf('|')
    const offsetSeparator = durationSeparator > 0 ? content.lastIndexOf('|', durationSeparator - 1) : -1
    if (offsetSeparator < 0) return { error: 'format', line }
    const title = content.slice(0, offsetSeparator).trim()
    if (!title || [...title].length > WORK_ITEM_TITLE_MAX_LENGTH) return { error: 'title', line }
    const startOffsetWorkingDays = readWholeDays(content.slice(offsetSeparator + 1, durationSeparator), 0)
    const durationWorkingDays = readWholeDays(content.slice(durationSeparator + 1), 1)
    if (startOffsetWorkingDays === undefined || durationWorkingDays === undefined) {
      return { error: 'days', line }
    }
    count += 1
    if (count > AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_LIMIT) return { error: 'limit', line }
    const workItem: AutomationProjectTemplateWorkItem = { title, startOffsetWorkingDays, durationWorkingDays }
    stack.length = level
    const parent = stack[level - 1]
    if (parent) {
      parent.children = [...(parent.children ?? []), workItem]
    } else {
      roots.push(workItem)
    }
    stack.push(workItem)
  }
  return { workItems: roots }
}

/**
 * Writes Work Items as the outline text that {@link parseProjectTemplateWorkItemOutline} reads.
 *
 * @param workItems - Top-level Work Items with their children, or undefined for none.
 * @returns One line per Work Item, children indented two spaces per level.
 */
export function formatProjectTemplateWorkItemOutline(
  workItems: readonly AutomationProjectTemplateWorkItem[] | undefined,
): string {
  const lines: string[] = []
  const visit = (items: readonly AutomationProjectTemplateWorkItem[], level: number) => {
    for (const item of items) {
      lines.push(
        `${indentUnit.repeat(level)}${item.title} | ${item.startOffsetWorkingDays} | ${item.durationWorkingDays}`,
      )
      if (item.children) visit(item.children, level + 1)
    }
  }
  visit(workItems ?? [], 0)
  return lines.join('\n')
}

/**
 * Counts every Work Item in a WBS, including children.
 *
 * @param workItems - Top-level Work Items, or undefined for none.
 * @returns Total number of Work Items.
 */
export function countProjectTemplateWorkItems(
  workItems: readonly AutomationProjectTemplateWorkItem[] | undefined,
): number {
  return (workItems ?? []).reduce(
    (total, item) => total + 1 + countProjectTemplateWorkItems(item.children),
    0,
  )
}

/**
 * Formats a date as the viewer's local `YYYY-MM-DD` calendar date.
 *
 * @param date - Instant to format.
 * @returns Local calendar date of the instant.
 */
export function formatLocalCalendarDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Reads a whole number of working days within the template bounds.
 *
 * @param value - Raw text between separators.
 * @param minimum - Smallest accepted value.
 * @returns The number, or undefined when it is not a whole number in range.
 */
function readWholeDays(value: string, minimum: number): number | undefined {
  const text = value.trim()
  if (!/^\d+$/u.test(text)) return undefined
  const days = Number(text)
  return days >= minimum && days <= AUTOMATION_PROJECT_TEMPLATE_WORK_ITEM_MAX_DAYS ? days : undefined
}
