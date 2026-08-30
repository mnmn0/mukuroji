import type {
  AnalyticsDateRange,
  AnalyticsFilter,
  AnalyticsQueryInput,
  AnalyticsWidget,
} from '@mukuroji/contracts'
import {
  analyticsCalendarDateBoundaryToInstant,
  formatAnalyticsCalendarDate,
} from './timeZone'

/**
 * Analytics workbench を URL から復元する versioned state です。
 */
export type AnalyticsRouteState = {
  /**
   * Analytics query に渡す期間と dimension filter です。
   */
  filter: AnalyticsFilter
  /**
   * Forecast risk と比較する target date range です。
   */
  forecastBaseline?: AnalyticsDateRange
  /**
   * Metric の日付境界と表示に使う IANA timezone です。
   */
  timezone: string
  /**
   * 選択中 saved report の ID です。
   */
  reportId?: string
  /**
   * 過去時点を再実行する任意の ISO timestamp です。
   */
  asOf?: string
  /**
   * 表示中の immutable snapshot record ID です。
   */
  snapshotId?: string
  /**
   * Widget builder を表示するかどうかです。
   */
  builder: boolean
}

const analyticsRouteVersion = '1'

/**
 * Analytics URL query を canonical route state に変換します。
 *
 * @param searchParams - `/reports` の URLSearchParams です。
 * @returns URL override を適用した analytics state です。
 */
export function parseAnalyticsRouteState(
  searchParams: URLSearchParams,
): AnalyticsRouteState {
  if (searchParams.getAll('v').length !== 1 || searchParams.get('v') !== analyticsRouteVersion) {
    throw new TypeError('Analytics URL must use the canonical v=1 schema.')
  }

  const filter = omitUndefinedValues({
    period: {
      from: readValue(searchParams, 'from') ?? '',
      to: readValue(searchParams, 'to') ?? '',
    },
    teamIds: readOptionalRepeated(searchParams, 'team'),
    projectIds: readOptionalRepeated(searchParams, 'project'),
    assigneeUserIds: readOptionalRepeated(searchParams, 'assignee'),
    statusCategories: readOptionalRepeated(searchParams, 'status'),
    workItemTypeIds: readOptionalRepeated(searchParams, 'workItemType'),
    customFields: readCustomFields(searchParams),
    includeArchived: searchParams.has('archived')
      ? searchParams.get('archived') === '1'
      : false,
  }) as unknown as AnalyticsFilter
  const baselineFrom = readValue(searchParams, 'baselineFrom')
  const baselineTo = readValue(searchParams, 'baselineTo')
  const forecastBaseline = searchParams.get('baseline') === 'none'
    ? undefined
    : baselineFrom && baselineTo
      ? { from: baselineFrom, to: baselineTo }
      : undefined

  return {
    asOf: readValue(searchParams, 'asOf'),
    builder: searchParams.get('edit') === '1',
    filter,
    forecastBaseline,
    reportId: readValue(searchParams, 'report'),
    snapshotId: readValue(searchParams, 'snapshot'),
    timezone: readValue(searchParams, 'timezone') ?? 'UTC',
  }
}

/**
 * Reports page の route state と widget 定義から API query input を生成します。
 *
 * @param state - URL から復元した analytics route state です。
 * @param fallbackAsOf - URL に `asOf` がない場合の live query 基準日時です。
 * @param widgets - Report または ad-hoc builder の widget 定義です。
 * @returns `queryAnalytics` に渡す再現可能な query input です。
 */
export function createAnalyticsQueryInput(
  state: AnalyticsRouteState,
  fallbackAsOf: string,
  widgets: AnalyticsWidget[],
): AnalyticsQueryInput {
  return {
    asOf: state.asOf ?? fallbackAsOf,
    filter: state.filter,
    ...(state.forecastBaseline
      ? { forecastBaseline: state.forecastBaseline }
      : {}),
    timeZone: state.timezone,
    widgets,
  }
}

/**
 * Analytics route state を順序が安定した共有可能 URL query に変換します。
 *
 * @param state - 現在の report、filter、timezone、builder state です。
 * @returns Canonical URLSearchParams です。
 */
