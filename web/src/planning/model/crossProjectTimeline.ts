import type {
  PlanningDependency,
  PlanningEntity,
  PlanningEntityType,
  ScheduleDependencyType,
} from '@mukuroji/contracts'

/** Planning entity types drawn on the cross-Project timeline chart. */
export const crossProjectTimelineEntityTypes: readonly PlanningEntityType[] = [
  'phase',
  'milestone',
  'cycle',
  'release',
]

/** How cross-Project timeline rows are grouped. */
export type CrossProjectTimelineGrouping = 'project' | 'portfolio'

/** Pixel height of one group header row; the chart overlay uses it to place dependency lines. */
export const CROSS_PROJECT_TIMELINE_GROUP_ROW_HEIGHT = 36

/** Pixel height of one entity row; the chart overlay uses it to place dependency lines. */
export const CROSS_PROJECT_TIMELINE_ENTITY_ROW_HEIGHT = 40

/** Team and Project names used to label Project groups, structurally matching the Project directory. */
export type CrossProjectTimelineDirectoryTeam = {
  /** Team identifier. */
  id: string
  /** Team display name. */
  name: string
  /** Projects owned by the Team. */
  projects: readonly {
    /** Team-local Project identifier. */
    id: string
    /** Project display name. */
    name: string
  }[]
}

/** Horizontal placement of one date range, as percentages of the chart width. */
export type CrossProjectTimelineSpan = {
  /** Distance from the chart start to the range start, in percent. */
  leftPercent: number
  /** Width of the inclusive range, in percent. */
  widthPercent: number
}

/** One Planning entity row with its forecast bar and baseline comparison. */
export type CrossProjectTimelineEntityRow = {
  /** Discriminates entity rows from group header rows. */
  kind: 'entity'
  /** Planning entity drawn on the row. */
  entity: PlanningEntity
  /** Pixel offset of the row top inside the chart body. */
  top: number
  /** Forecast placement; milestones use a zero-width point at the forecast end date. */
  forecast: CrossProjectTimelineSpan
  /** Baseline placement, drawn under the forecast to show schedule drift. */
  baseline: CrossProjectTimelineSpan
  /** Forecast end minus baseline end in calendar days; positive values are late. */
  endVarianceDays: number
  /** Project or Team name shown on the row when the group does not already name it. */
  scopeLabel?: string
}

/** One group header row that names the Project or Portfolio below it. */
export type CrossProjectTimelineGroupRow = {
  /** Discriminates group header rows from entity rows. */
  kind: 'group'
  /** Stable group key used as the React key. */
  key: string
  /** Display label of the group. */
  label: string
  /** Pixel offset of the row top inside the chart body. */
  top: number
  /** Project scope that the header opens, when the group is one Project. */
  project?: {
    /** Team that owns the Project. */
    teamId: string
    /** Team-local Project identifier. */
    projectId: string
  }
  /** Number of entities in the group. */
  entityCount: number
}

/** Row of the cross-Project timeline chart. */
export type CrossProjectTimelineRow = CrossProjectTimelineEntityRow | CrossProjectTimelineGroupRow

/** Dependency line between two visible entity rows. */
export type CrossProjectTimelineLink = {
  /** Planning dependency identifier. */
  id: string
  /** Horizontal start of the line, in percent. */
  fromPercent: number
  /** Vertical start of the line, in pixels. */
  fromY: number
  /** Horizontal end of the line, in percent. */
  toPercent: number
  /** Vertical end of the line, in pixels. */
  toY: number
  /** Whether the successor starts before the predecessor constraint allows. */
  violated: boolean
}

/** Month boundary tick drawn on the chart axis. */
export type CrossProjectTimelineTick = {
  /** First day of the month in `YYYY-MM-DD` form. */
  date: string
  /** Horizontal position of the tick, in percent. */
  leftPercent: number
}

/** Fully computed cross-Project timeline chart. */
export type CrossProjectTimelineChart = {
  /** First day shown by the chart in `YYYY-MM-DD` form. */
  startDate: string
  /** Last day shown by the chart in `YYYY-MM-DD` form. */
  endDate: string
  /** Group header and entity rows in display order. */
  rows: CrossProjectTimelineRow[]
  /** Dependency lines between visible rows. */
  links: CrossProjectTimelineLink[]
  /** Month ticks for the axis. */
  ticks: CrossProjectTimelineTick[]
  /** Position of the today line, or undefined when today is outside the chart. */
  todayPercent?: number
  /** Total pixel height of the chart body. */
  height: number
  /** Number of distinct Projects that own at least one row. */
  projectCount: number
}

