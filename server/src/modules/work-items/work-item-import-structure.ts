import {
  WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT,
  WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH,
  WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT,
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  type ScheduleDependencyType,
  type WorkItemContributionStatus,
  type WorkItemContributorAssignmentCreateInput,
} from '@mukuroji/contracts'

/** Import target fields that describe the structure between rows rather than one Work Item. */
export const WORK_ITEM_IMPORT_STRUCTURE_TARGET_FIELDS = [
  'importKey',
  'parentKey',
  'wbsNumber',
  'outlineLevel',
  'dependencies',
  'relations',
  'acceptanceCriteria',
] as const

/** Import target field that fills the contributor assignments of the created Work Item. */
export const WORK_ITEM_IMPORT_CONTRIBUTORS_TARGET_FIELD = 'contributors'

/** Most schedule dependencies or relations one imported row may declare. */
export const WORK_ITEM_IMPORT_ROW_LINK_LIMIT = 50

/** Longest row key, WBS number, or reference accepted in an import. */
const importKeyMaxLength = 256

/** Deepest outline level accepted in an import. */
const importOutlineLevelMax = 100

/** One structure target field of an import mapping. */
export type WorkItemImportStructureTargetField = typeof WORK_ITEM_IMPORT_STRUCTURE_TARGET_FIELDS[number]

/** Relation types an import row can declare toward another row. */
export type WorkItemImportRelationType = 'blocks' | 'blockedBy' | 'related' | 'duplicate'

/** Stable error recorded on an import row. */
export type WorkItemImportStructureError = {
  /** One-based data row number. */
  row: number
  /** Target field that caused the error. */
  field?: string
  /** Stable error code. */
  code: string
  /** Explanation that helps fix the source. */
  message: string
}

/** Structure values read from one source row before rows are resolved against each other. */
export type WorkItemImportRowStructure = {
  /** One-based data row number. */
  row: number
  /** Key other rows use to refer to this row. */
  importKey?: string
  /** Key of the parent row. */
  parentKey?: string
  /** WBS number such as `1.2.3`; its prefix names the parent when no parent key is given. */
  wbsNumber?: string
  /** One-based outline level; the nearest earlier row one level up is the parent. */
  outlineLevel?: number
  /** Predecessors of this row. */
  dependencies: WorkItemImportDependencyReference[]
  /** Relations from this row to other rows. */
  relations: WorkItemImportRelationReference[]
  /** Acceptance criteria to give the created Work Item, when the source has any. */
  acceptanceCriteria?: WorkItemImportAcceptanceCriterion[]
}

/** One predecessor reference read from a row. */
export type WorkItemImportDependencyReference = {
  /** Key of the predecessor row. */
  key: string
  /** Scheduling rule between the rows. */
  type: ScheduleDependencyType
  /** Signed lag in calendar days. */
  lagDays: number
  /**
   * Whole compact entry; when it names a row, it is that row with `FS` and no lag, so a key such
   * as `task-12` is not read as `task` with a lag.
   */
  entry?: string
}

/** One relation reference read from a row. */
export type WorkItemImportRelationReference = {
  /** Relation type from this row's point of view. */
  type: WorkItemImportRelationType
  /** Key of the other row. */
  key: string
}

/** One acceptance criterion read from a row. */
export type WorkItemImportAcceptanceCriterion = {
  /** Condition text. */
  text: string
  /** Whether the condition is already met. */
  satisfied: boolean
}

/** Work the import worker does after every row exists, in the order it must be applied. */
export type WorkItemImportLink =
  | {
    /** Makes one imported row the parent of another. */
    kind: 'parent'
    /** Row of the child Work Item. */
    childRow: number
    /** Row of the parent Work Item. */
    parentRow: number
  }
  | {
    /** Adds one schedule dependency between imported rows. */
    kind: 'dependency'
    /** Row of the predecessor Work Item. */
    predecessorRow: number
    /** Row of the successor Work Item. */
    successorRow: number
    /** Scheduling rule. */
    type: ScheduleDependencyType
    /** Signed lag in calendar days. */
    lagDays: number
  }
  | {
    /** Adds one non-hierarchy relation between imported rows. */
    kind: 'relation'
    /** Row the relation is created from. */
    sourceRow: number
    /** Row the relation points to. */
    targetRow: number
    /** Relation type from the source row's point of view. */
    type: 'blocks' | 'related' | 'duplicate'
  }
  | {
    /** Stores acceptance criteria on one imported row. */
    kind: 'acceptance-criteria'
    /** Row of the Work Item. */
    row: number
    /** Criteria in source order. */
    criteria: WorkItemImportAcceptanceCriterion[]
  }

