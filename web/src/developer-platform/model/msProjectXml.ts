import { childElement, childElements, escapeXml, parseXmlDocument, textContent, type XmlElement } from './xmlDocument'

/** Schedule dependency between two exported Work Items, from the successor's point of view. */
export type MsProjectDependency = {
  /** Key of the predecessor task. */
  predecessorKey: string
  /** Scheduling rule. */
  type: 'finish-to-start' | 'start-to-start' | 'finish-to-finish' | 'start-to-finish'
  /** Signed lag in calendar days. */
  lagDays: number
}

/** One task to write to a MS Project XML file. */
export type MsProjectTaskInput = {
  /** Key other tasks use for dependencies. */
  key: string
  /** Task name. */
  name: string
  /** Notes. */
  notes?: string
  /** WBS number, if known. */
  wbsNumber?: string
  /** One-based outline level; tasks are listed in outline order. */
  outlineLevel: number
  /** First day, `YYYY-MM-DD`. */
  startDate?: string
  /** Last day, `YYYY-MM-DD`. */
  finishDate?: string
  /** Whether the task is completed. */
  completed: boolean
  /** Accountable owner, written as the first assignment. */
  ownerUserId: string
  /** Contributors with their planned effort in minutes. */
  contributors: Array<{ memberUserId: string; plannedEffortMinutes?: number }>
  /** Predecessors. */
  dependencies: MsProjectDependency[]
}

/** Error for a file that cannot be read as MS Project XML. */
export class MsProjectXmlError extends Error {
  /**
   * Creates the error.
   *
   * @param message - Explanation for the person importing.
   */
  constructor(message: string) {
    super(message)
    this.name = 'MsProjectXmlError'
  }
}

/** Columns of the rows read from a MS Project XML file, in table order. */
export const MS_PROJECT_IMPORT_COLUMNS = [
  'UID',
  'Name',
  'WBS',
  'OutlineLevel',
  'Owner',
  'Contributors',
  'Predecessors',
  'Schedule',
  'Notes',
] as const

/** Tenths of a minute in one working day of eight hours, MS Project's unit for lag. */
const lagUnitsPerWorkingDay = 4_800

/** Tenths of a minute in one elapsed day. */
const lagUnitsPerElapsedDay = 14_400

/** Lag formats that count elapsed rather than working time. */
const elapsedLagFormats = new Set([4, 6, 8, 10, 12, 36, 38, 40, 42, 44])

/** MS Project dependency type codes. */
const dependencyTypeCodes: Record<MsProjectDependency['type'], number> = {
  'finish-to-finish': 0,
  'finish-to-start': 1,
  'start-to-finish': 2,
  'start-to-start': 3,
}

/**
 * Reads the tasks of a MS Project XML file as import rows.
 *
 * Each task becomes one row keyed by its `UID`. The outline number names the parent, the first
 * assigned resource's e-mail address (or name) is the owner, the other assignments are
 * contributors with their work, and predecessor links become `UID TYPE +lag` entries.
 *
 * @param text - XML text saved by MS Project.
 * @returns Rows in task order.
 * @throws MsProjectXmlError when the file is not MS Project XML.
 */