export function serializeAnalyticsRouteState(state: AnalyticsRouteState) {
  const searchParams = new URLSearchParams({ v: analyticsRouteVersion })
  const filter = asRecord(state.filter)
  const period = asRecord(filter.period)

  setValue(searchParams, 'report', state.reportId)
  setValue(searchParams, 'snapshot', state.snapshotId)
  if (state.forecastBaseline) {
    setValue(searchParams, 'baselineFrom', state.forecastBaseline.from)
    setValue(searchParams, 'baselineTo', state.forecastBaseline.to)
  } else {
    searchParams.set('baseline', 'none')
  }
  setValue(searchParams, 'from', readString(period.from))
  setValue(searchParams, 'to', readString(period.to))
  appendFilterValues(searchParams, 'team', filter.teamIds)
  appendFilterValues(searchParams, 'project', filter.projectIds)
  appendFilterValues(searchParams, 'assignee', filter.assigneeUserIds)
  appendFilterValues(searchParams, 'status', filter.statusCategories)
  appendFilterValues(searchParams, 'workItemType', filter.workItemTypeIds)

  for (const customField of readUnknownArray(filter.customFields)) {
    searchParams.append('customField', stableStringify(customField))
  }

  if (filter.includeArchived === true) {
    searchParams.set('archived', '1')
  }
  if (state.timezone) {
    searchParams.set('timezone', state.timezone)
  }
  setValue(searchParams, 'asOf', state.asOf)
  if (state.builder) {
    searchParams.set('edit', '1')
  }

  searchParams.sort()
  return searchParams
}

/**
 * 直近30日を期間とする初期 analytics filter を生成します。
 *
 * @param now - 期間終端を決める日時です。
 * @param timeZone - Calendar date を解釈する IANA timezone です。
 * @returns 指定 timezone の30 calendar daysをUTC instantへ変換した filter です。
 */
export function createDefaultAnalyticsFilter(
  now = new Date(),
  timeZone = 'UTC',
) {
  const endDate = formatAnalyticsCalendarDate(now.toISOString(), timeZone)
  const end = new Date(`${endDate}T00:00:00.000Z`)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 29)
  const startDate = formatDate(start)

  return {
    period: {
      from: analyticsCalendarDateBoundaryToInstant(
        startDate,
        timeZone,
        'start',
      ),
      to: analyticsCalendarDateBoundaryToInstant(
        endDate,
        timeZone,
        'end',
      ),
    },
  } as AnalyticsFilter
}

/**
 * Analytics route state の一部を immutable に置き換えます。
 *
 * @param state - 更新前 state です。
 * @param patch - 置き換える state field です。
 * @returns 更新後 state です。
 */
export function updateAnalyticsRouteState(
  state: AnalyticsRouteState,
  patch: Partial<AnalyticsRouteState>,
): AnalyticsRouteState {
  return {
    ...state,
    ...patch,
  }
}

/**
 * Reads an optional repeated URL parameter without applying a fallback value.
 *
 * @param searchParams - URL query parameters to inspect.
 * @param key - Repeated parameter name.
 * @returns Normalized values when the key is present, otherwise undefined.
 */
function readOptionalRepeated(
  searchParams: URLSearchParams,
  key: string,
) {
  if (searchParams.has(key)) return readRepeated(searchParams, key)
  return undefined
}

function readCustomFields(searchParams: URLSearchParams) {
  if (!searchParams.has('customField')) return undefined

  const values = searchParams.getAll('customField').flatMap((value) => {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'object' && parsed !== null ? [parsed] : []
    } catch {
      return []
    }
  })
  return values.length > 0 ? values : undefined
}

function appendValues(searchParams: URLSearchParams, key: string, values: string[]) {
  for (const value of [...new Set(values)].sort()) {
    searchParams.append(key, value)
  }
}

function appendFilterValues(
  searchParams: URLSearchParams,
  key: string,
  value: unknown,
) {
  if (!Array.isArray(value)) return
  const values = readStringArray(value)
  if (values.length === 0) {
    searchParams.append(key, '')
    return
  }
  appendValues(searchParams, key, values)
}

function readRepeated(searchParams: URLSearchParams, key: string) {
  return [...new Set(
    searchParams.getAll(key).map((value) => value.trim()).filter(Boolean),
  )]
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function setValue(
  searchParams: URLSearchParams,
  key: string,
  value: string | undefined,
) {
  if (value) {
    searchParams.set(key, value)
  }
}

function readValue(searchParams: URLSearchParams, key: string) {
  return searchParams.get(key)?.trim() || undefined
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item))
    : []
}

function readUnknownArray(value: unknown) {
  return Array.isArray(value) ? value : []
}

function omitUndefinedValues(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  )
}