/** Links and errors found by resolving the rows of one import against each other. */
export type WorkItemImportStructureResolution = {
  /** Links in apply order: parents in row order, then dependencies, relations, and criteria. */
  links: WorkItemImportLink[]
  /** Errors by row. */
  errors: WorkItemImportStructureError[]
}

/**
 * Reads the structure values of one mapped row.
 *
 * @param row - One-based data row number.
 * @param read - Reads the transformed value of one target field.
 * @param mapped - Structure target fields present in the mapping.
 * @param errors - Mutable error list for the row.
 * @returns The row's structure values.
 */
export function readWorkItemImportRowStructure(
  row: number,
  read: (targetField: string) => unknown,
  mapped: ReadonlySet<string>,
  errors: WorkItemImportStructureError[],
): WorkItemImportRowStructure {
  const importKey = mapped.has('importKey') ? readKey(read('importKey'), row, 'importKey', errors) : undefined
  const parentKey = mapped.has('parentKey') ? readKey(read('parentKey'), row, 'parentKey', errors) : undefined
  const wbsNumber = mapped.has('wbsNumber') ? readKey(read('wbsNumber'), row, 'wbsNumber', errors) : undefined
  const outlineLevel = mapped.has('outlineLevel') ? readOutlineLevel(read('outlineLevel'), row, errors) : undefined
  const acceptanceCriteria = mapped.has('acceptanceCriteria')
    ? readAcceptanceCriteria(read('acceptanceCriteria'), row, errors)
    : undefined
  return {
    row,
    ...(importKey === undefined ? {} : { importKey }),
    ...(parentKey === undefined ? {} : { parentKey }),
    ...(wbsNumber === undefined ? {} : { wbsNumber }),
    ...(outlineLevel === undefined ? {} : { outlineLevel }),
    dependencies: mapped.has('dependencies') ? readDependencies(read('dependencies'), row, errors) : [],
    relations: mapped.has('relations') ? readRelations(read('relations'), row, errors) : [],
    ...(acceptanceCriteria === undefined || acceptanceCriteria.length === 0 ? {} : { acceptanceCriteria }),
  }
}

/**
 * Resolves row references into links and reports unknown, duplicate, and cyclic references.
 *
 * A reference names another row by its `importKey`, or by its `wbsNumber` when no row has that
 * import key. The parent comes from `parentKey`, then from the WBS number prefix, then from the
 * outline level.
 *
 * @param rows - Structure values of every row in source order.
 * @returns Links in apply order and the errors found.
 */