export function readMsProjectXml(text: string): Array<Record<string, unknown>> {
  let project: XmlElement
  try {
    project = parseXmlDocument(text)
  } catch {
    throw new MsProjectXmlError('The file is not MS Project XML.')
  }
  if (project.name !== 'Project') throw new MsProjectXmlError('The file is not MS Project XML.')
  const resources = new Map(childElements(childElement(project, 'Resources') ?? emptyElement(), 'Resource')
    .map((resource) => [
      readText(resource, 'UID'),
      readText(resource, 'EmailAddress') || readText(resource, 'Name'),
    ]))
  const assignmentsByTask = new Map<string, Array<{ resource: string; workMinutes?: number }>>()
  for (const assignment of childElements(childElement(project, 'Assignments') ?? emptyElement(), 'Assignment')) {
    const resource = resources.get(readText(assignment, 'ResourceUID'))
    if (!resource) continue
    const taskUid = readText(assignment, 'TaskUID')
    const workMinutes = readDurationMinutes(readText(assignment, 'Work'))
    assignmentsByTask.set(taskUid, [
      ...(assignmentsByTask.get(taskUid) ?? []),
      { resource, ...(workMinutes ? { workMinutes } : {}) },
    ])
  }
  const rows: Array<Record<string, unknown>> = []
  for (const task of childElements(childElement(project, 'Tasks') ?? emptyElement(), 'Task')) {
    const uid = readText(task, 'UID')
    const outlineLevel = Number(readText(task, 'OutlineLevel') || '1')
    if (!uid || readText(task, 'IsNull') === '1' || outlineLevel === 0) continue
    const assignments = assignmentsByTask.get(uid) ?? []
    const startDate = readText(task, 'Start').slice(0, 10)
    const finishDate = readText(task, 'Finish').slice(0, 10)
    const predecessors = childElements(task, 'PredecessorLink').map((link) => {
      const type = Object.entries(dependencyTypeCodes)
        .find(([, code]) => String(code) === (readText(link, 'Type') || '1'))?.[0] ?? 'finish-to-start'
      const lag = Number(readText(link, 'LinkLag') || '0')
      const unit = elapsedLagFormats.has(Number(readText(link, 'LagFormat'))) ? lagUnitsPerElapsedDay : lagUnitsPerWorkingDay
      const lagDays = Number.isFinite(lag) ? Math.round(lag / unit) : 0
      return `${readText(link, 'PredecessorUID')} ${toTypeAbbreviation(type)}${lagDays ? ` ${lagDays > 0 ? '+' : ''}${lagDays}` : ''}`
    })
    rows.push({
      UID: uid,
      Name: readText(task, 'Name'),
      WBS: readText(task, 'OutlineNumber') || readText(task, 'WBS'),
      OutlineLevel: Number.isSafeInteger(outlineLevel) ? outlineLevel : 1,
      Owner: assignments[0]?.resource ?? '',
      Contributors: assignments.slice(1).map((assignment) =>
        `member:${assignment.resource}${assignment.workMinutes ? ` effort:${assignment.workMinutes}` : ''}`).join('; '),
      Predecessors: predecessors.join('; '),
      Schedule: readSchedule(startDate, finishDate, readText(task, 'Milestone') === '1'),
      Notes: readText(task, 'Notes'),
    })
  }
  return rows
}

/**
 * Builds a MS Project XML file.
 *
 * @param projectName - Project title.
 * @param tasks - Tasks in outline order.
 * @returns XML text.
 */