/** Input for {@link createCrossProjectTimelineChart}. */
export type CrossProjectTimelineInput = {
  /** Planning entities already filtered to what the caller may read. */
  entities: readonly PlanningEntity[]
  /** Planning dependencies from the same snapshot. */
  dependencies: readonly PlanningDependency[]
  /** Project directory used to name Project and Team groups. */
  directory?: readonly CrossProjectTimelineDirectoryTeam[]
  /** Row grouping. */
  grouping: CrossProjectTimelineGrouping
  /** Today's local date in `YYYY-MM-DD` form. */
  today: string
  /** Label for entities without a Project or Team scope. */
  workspaceLabel: string
  /** Label for entities without a Portfolio ancestor. */
  noPortfolioLabel: string
}

const dayMilliseconds = 86_400_000
const chartPaddingDays = 7

/**
 * Builds the read-only cross-Project timeline chart from one Planning snapshot.
 *
 * Archived entities and entities with invalid dates are skipped. Dependency lines
 * are drawn only when both endpoints are visible, so entities outside the caller's
 * readable scope never leak through a line.
 *
 * @param input - Visible entities, dependencies, labels, grouping, and today's date.
 * @returns Rows, dependency lines, ticks, and the today line, or undefined when nothing is drawable.
 */
export function createCrossProjectTimelineChart(
  input: CrossProjectTimelineInput,
): CrossProjectTimelineChart | undefined {
  const timelineTypes = new Set(crossProjectTimelineEntityTypes)
  const drawable = input.entities.filter((entity) =>
    !entity.archivedAt &&
    timelineTypes.has(entity.type) &&
    readRangeDays(entity.forecast) !== undefined &&
    readRangeDays(entity.baseline) !== undefined
  )
  if (drawable.length === 0) return undefined

  let firstDay = Number.POSITIVE_INFINITY
  let lastDay = Number.NEGATIVE_INFINITY
  for (const entity of drawable) {
    for (const range of [entity.forecast, entity.baseline]) {
      const days = readRangeDays(range)
      if (!days) continue
      firstDay = Math.min(firstDay, days.start)
      lastDay = Math.max(lastDay, days.end)
    }
  }
  const startDay = firstDay - chartPaddingDays
  const endDay = lastDay + chartPaddingDays
  const spanDays = endDay - startDay + 1
  /** Converts an inclusive day range to percentages of the chart width. */
  const toSpan = (start: number, end: number): CrossProjectTimelineSpan => ({
    leftPercent: ((start - startDay) / spanDays) * 100,
    widthPercent: ((end - start + 1) / spanDays) * 100,
  })
  /** Converts one milestone day to a zero-width point at the middle of that day. */
  const toPoint = (day: number): CrossProjectTimelineSpan => ({
    leftPercent: ((day - startDay + 0.5) / spanDays) * 100,
    widthPercent: 0,
  })

  const entitiesById = new Map(input.entities.map((entity) => [entity.id, entity]))
  const groups = new Map<string, Pick<CrossProjectTimelineGroupRow, 'key' | 'label' | 'project'> & {
    entities: PlanningEntity[]
  }>()
  for (const entity of drawable) {
    const group = input.grouping === 'portfolio'
      ? resolvePortfolioGroup(entity, input, entitiesById)
      : resolveScopeGroup(entity, input)
    const existing = groups.get(group.key)
    if (existing) existing.entities.push(entity)
    else groups.set(group.key, { ...group, entities: [entity] })
  }

  const orderedGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      entities: group.entities.toSorted(compareEntitiesBySchedule),
    }))
    .toSorted((left, right) => {
      const leftStart = left.entities[0]?.forecast.startDate ?? ''
      const rightStart = right.entities[0]?.forecast.startDate ?? ''
      return leftStart.localeCompare(rightStart) || left.label.localeCompare(right.label)
    })

  const rows: CrossProjectTimelineRow[] = []
  const entityRowCenters = new Map<string, number>()
  const entityDays = new Map<string, { start: number, end: number }>()
  let top = 0
  for (const group of orderedGroups) {
    rows.push({
      kind: 'group',
      key: group.key,
      label: group.label,
      top,
      ...(group.project ? { project: group.project } : {}),
      entityCount: group.entities.length,
    })
    top += CROSS_PROJECT_TIMELINE_GROUP_ROW_HEIGHT
    for (const entity of group.entities) {
      const forecast = readRangeDays(entity.forecast)
      const baseline = readRangeDays(entity.baseline)
      if (!forecast || !baseline) continue
      const isMilestone = entity.type === 'milestone'
      rows.push({
        kind: 'entity',
        entity,
        top,
        forecast: isMilestone ? toPoint(forecast.end) : toSpan(forecast.start, forecast.end),
        baseline: isMilestone ? toPoint(baseline.end) : toSpan(baseline.start, baseline.end),
        endVarianceDays: forecast.end - baseline.end,
        ...(input.grouping === 'portfolio'
          ? { scopeLabel: resolveScopeGroup(entity, input).label }
          : {}),
      })
      entityRowCenters.set(entity.id, top + CROSS_PROJECT_TIMELINE_ENTITY_ROW_HEIGHT / 2)
      entityDays.set(entity.id, forecast)
      top += CROSS_PROJECT_TIMELINE_ENTITY_ROW_HEIGHT
    }
  }

  const links: CrossProjectTimelineLink[] = []
  for (const dependency of input.dependencies) {
    const fromY = entityRowCenters.get(dependency.predecessorId)
    const toY = entityRowCenters.get(dependency.successorId)
    const predecessor = entityDays.get(dependency.predecessorId)
    const successor = entityDays.get(dependency.successorId)
    if (fromY === undefined || toY === undefined || !predecessor || !successor) continue
    const anchors = resolveDependencyAnchors(dependency.type, predecessor, successor)
    links.push({
      id: dependency.id,
      fromPercent: dayEdgePercent(anchors.from, anchors.fromEdge, startDay, spanDays),
      fromY,
      toPercent: dayEdgePercent(anchors.to, anchors.toEdge, startDay, spanDays),
      toY,
      violated: anchors.required + dependency.lagDays > anchors.actual,
    })
  }

  const ticks: CrossProjectTimelineTick[] = []
  const firstMonth = new Date(startDay * dayMilliseconds)
  let cursor = Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() + 1, 1) / dayMilliseconds
  while (cursor <= endDay) {
    ticks.push({
      date: formatDay(cursor),
      leftPercent: ((cursor - startDay) / spanDays) * 100,
    })
    const date = new Date(cursor * dayMilliseconds)
    cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / dayMilliseconds
  }

  const todayDay = parseDay(input.today)
  const todayPercent = todayDay !== undefined && todayDay >= startDay && todayDay <= endDay
    ? ((todayDay - startDay + 0.5) / spanDays) * 100
    : undefined
  const projectCount = new Set(drawable.flatMap((entity) =>
    entity.projectId && entity.teamId ? [`${entity.teamId}\0${entity.projectId}`] : []
  )).size

  return {
    startDate: formatDay(startDay),
    endDate: formatDay(endDay),
    rows,
    links,
    ticks,
    ...(todayPercent === undefined ? {} : { todayPercent }),
    height: top,
    projectCount,
  }
}