export function resolveWorkItemImportStructure(
  rows: readonly WorkItemImportRowStructure[],
): WorkItemImportStructureResolution {
  const errors: WorkItemImportStructureError[] = []
  const byImportKey = indexRows(rows, 'importKey', errors)
  const byWbsNumber = indexRows(rows, 'wbsNumber', errors)
  /** Finds the row that a reference names. */
  const resolve = (key: string) => byImportKey.get(key) ?? byWbsNumber.get(key)

  const parentByRow = new Map<number, number>()
  const outlineStack: Array<{ level: number; row: number }> = []
  for (const row of rows) {
    let parentRow: number | undefined
    // Every row with a level updates the outline, so a row whose parent comes from another field
    // still anchors the rows below it.
    let outlineParentRow: number | undefined
    let outlineError = false
    if (row.outlineLevel !== undefined) {
      while (outlineStack.length > 0 && outlineStack[outlineStack.length - 1]!.level >= row.outlineLevel) {
        outlineStack.pop()
      }
      const parent = outlineStack[outlineStack.length - 1]
      if (row.outlineLevel > 1) {
        if (parent?.level === row.outlineLevel - 1) outlineParentRow = parent.row
        else outlineError = true
      }
      outlineStack.push({ level: row.outlineLevel, row: row.row })
    }
    if (row.parentKey !== undefined) {
      parentRow = resolve(row.parentKey)
      if (parentRow === undefined) {
        errors.push(referenceError(row.row, 'parentKey', `parentKey "${row.parentKey}" does not name a row in this import.`))
      }
    } else if (row.wbsNumber !== undefined && row.wbsNumber.includes('.')) {
      const parentWbsNumber = row.wbsNumber.slice(0, row.wbsNumber.lastIndexOf('.'))
      parentRow = byWbsNumber.get(parentWbsNumber)
      if (parentRow === undefined) {
        errors.push(referenceError(row.row, 'wbsNumber', `No row has the parent WBS number "${parentWbsNumber}".`))
      }
    } else if (row.outlineLevel !== undefined && (row.wbsNumber === undefined || row.outlineLevel > 1)) {
      parentRow = outlineParentRow
      if (outlineError) {
        errors.push({
          row: row.row,
          field: 'outlineLevel',
          code: 'ImportOutlineLevelInvalid',
          message: `outlineLevel ${row.outlineLevel} needs an earlier row at level ${row.outlineLevel - 1}.`,
        })
      }
    }
    if (parentRow === row.row) {
      errors.push(referenceError(row.row, 'parentKey', 'A row cannot be its own parent.'))
    } else if (parentRow !== undefined) {
      parentByRow.set(row.row, parentRow)
    }
  }
  for (const row of findParentCycleRows(parentByRow)) {
    errors.push({
      row,
      field: 'parentKey',
      code: 'ImportHierarchyCycle',
      message: 'The parent references of this row form a cycle.',
    })
    parentByRow.delete(row)
  }

  const links: WorkItemImportLink[] = []
  for (const row of rows) {
    const parentRow = parentByRow.get(row.row)
    if (parentRow !== undefined) links.push({ kind: 'parent', childRow: row.row, parentRow })
  }

  const dependencyKeys = new Set<string>()
  const dependencyEdges = new Map<number, number[]>()
  for (const row of rows) {
    for (const written of row.dependencies) {
      const entryRow = written.entry === undefined ? undefined : resolve(written.entry)
      const dependency: WorkItemImportDependencyReference = entryRow === undefined || written.entry === undefined
        ? written
        : { key: written.entry, type: 'finish-to-start', lagDays: 0 }
      const predecessorRow = entryRow ?? resolve(dependency.key)
      if (predecessorRow === undefined) {
        errors.push(referenceError(row.row, 'dependencies', `Predecessor "${dependency.key}" does not name a row in this import.`))
        continue
      }
      if (predecessorRow === row.row) {
        errors.push(referenceError(row.row, 'dependencies', 'A row cannot depend on itself.'))
        continue
      }
      const key = `${predecessorRow}\u0000${row.row}`
      if (dependencyKeys.has(key)) {
        errors.push({
          row: row.row,
          field: 'dependencies',
          code: 'ImportDependencyDuplicate',
          message: `Predecessor "${dependency.key}" is listed more than once.`,
        })
        continue
      }
      dependencyKeys.add(key)
      dependencyEdges.set(predecessorRow, [...(dependencyEdges.get(predecessorRow) ?? []), row.row])
      links.push({ kind: 'dependency', predecessorRow, successorRow: row.row, type: dependency.type, lagDays: dependency.lagDays })
    }
  }
  const dependencyCycleRows = findDependencyCycleRows(dependencyEdges)
  for (const row of dependencyCycleRows) {
    errors.push({
      row,
      field: 'dependencies',
      code: 'ImportDependencyCycle',
      message: 'The schedule dependencies of this row form a cycle.',
    })
  }

  const relationKeys = new Set<string>()
  for (const row of rows) {
    for (const relation of row.relations) {
      const otherRow = resolve(relation.key)
      if (otherRow === undefined) {
        errors.push(referenceError(row.row, 'relations', `Relation target "${relation.key}" does not name a row in this import.`))
        continue
      }
      if (otherRow === row.row) {
        errors.push(referenceError(row.row, 'relations', 'A row cannot relate to itself.'))
        continue
      }
      const link: { sourceRow: number; targetRow: number; type: 'blocks' | 'related' | 'duplicate' } =
        relation.type === 'blockedBy'
          ? { sourceRow: otherRow, targetRow: row.row, type: 'blocks' }
          : { sourceRow: row.row, targetRow: otherRow, type: relation.type }
      // A symmetric relation listed on both rows is one link.
      const [first, second] = link.type === 'blocks'
        ? [link.sourceRow, link.targetRow]
        : [Math.min(link.sourceRow, link.targetRow), Math.max(link.sourceRow, link.targetRow)]
      const key = `${link.type}\u0000${first}\u0000${second}`
      if (relationKeys.has(key)) continue
      relationKeys.add(key)
      links.push({ kind: 'relation', ...link })
    }
  }

  for (const row of rows) {
    if (row.acceptanceCriteria) {
      links.push({ kind: 'acceptance-criteria', row: row.row, criteria: row.acceptanceCriteria.map((criterion) => ({ ...criterion })) })
    }
  }
  return { links, errors }
}

