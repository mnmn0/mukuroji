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
  /** Whether the task is a milestone on its finish date. */
  milestone?: boolean
  /** Whether the task is completed. */
  completed: boolean
  /** Accountable owner, written as the first assignment. */
  ownerUserId: string
  /**
   * Contributors. A member is also written as an assignment; every contributor, including a
   * role without a member, is kept in a task text field that import reads back.
   */
  contributors: Array<{
    /** User ID written as the Resource. */
    memberUserId?: string
    /** Job role of the contribution. */
    jobRoleId?: string
    /** Planned effort in minutes, written as the assignment work. */
    plannedEffortMinutes?: number
    /** Contribution status. */
    status?: string
  }>
  /** Predecessors. */
  dependencies: MsProjectDependency[]
  /** Relations to other tasks without parent and child, kept in a task text field. */
  relations?: Array<{
    /** Relation type, such as `blocks`. */
    type: string
    /** Key of the related task. */
    key: string
  }>
  /** Acceptance criteria, kept in a task text field. */
  acceptanceCriteria?: Array<{
    /** Criterion text. */
    text: string
    /** Whether the criterion is met. */
    satisfied: boolean
  }>
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
  'Relations',
  'AcceptanceCriteria',
  'Schedule',
  'Notes',
] as const

/** Tenths of a minute in one working day of eight hours, MS Project's unit for lag. */
const lagUnitsPerWorkingDay = 4_800

/** Tenths of a minute in one elapsed day. */
const lagUnitsPerElapsedDay = 14_400

/**
 * Task text fields that keep, as JSON, what MS Project cannot hold itself. Each has an alias, so a
 * file saved again by MS Project still names it.
 */
const storedFields = {
  /** Contributors, with the roles and statuses that assignments cannot hold. */
  contributors: { fieldId: '188743731', fieldName: 'Text1', alias: 'mukuroji contributors' },
  /** Relations other than parent and child, which are not schedule links. */
  relations: { fieldId: '188743734', fieldName: 'Text2', alias: 'mukuroji relations' },
  /** Acceptance criteria and whether each is met. */
  acceptanceCriteria: { fieldId: '188743737', fieldName: 'Text3', alias: 'mukuroji acceptance criteria' },
} as const

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
 * contributors (an array of `{ memberUserId, plannedEffortMinutes }`) with their work, and
 * predecessor links become `UID TYPE +lag` entries. Contributors, relations (keyed by task `UID`),
 * and acceptance criteria that mukuroji kept in task text fields are read back from them.
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
  // Fields written by mukuroji are found by alias, since MS Project may renumber them.
  const fieldAttributes = childElements(childElement(project, 'ExtendedAttributes') ?? emptyElement(), 'ExtendedAttribute')
  /** Returns the field ID that the file gives a stored field, if it has one. */
  const fieldIdInFile = (alias: string) => {
    const attribute = fieldAttributes.find((entry) => readText(entry, 'Alias') === alias)
    return attribute ? readText(attribute, 'FieldID') : undefined
  }
  const contributorsFieldId = fieldIdInFile(storedFields.contributors.alias)
  const relationsFieldId = fieldIdInFile(storedFields.relations.alias)
  const acceptanceCriteriaFieldId = fieldIdInFile(storedFields.acceptanceCriteria.alias)
  const assignmentsByTask = new Map<string, Array<{ resource: string; workMinutes?: number }>>()
  for (const assignment of childElements(childElement(project, 'Assignments') ?? emptyElement(), 'Assignment')) {
    const resource = resources.get(readText(assignment, 'ResourceUID'))
    if (!resource) continue
    const taskUid = readText(assignment, 'TaskUID')
    const workMinutes = readDurationMinutes(readText(assignment, 'Work'))
    let taskAssignments = assignmentsByTask.get(taskUid)
    if (!taskAssignments) {
      taskAssignments = []
      assignmentsByTask.set(taskUid, taskAssignments)
    }
    taskAssignments.push({ resource, ...(workMinutes ? { workMinutes } : {}) })
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
      // An array keeps a resource name with spaces as one member.
      Contributors: readStoredArray(task, contributorsFieldId) ?? assignments.slice(1).map((assignment) => ({
        memberUserId: assignment.resource,
        ...(assignment.workMinutes ? { plannedEffortMinutes: assignment.workMinutes } : {}),
      })),
      Predecessors: predecessors.join('; '),
      Relations: readStoredArray(task, relationsFieldId) ?? '',
      AcceptanceCriteria: readStoredArray(task, acceptanceCriteriaFieldId) ?? '',
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
      `<Milestone>${task.milestone ? 1 : 0}</Milestone>`,
      `<PercentComplete>${task.completed ? 100 : 0}</PercentComplete>`,
      task.notes ? `<Notes>${escapeXml(task.notes)}</Notes>` : '',
      writeStoredField(storedFields.contributors.fieldId, task.contributors),
      // Relations name tasks by UID, the row key that import reads.
      writeStoredField(storedFields.relations.fieldId, (task.relations ?? []).flatMap((relation) => {
        const relatedUid = uidByKey.get(relation.key)
        return relatedUid === undefined ? [] : [{ type: relation.type, key: String(relatedUid) }]
      })),
      writeStoredField(storedFields.acceptanceCriteria.fieldId, task.acceptanceCriteria ?? []),
      ...links,
      '</Task>',
    ].join('')
  })
  const resourceXml = [...resourceIds].map(([member, uid]) =>
    `<Resource><UID>${uid}</UID><ID>${uid}</ID><Name>${escapeXml(member)}</Name><Type>1</Type><EmailAddress>${escapeXml(member)}</EmailAddress></Resource>`)
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Project xmlns="http://schemas.microsoft.com/project">',
    '<SaveVersion>14</SaveVersion>',
    `<Name>${escapeXml(projectName)}</Name>`,
    `<ExtendedAttributes>${Object.values(storedFields).map((field) =>
      `<ExtendedAttribute><FieldID>${field.fieldId}</FieldID><FieldName>${field.fieldName}</FieldName><Alias>${field.alias}</Alias></ExtendedAttribute>`).join('')}</ExtendedAttributes>`,
    `<Tasks>${taskXml.join('')}</Tasks>`,
    `<Resources>${resourceXml.join('')}</Resources>`,
    `<Assignments>${assignments.join('')}</Assignments>`,
    '</Project>',
    '',
  ].join('\n')
}