/**
 * Resolves the Portfolio group of an entity.
 *
 * @param entity - Entity to group.
 * @param input - Chart input with the fallback label.
 * @param entitiesById - Visible entities by ID, used to walk Portfolio ancestors.
 * @returns The group key and label.
 */
function resolvePortfolioGroup(
  entity: PlanningEntity,
  input: CrossProjectTimelineInput,
  entitiesById: ReadonlyMap<string, PlanningEntity>,
): Pick<CrossProjectTimelineGroupRow, 'key' | 'label'> {
  const portfolio = findPortfolioAncestor(entity, entitiesById)
  return portfolio
    ? { key: `portfolio:${portfolio.id}`, label: portfolio.title }
    : { key: 'portfolio:none', label: input.noPortfolioLabel }
}

/**
 * Resolves the Project, Team, or Workspace group of an entity.
 *
 * A Project name shared by several Teams is suffixed with the Team name so the
 * groups stay distinguishable.
 *
 * @param entity - Entity to group.
 * @param input - Chart input with the directory and fallback label.
 * @returns The group key, label, and optional Project scope.
 */
function resolveScopeGroup(
  entity: PlanningEntity,
  input: CrossProjectTimelineInput,
): Pick<CrossProjectTimelineGroupRow, 'key' | 'label' | 'project'> {
  const team = entity.teamId === undefined
    ? undefined
    : input.directory?.find((candidate) => candidate.id === entity.teamId)
  if (entity.teamId !== undefined && entity.projectId !== undefined) {
    const projectName = team?.projects.find((project) => project.id === entity.projectId)?.name
    const label = projectName ?? entity.projectId
    const nameIsShared = (input.directory ?? []).some((candidate) =>
      candidate.id !== entity.teamId &&
      candidate.projects.some((project) => (project.name === label || project.id === entity.projectId))
    )
    return {
      key: `project:${entity.teamId}/${entity.projectId}`,
      label: nameIsShared && team ? `${label} · ${team.name}` : label,
      project: { teamId: entity.teamId, projectId: entity.projectId },
    }
  }
  if (entity.teamId !== undefined) {
    return { key: `team:${entity.teamId}`, label: team?.name ?? entity.teamId }
  }
  return { key: 'workspace', label: input.workspaceLabel }
}