/**
 * Reads the contributor assignments of one row.
 *
 * Accepts a JSON array of assignments, or entries separated by `;` or new lines in which
 * whitespace-separated tokens are `member:<userId>`, `role:<jobRoleId>`, `effort:<minutes>` (or
 * `<n>h` / `<n>m`), and `status:<planned|in-progress|done>`. A token without a prefix is a member.
 *
 * @param value - Transformed source value.
 * @param row - One-based data row number.
 * @param errors - Mutable error list for the row.
 * @returns Assignments in source order, or undefined when the cell is empty or invalid.
 */
export function readWorkItemImportContributors(
  value: unknown,
  row: number,
  errors: WorkItemImportStructureError[],
): WorkItemContributorAssignmentCreateInput[] | undefined {
  if (isEmpty(value)) return undefined
  const field = WORK_ITEM_IMPORT_CONTRIBUTORS_TARGET_FIELD
  /** Records an invalid contributor cell. */
  const fail = (message: string) => {
    errors.push({ row, field, code: 'ImportContributorsInvalid', message })
    return undefined
  }
  const parsed = readJsonArray(value)
  let assignments: WorkItemContributorAssignmentCreateInput[]
  if (parsed !== undefined) {
    assignments = []
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return fail('Each contributor must be an object.')
      }
      const memberUserId: unknown = Reflect.get(entry, 'memberUserId')
      const jobRoleId: unknown = Reflect.get(entry, 'jobRoleId')
      const plannedEffortMinutes: unknown = Reflect.get(entry, 'plannedEffortMinutes')
      const status: unknown = Reflect.get(entry, 'status')
      const unknownField = Object.keys(entry).find((key) =>
        key !== 'memberUserId' && key !== 'jobRoleId' && key !== 'plannedEffortMinutes' && key !== 'status')
      if (unknownField !== undefined) return fail(`Unsupported contributor field: ${unknownField}.`)
      if (
        (memberUserId !== undefined && typeof memberUserId !== 'string') ||
        (jobRoleId !== undefined && typeof jobRoleId !== 'string') ||
        (plannedEffortMinutes !== undefined && typeof plannedEffortMinutes !== 'number') ||
        (status !== undefined && !isContributionStatus(status))
      ) {
        return fail('A contributor has a value of the wrong type.')
      }
      assignments.push({
        ...(memberUserId === undefined ? {} : { memberUserId }),
        ...(jobRoleId === undefined ? {} : { jobRoleId }),
        ...(plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes }),
        ...(status === undefined ? {} : { status }),
      })
    }
  } else if (typeof value === 'string') {
    assignments = []
    for (const entry of splitEntries(value, /[;\n\r]+/u)) {
      const assignment: WorkItemContributorAssignmentCreateInput = {}
      for (const token of entry.split(/\s+/u).filter(Boolean)) {
        const separator = token.indexOf(':')
        const prefix = separator < 0 ? '' : token.slice(0, separator).toLowerCase()
        const text = separator < 0 ? token : token.slice(separator + 1)
        if (prefix === 'role') {
          assignment.jobRoleId = text
        } else if (prefix === 'effort' || (prefix === '' && /^\d+(?:\.\d+)?[hm]$/iu.test(text))) {
          const minutes = readEffortMinutes(text)
          if (minutes === undefined) return fail(`Contributor effort "${text}" is invalid.`)
          assignment.plannedEffortMinutes = minutes
        } else if (prefix === 'status') {
          if (!isContributionStatus(text)) return fail(`Contributor status "${text}" is invalid.`)
          assignment.status = text
        } else if (prefix === 'member' || prefix === '') {
          assignment.memberUserId = text
        } else {
          return fail(`Contributor token "${token}" is invalid.`)
        }
      }
      assignments.push(assignment)
    }
  } else {
    return fail('contributors must be text or a JSON array.')
  }
  if (assignments.length > WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT) {
    return fail(`A Work Item can have at most ${WORK_ITEM_CONTRIBUTOR_ASSIGNMENT_LIMIT} contributors.`)
  }
  return assignments.length === 0 ? undefined : assignments
}