/**
 * Writes a task text field that keeps a list as JSON.
 *
 * @param fieldId - Field ID of the text field.
 * @param entries - Entries to keep.
 * @returns The task's ExtendedAttribute, or nothing for an empty list.
 */
function writeStoredField(fieldId: string, entries: readonly unknown[]) {
  if (entries.length === 0) return ''
  return `<ExtendedAttribute><FieldID>${fieldId}</FieldID><Value>${escapeXml(JSON.stringify(entries))}</Value></ExtendedAttribute>`
}

/**
 * Reads a list that mukuroji kept as JSON in a task text field.
 *
 * @param task - Task XML.
 * @param fieldId - Field ID that the file gives the field, if any.
 * @returns The entries as written, or undefined when the task has none or the value is not a
 *   JSON array; import validates each entry.
 */
function readStoredArray(task: XmlElement, fieldId: string | undefined): unknown[] | undefined {
  if (!fieldId) return undefined
  const attribute = childElements(task, 'ExtendedAttribute').find((entry) => readText(entry, 'FieldID') === fieldId)
  if (!attribute) return undefined
  try {
    const value: unknown = JSON.parse(readText(attribute, 'Value'))
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Builds an import schedule from task dates.
 *
 * @param startDate - First day, if any.
 * @param finishDate - Last day, if any.
 * @param milestone - Whether the task is a milestone.
 * @returns A milestone, date-range, or (without a start) due-date schedule, or an unscheduled one
 *   without dates.
 */
function readSchedule(startDate: string, finishDate: string, milestone: boolean) {
  if (!isIsoDate(finishDate)) return { mode: 'unscheduled' }
  if (milestone) return { mode: 'milestone', startDate: finishDate, endDate: finishDate, durationDays: 0 }
  // A dependency needs both dates, so a task with a start keeps it as a range.
  if (!isIsoDate(startDate)) return { mode: 'due-date', dueDate: finishDate }
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