/**
 * Walks parent links to the nearest visible Portfolio ancestor.
 *
 * @param entity - Entity whose Portfolio is resolved.
 * @param entitiesById - Visible entities by ID.
 * @returns The nearest Portfolio, or undefined when none is visible.
 */
function findPortfolioAncestor(
  entity: PlanningEntity,
  entitiesById: ReadonlyMap<string, PlanningEntity>,
): PlanningEntity | undefined {
  const visited = new Set<string>()
  let parentId = entity.parentId
  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = entitiesById.get(parentId)
    if (!parent) return undefined
    if (parent.type === 'portfolio') return parent
    parentId = parent.parentId
  }
  return undefined
}

/**
 * Orders entities by forecast start, forecast end, then title.
 *
 * @param left - First entity.
 * @param right - Second entity.
 * @returns A negative, zero, or positive comparison result.
 */
function compareEntitiesBySchedule(left: PlanningEntity, right: PlanningEntity): number {
  return left.forecast.startDate.localeCompare(right.forecast.startDate) ||
    left.forecast.endDate.localeCompare(right.forecast.endDate) ||
    left.title.localeCompare(right.title)
}

/** Days and edges that one dependency line connects. */
type DependencyAnchors = {
  /** Predecessor day the line starts from. */
  from: number
  /** Edge of the predecessor day the line touches. */
  fromEdge: 'start' | 'end'
  /** Successor day the line ends at. */
  to: number
  /** Edge of the successor day the line touches. */
  toEdge: 'start' | 'end'
  /** Earliest successor day allowed before the lag is applied. */
  required: number
  /** Successor day actually scheduled. */
  actual: number
}

/**
 * Picks the predecessor and successor dates a dependency type relates.
 *
 * @param type - Scheduling dependency type.
 * @param predecessor - Predecessor forecast days.
 * @param successor - Successor forecast days.
 * @returns Anchor days, which edge of each day the line touches, and the constraint operands.
 */
function resolveDependencyAnchors(
  type: ScheduleDependencyType,
  predecessor: { start: number, end: number },
  successor: { start: number, end: number },
): DependencyAnchors {
  const fromStart = type === 'start-to-start' || type === 'start-to-finish'
  const toFinish = type === 'finish-to-finish' || type === 'start-to-finish'
  const from = fromStart ? predecessor.start : predecessor.end
  const to = toFinish ? successor.end : successor.start
  return {
    from,
    fromEdge: fromStart ? 'start' : 'end',
    to,
    toEdge: toFinish ? 'end' : 'start',
    // Finish-to-start successors may begin the day after the predecessor finishes.
    required: type === 'finish-to-start' ? from + 1 : from,
    actual: to,
  }
}

/**
 * Converts the start or end edge of one day to a chart percentage.
 *
 * @param day - Day number since the Unix epoch.
 * @param edge - Which edge of the day the line touches.
 * @param startDay - First chart day.
 * @param spanDays - Number of chart days.
 * @returns Horizontal position in percent.
 */
function dayEdgePercent(day: number, edge: 'start' | 'end', startDay: number, spanDays: number): number {
  return ((day - startDay + (edge === 'end' ? 1 : 0)) / spanDays) * 100
}

/**
 * Reads an inclusive date range as day numbers.
 *
 * @param range - Range with `YYYY-MM-DD` dates.
 * @returns Start and end day numbers, or undefined when either date is invalid or reversed.
 */
function readRangeDays(range: { startDate: string, endDate: string }) {
  const start = parseDay(range.startDate)
  const end = parseDay(range.endDate)
  if (start === undefined || end === undefined || end < start) return undefined
  return { start, end }
}

/**
 * Parses a `YYYY-MM-DD` calendar date to a UTC day number.
 *
 * @param value - Calendar date.
 * @returns Days since the Unix epoch, or undefined for invalid input.
 */
function parseDay(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const time = Date.UTC(year, month - 1, day)
  const date = new Date(time)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined
  }
  return time / dayMilliseconds
}

/**
 * Formats a UTC day number as `YYYY-MM-DD`.
 *
 * @param day - Days since the Unix epoch.
 * @returns Calendar date.
 */
function formatDay(day: number): string {
  return new Date(day * dayMilliseconds).toISOString().slice(0, 10)
}

/**
 * Formats a local `Date` as a `YYYY-MM-DD` calendar date for the today line.
 *
 * @param date - Local date.
 * @returns Calendar date in the viewer's time zone.
 */
export function formatLocalCalendarDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