/**
 * Reads the schedule dependency text of one row.
 *
 * Entries are separated by `,`, `;`, or new lines, and each is a row key followed by an optional
 * type (`FS`, `SS`, `FF`, `SF`; `FS` when left out) and lag (`+2`, `-1d`), as in `1.2FS+2d` or
 * `a1 SS -1`. A JSON array of `{ key, type, lagDays }` objects is also accepted.
 *
 * @param value - Transformed source value.
 * @param row - One-based data row number.
 * @param errors - Mutable error list for the row.
 * @returns Predecessor references in source order.
 */
function readDependencies(
  value: unknown,
  row: number,
  errors: WorkItemImportStructureError[],
): WorkItemImportDependencyReference[] {
  if (isEmpty(value)) return []
  if (isStringArray(value)) return readDependencies(value.join('\n'), row, errors)
  const field = 'dependencies'
  /** Records an invalid dependency cell. */
  const fail = (message: string) => {
    errors.push({ row, field, code: 'ImportDependenciesInvalid', message })
    return []
  }
  const parsed = readJsonArray(value)
  const references: WorkItemImportDependencyReference[] = []
  if (parsed !== undefined) {
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return fail('Each dependency must be an object.')
      }
      const key: unknown = Reflect.get(entry, 'key')
      const type = readDependencyType(Reflect.get(entry, 'type') ?? 'FS')
      const lagDays: unknown = Reflect.get(entry, 'lagDays') ?? 0
      if (typeof key !== 'string' || !key.trim() || [...key].length > importKeyMaxLength) {
        return fail('Each dependency needs a key.')
      }
      if (type === undefined) return fail('A dependency type is invalid.')
      if (!isLagDays(lagDays)) return fail('A dependency lag is invalid.')
      references.push({ key: key.trim(), type, lagDays })
    }
  } else if (typeof value === 'string' || typeof value === 'number') {
    for (const entry of splitEntries(String(value), /[,;\n\r]+/u)) {
      const reference = readDependencyText(entry)
      if (!reference) return fail(`Dependency "${entry}" is invalid.`)
      references.push(reference)
    }
  } else {
    return fail('dependencies must be text or a JSON array.')
  }
  if (references.length > WORK_ITEM_IMPORT_ROW_LINK_LIMIT) {
    return fail(`A row can have at most ${WORK_ITEM_IMPORT_ROW_LINK_LIMIT} dependencies.`)
  }
  return references
}

/**
 * Reads one dependency written as text.
 *
 * With whitespace, the first word is the key and the rest is the type and lag (`a1 FS +2`), so a
 * key may end in letters or digits that look like a type or lag. Without whitespace the entry is
 * the compact MS Project form (`3FS+2d`), whose type must be upper case.
 *
 * @param entry - One trimmed entry.
 * @returns The reference, or undefined when the entry is invalid.
 */
function readDependencyText(entry: string): WorkItemImportDependencyReference | undefined {
  const lagUnit = '(?:d|days?|日|edays?)?'
  let key: string | undefined
  let type: string | undefined
  let sign: string | undefined
  let amount: string | undefined
  const spaced = /^(\S+)\s+(.*)$/u.exec(entry)
  if (spaced) {
    const rule = new RegExp(`^(FS|SS|FF|SF)?\\s*(?:([+-])\\s*(\\d+)\\s*${lagUnit})?$`, 'iu').exec(spaced[2]!.trim())
    if (!rule) return undefined
    ;[key, type, sign, amount] = [spaced[1], rule[1], rule[2], rule[3]]
  } else {
    const compact = new RegExp(`^(.+?)(FS|SS|FF|SF)?(?:([+-])(\\d+)${lagUnit})?$`, 'u').exec(entry)
    if (!compact) return undefined
    ;[key, type, sign, amount] = [compact[1], compact[2], compact[3], compact[4]]
  }
  const lagDays = amount === undefined ? 0 : Number(amount) * (sign === '-' ? -1 : 1)
  if (!key || [...key].length > importKeyMaxLength || !isLagDays(lagDays)) {
    return spaced || [...entry].length > importKeyMaxLength
      ? undefined
      : { key: entry, type: 'finish-to-start', lagDays: 0 }
  }
  return {
    key,
    type: readDependencyType(type ?? 'FS')!,
    lagDays,
    ...(spaced || (type === undefined && amount === undefined) ? {} : { entry }),
  }
}