export function createMsProjectXml(projectName: string, tasks: readonly MsProjectTaskInput[]): string {
  const uidByKey = new Map(tasks.map((task, index) => [task.key, index + 1]))
  const resourceIds = new Map<string, number>()
  /** Returns the resource UID of a member, adding it on first use. */
  const resourceId = (memberUserId: string) => {
    const existing = resourceIds.get(memberUserId)
    if (existing !== undefined) return existing
    resourceIds.set(memberUserId, resourceIds.size + 1)
    return resourceIds.size
  }
  const assignments: string[] = []
  const taskXml = tasks.map((task, index) => {
    const uid = index + 1
    for (const member of [{ memberUserId: task.ownerUserId }, ...task.contributors]) {
      if (!member.memberUserId) continue
      const work = 'plannedEffortMinutes' in member && member.plannedEffortMinutes
        ? `<Work>${formatDuration(member.plannedEffortMinutes)}</Work>`
        : ''
      assignments.push(`<Assignment><UID>${assignments.length + 1}</UID><TaskUID>${uid}</TaskUID><ResourceUID>${resourceId(member.memberUserId)}</ResourceUID>${work}</Assignment>`)
    }
    const links = task.dependencies.flatMap((dependency) => {
      const predecessorUid = uidByKey.get(dependency.predecessorKey)
      if (predecessorUid === undefined) return []
      return [`<PredecessorLink><PredecessorUID>${predecessorUid}</PredecessorUID><Type>${dependencyTypeCodes[dependency.type]}</Type><LinkLag>${dependency.lagDays * lagUnitsPerElapsedDay}</LinkLag><LagFormat>8</LagFormat></PredecessorLink>`]
    })
    return [
      '<Task>',
      `<UID>${uid}</UID><ID>${uid}</ID>`,
      `<Name>${escapeXml(task.name)}</Name>`,
      task.wbsNumber ? `<WBS>${escapeXml(task.wbsNumber)}</WBS><OutlineNumber>${escapeXml(task.wbsNumber)}</OutlineNumber>` : '',
      `<OutlineLevel>${task.outlineLevel}</OutlineLevel>`,
      task.startDate ? `<Start>${task.startDate}T08:00:00</Start>` : '',
      task.finishDate ? `<Finish>${task.finishDate}T17:00:00</Finish>` : '',
      `<Milestone>0</Milestone>`,
      `<PercentComplete>${task.completed ? 100 : 0}</PercentComplete>`,
      task.notes ? `<Notes>${escapeXml(task.notes)}</Notes>` : '',
      ...links,
      '</Task>',
    ].join('')
  })
  const resourceXml = [...resourceIds].map(([member, uid]) =>
    `<Resource><UID>${uid}</UID><ID>${uid}</ID><Name>${escapeXml(member)}</Name><EmailAddress>${escapeXml(member)}</EmailAddress><Type>1</Type></Resource>`)
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Project xmlns="http://schemas.microsoft.com/project">',
    `<Name>${escapeXml(projectName)}</Name>`,
    '<SaveVersion>14</SaveVersion>',
    `<Tasks>${taskXml.join('')}</Tasks>`,
    `<Resources>${resourceXml.join('')}</Resources>`,
    `<Assignments>${assignments.join('')}</Assignments>`,
    '</Project>',
    '',
  ].join('\n')
}

/**
 * Builds an import schedule from task dates.
 *
 * @param startDate - First day, if any.
 * @param finishDate - Last day, if any.
 * @param milestone - Whether the task is a milestone.
 * @returns A due-date or date-range schedule, or an unscheduled one without dates.
 */
function readSchedule(startDate: string, finishDate: string, milestone: boolean) {
  if (!isIsoDate(finishDate)) return { mode: 'unscheduled' }
  if (milestone || !isIsoDate(startDate) || startDate === finishDate) return { mode: 'due-date', dueDate: finishDate }
  return { mode: 'date-range', startDate, endDate: finishDate }
}

/**
 * Converts an ISO 8601 duration such as `PT8H30M0S` to minutes.
 *
 * @param value - Duration text.
 * @returns Whole minutes, or undefined when the text is not a duration.
 */
function readDurationMinutes(value: string) {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/u.exec(value)
  if (!match) return undefined
  const minutes = Math.round(Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) + Number(match[3] ?? 0) / 60)
  return minutes > 0 ? minutes : undefined
}

/**
 * Writes minutes as an ISO 8601 duration.
 *
 * @param minutes - Whole minutes.
 * @returns Duration text such as `PT2H30M0S`.
 */
function formatDuration(minutes: number) {
  return `PT${Math.floor(minutes / 60)}H${minutes % 60}M0S`
}

/**
 * Abbreviates a dependency type.
 *
 * @param type - Canonical type.
 * @returns `FS`, `SS`, `FF`, or `SF`.
 */
function toTypeAbbreviation(type: string) {
  if (type === 'start-to-start') return 'SS'
  if (type === 'finish-to-finish') return 'FF'
  if (type === 'start-to-finish') return 'SF'
  return 'FS'
}

/**
 * Reads the text of a child element.
 *
 * @param element - Parent element.
 * @param name - Child name.
 * @returns Trimmed text, empty when missing.
 */
function readText(element: XmlElement, name: string) {
  return textContent(childElement(element, name)).trim()
}

/**
 * Checks for `YYYY-MM-DD` text.
 *
 * @param value - Candidate.
 * @returns Whether it is a date.
 */
function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
}

/**
 * Creates an element with no content, used when an optional section is missing.
 *
 * @returns An empty element.
 */
function emptyElement(): XmlElement {
  return { name: '', attributes: {}, children: [] }
}