/**
 * Reads the relation text of one row.
 *
 * Entries are separated by `,`, `;`, or new lines, and each is `<type>:<key>` with a type of
 * `blocks`, `blockedBy`, `related`, or `duplicate`. A JSON array of `{ type, key }` objects is
 * also accepted.
 *
 * @param value - Transformed source value.
 * @param row - One-based data row number.
 * @param errors - Mutable error list for the row.
 * @returns Relation references in source order.
 */
function readRelations(
  value: unknown,
  row: number,
  errors: WorkItemImportStructureError[],
): WorkItemImportRelationReference[] {
  if (isEmpty(value)) return []
  if (isStringArray(value)) return readRelations(value.join('\n'), row, errors)
  /** Records an invalid relation cell. */
  const fail = (message: string) => {
    errors.push({ row, field: 'relations', code: 'ImportRelationsInvalid', message })
    return []
  }
  const parsed = readJsonArray(value)
  const entries: Array<{ type: unknown; key: unknown }> = []
  if (parsed !== undefined) {
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return fail('Each relation must be an object.')
      }
      entries.push({ type: Reflect.get(entry, 'type'), key: Reflect.get(entry, 'key') })
    }
  } else if (typeof value === 'string') {
    for (const entry of splitEntries(value, /[,;\n\r]+/u)) {
      const separator = entry.indexOf(':')
      if (separator < 0) return fail(`Relation "${entry}" must be written as type:key.`)
      entries.push({ type: entry.slice(0, separator).trim(), key: entry.slice(separator + 1).trim() })
    }
  } else {
    return fail('relations must be text or a JSON array.')
  }
  const references: WorkItemImportRelationReference[] = []
  for (const entry of entries) {
    if (!isImportRelationType(entry.type)) return fail(`Relation type "${String(entry.type)}" is invalid.`)
    if (typeof entry.key !== 'string' || !entry.key.trim() || [...entry.key].length > importKeyMaxLength) {
      return fail('Each relation needs a key.')
    }
    references.push({ type: entry.type, key: entry.key.trim() })
  }
  if (references.length > WORK_ITEM_IMPORT_ROW_LINK_LIMIT) {
    return fail(`A row can have at most ${WORK_ITEM_IMPORT_ROW_LINK_LIMIT} relations.`)
  }
  return references
}

/**
 * Reads the acceptance criteria of one row.
 *
 * Accepts a JSON array of strings or `{ text, satisfied }` objects, or one criterion per line in
 * which a leading `[x]` marks a met condition and a leading `[ ]` or `- ` is dropped.
 *
 * @param value - Transformed source value.
 * @param row - One-based data row number.
 * @param errors - Mutable error list for the row.
 * @returns Criteria in source order.
 */
function readAcceptanceCriteria(
  value: unknown,
  row: number,
  errors: WorkItemImportStructureError[],
): WorkItemImportAcceptanceCriterion[] | undefined {
  if (isEmpty(value)) return undefined
  /** Records an invalid acceptance criteria cell. */
  const fail = (message: string) => {
    errors.push({ row, field: 'acceptanceCriteria', code: 'ImportAcceptanceCriteriaInvalid', message })
    return undefined
  }
  const parsed = readJsonArray(value)
  const criteria: WorkItemImportAcceptanceCriterion[] = []
  if (parsed !== undefined) {
    for (const entry of parsed) {
      if (typeof entry === 'string') {
        criteria.push({ text: entry.trim(), satisfied: false })
        continue
      }
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return fail('Each acceptance criterion must be text or an object.')
      }
      const text: unknown = Reflect.get(entry, 'text')
      const satisfied: unknown = Reflect.get(entry, 'satisfied') ?? false
      if (typeof text !== 'string' || typeof satisfied !== 'boolean') {
        return fail('Each acceptance criterion needs text and an optional boolean satisfied.')
      }
      criteria.push({ text: text.trim(), satisfied })
    }
  } else if (typeof value === 'string') {
    for (const line of value.split(/\r\n|\r|\n/u)) {
      const match = /^\s*(?:\[([ xX])\]|[-*・])?\s*(.*)$/u.exec(line)
      const text = match?.[2]?.trim() ?? ''
      if (text) criteria.push({ text, satisfied: match?.[1] === 'x' || match?.[1] === 'X' })
    }
  } else {
    return fail('acceptanceCriteria must be text or a JSON array.')
  }
  if (criteria.length > WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT) {
    return fail(`A Work Item can have at most ${WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT} acceptance criteria.`)
  }
  if (criteria.some((criterion) =>
    !criterion.text || [...criterion.text].length > WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH)) {
    return fail(`Each acceptance criterion needs 1 to ${WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH} characters.`)
  }
  return criteria
}

/**
 * Indexes rows by one key field and reports duplicate keys.
 *
 * @param rows - Structure values of every row.
 * @param field - Key field to index.
 * @param errors - Mutable error list.
 * @returns Row number by key; a duplicated key keeps its first row.
 */
function indexRows(
  rows: readonly WorkItemImportRowStructure[],
  field: 'importKey' | 'wbsNumber',
  errors: WorkItemImportStructureError[],
) {
  const index = new Map<string, number>()
  for (const row of rows) {
    const key = row[field]
    if (key === undefined) continue
    if (index.has(key)) {
      errors.push({
        row: row.row,
        field,
        code: 'ImportKeyDuplicate',
        message: `${field} "${key}" is used by more than one row.`,
      })
      continue
    }
    index.set(key, row.row)
  }
  return index
}

/**
 * Finds the rows whose parent chain loops.
 *
 * @param parentByRow - Parent row by child row.
 * @returns Rows on a parent cycle, ascending.
 */
function findParentCycleRows(parentByRow: ReadonlyMap<number, number>) {
  const cycleRows = new Set<number>()
  const settled = new Set<number>()
  for (const start of parentByRow.keys()) {
    const path: number[] = []
    const onPath = new Set<number>()
    let current: number | undefined = start
    while (current !== undefined && !settled.has(current)) {
      if (onPath.has(current)) {
        for (const row of path.slice(path.indexOf(current))) cycleRows.add(row)
        break
      }
      onPath.add(current)
      path.push(current)
      current = parentByRow.get(current)
    }
    for (const row of path) settled.add(row)
  }
  return [...cycleRows].sort((left, right) => left - right)
}

/**
 * Finds the rows that cannot be ordered because their dependencies loop.
 *
 * @param edges - Successor rows by predecessor row.
 * @returns Rows left on or behind a cycle, ascending.
 */
function findDependencyCycleRows(edges: ReadonlyMap<number, readonly number[]>) {
  const incoming = new Map<number, number>()
  for (const [predecessor, successors] of edges) {
    if (!incoming.has(predecessor)) incoming.set(predecessor, 0)
    for (const successor of successors) incoming.set(successor, (incoming.get(successor) ?? 0) + 1)
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([row]) => row)
  while (ready.length > 0) {
    const row = ready.pop()!
    incoming.delete(row)
    for (const successor of edges.get(row) ?? []) {
      const count = (incoming.get(successor) ?? 0) - 1
      incoming.set(successor, count)
      if (count === 0) ready.push(successor)
    }
  }
  return [...incoming.keys()].sort((left, right) => left - right)
}

/**
 * Builds an unknown or invalid reference error.
 *
 * @param row - One-based data row number.
 * @param field - Target field with the reference.
 * @param message - Explanation.
 * @returns The row error.
 */
function referenceError(row: number, field: string, message: string): WorkItemImportStructureError {
  return { row, field, code: 'ImportReferenceInvalid', message }
}

/**
 * Reads one row key, WBS number, or reference.
 *
 * @param value - Transformed source value.
 * @param row - One-based data row number.
 * @param field - Target field.
 * @param errors - Mutable error list for the row.
 * @returns The trimmed key, or undefined when empty or invalid.
 */
function readKey(value: unknown, row: number, field: string, errors: WorkItemImportStructureError[]) {
  if (isEmpty(value)) return undefined
  if (typeof value !== 'string' && typeof value !== 'number') {
    errors.push({ row, field, code: 'InvalidFieldType', message: `${field} must be text.` })
    return undefined
  }
  const key = String(value).trim()
  if (!key) return undefined
  if ([...key].length > importKeyMaxLength || /\p{Cc}/u.test(key)) {
    errors.push({
      row,
      field,
      code: 'ImportKeyInvalid',
      message: `${field} must be at most ${importKeyMaxLength} characters without control characters.`,
    })
    return undefined
  }
  return key
}

/**
 * Reads one outline level.
 *
 * @param value - Transformed source value.
 * @param row - One-based data row number.
 * @param errors - Mutable error list for the row.
 * @returns The level; an empty cell is level 1.
 */
function readOutlineLevel(value: unknown, row: number, errors: WorkItemImportStructureError[]) {
  if (isEmpty(value)) return 1
  const level = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
  if (!Number.isSafeInteger(level) || level < 1 || level > importOutlineLevelMax) {
    errors.push({
      row,
      field: 'outlineLevel',
      code: 'ImportOutlineLevelInvalid',
      message: `outlineLevel must be an integer from 1 through ${importOutlineLevelMax}.`,
    })
    return undefined
  }
  return level
}

/**
 * Reads a dependency type written as an abbreviation or a full name.
 *
 * @param value - Source type.
 * @returns The canonical type, or undefined when unknown.
 */
function readDependencyType(value: unknown): ScheduleDependencyType | undefined {
  if (typeof value !== 'string') return undefined
  switch (value.trim().toLowerCase()) {
    case 'fs':
    case 'finish-to-start':
      return 'finish-to-start'
    case 'ss':
    case 'start-to-start':
      return 'start-to-start'
    case 'ff':
    case 'finish-to-finish':
      return 'finish-to-finish'
    case 'sf':
    case 'start-to-finish':
      return 'start-to-finish'
    default:
      return undefined
  }
}

/**
 * Converts a planned effort token to minutes.
 *
 * @param text - Minutes, or a number with `h` or `m`.
 * @returns Whole minutes, or undefined when invalid.
 */
function readEffortMinutes(text: string) {
  const match = /^(\d+(?:\.\d+)?)([hm])?$/iu.exec(text.trim())
  if (!match) return undefined
  const minutes = Number(match[1]) * (match[2]?.toLowerCase() === 'h' ? 60 : 1)
  return Number.isSafeInteger(minutes) ? minutes : undefined
}

/**
 * Parses a JSON array given as a value or as JSON text.
 *
 * @param value - Source value.
 * @returns The array, or undefined when the value is not one.
 */
function readJsonArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trimStart().startsWith('[')) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Splits a cell into trimmed non-empty entries.
 *
 * @param value - Cell text.
 * @param separator - Entry separator.
 * @returns Entries in order.
 */
function splitEntries(value: string, separator: RegExp) {
  return value.split(separator).map((entry) => entry.trim()).filter(Boolean)
}

/**
 * Checks a dependency lag.
 *
 * @param value - Candidate lag.
 * @returns Whether it is an accepted signed whole number of days.
 */
function isLagDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    Math.abs(value) <= WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS
}

/**
 * Checks a contributor progress value.
 *
 * @param value - Candidate status.
 * @returns Whether it is a contribution status.
 */
function isContributionStatus(value: unknown): value is WorkItemContributionStatus {
  return value === 'planned' || value === 'in-progress' || value === 'done'
}

/**
 * Checks a relation type an import row may declare.
 *
 * @param value - Candidate type.
 * @returns Whether it is an import relation type.
 */
function isImportRelationType(value: unknown): value is WorkItemImportRelationType {
  return value === 'blocks' || value === 'blockedBy' || value === 'related' || value === 'duplicate'
}

/**
 * Checks for an empty source value.
 *
 * @param value - Source value.
 * @returns Whether the value is missing or blank.
 */
function isEmpty(value: unknown) {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim())
}

/**
 * Checks for a list of entries produced by the `split-comma` transform.
 *
 * @param value - Source value.
 * @returns Whether the value is an array of strings.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
