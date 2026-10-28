import type { AgentRunReport, AgentRunView, FactoryBoardItem, FactoryBoardLane, TeamAgentRunBoardResponse } from '@mukuroji/contracts'
import { useId, useRef, useState, type MouseEvent } from 'react'
import { ChevronIcon, ClockIcon, ExternalLinkIcon } from '../../../shared/ui/icons'
import { readAgentRunDisplayState, type AgentRunDisplayState } from '../../../work-items/model/agentRunDisplay'
import { AgentRunReportChips } from '../../../work-items/ui/AgentRunReportChips'
import {
  FACTORY_BOARD_FILTER_ALL,
  FACTORY_BOARD_FILTER_NO_PROJECT,
  defaultFactoryBoardFilters,
  filterFactoryBoardItems,
  groupFactoryBoardItems,
  isFactoryBoardIncomplete,
  readFactoryBoardAssigneeLabel,
  readFactoryBoardFilterOptions,
  readLeaseMinutesRemaining,
  type FactoryBoardFilters,
} from '../model/factoryBoard'
import { groupFactoryLineItems, type FactoryLineEntry, type FactoryLineStation } from '../model/factoryLine'
import type { FactoryBoardLabels } from './factoryBoardLabels'
import { FactoryLine } from './FactoryLine'

/** State of the selected Work Item's reports, read separately from the board. */
export type FactoryBoardReportsState = {
  /** Reports of the Work Item, newest first, once loaded. */
  items?: readonly AgentRunReport[]
  /** Whether older reports exist beyond the loaded ones. */
  hasMore?: boolean
  /** Whether the first read is in progress. */
  isLoading: boolean
  /** Safe failure text, when the read failed. */
  errorMessage?: string
  /** Reads the reports again. */
  onRetry?: () => void
}

/** How the board shows its items: lanes by the decision they need, or a factory line by station. */
export type FactoryBoardView = 'lanes' | 'line'

/** Views in the order the switch offers them. */
const factoryBoardViews: readonly FactoryBoardView[] = ['lanes', 'line']

/** Props of the pure Factory board view. */
export type FactoryBoardProps = {
  /** View to show; lanes when absent. */
  view?: FactoryBoardView
  /** Switches the view; the switch is hidden when absent. */
  onViewChange?: (view: FactoryBoardView) => void
  /** Board data, once loaded. */
  board?: TeamAgentRunBoardResponse
  /** Whether the first read is in progress. */
  isLoading: boolean
  /** Safe failure text of the board read; shown instead of an empty board. */
  errorMessage?: string
  /** Whether a background read is in progress. */
  isRefreshing?: boolean
  /** Reads the board again. */
  onRefresh: () => void
  /** Locale-aware text. */
  labels: FactoryBoardLabels
  /** Project names by ID, for filters and details. */
  projectNames: Readonly<Record<string, string>>
  /** Formats an ISO 8601 timestamp for display. */
  formatDateTime: (value: string) => string
  /** Work Item whose detail is open. */
  selectedWorkItemId?: string
  /** Opens or closes a Work Item's detail. */
  onSelect: (workItemId: string | undefined) => void
  /** Reports of the selected Work Item. */
  reports: FactoryBoardReportsState
  /** Releases an active run; omitted when releasing is not wired. */
  onRelease?: (run: AgentRunView) => Promise<void>
  /** Builds the in-app link of a Work Item. */
  getWorkItemHref: (item: FactoryBoardItem) => string
  /** Opens an in-app link without reloading the page. */
  onNavigate: (href: string) => void
  /** Filters applied on first render, for stories and deep links. */
  initialFilters?: FactoryBoardFilters
  /** Station the line view follows on first render, for stories. */
  initialFocusedStation?: FactoryLineStation
}

/** Color treatments of each lane; state names always accompany the color. */
const laneStyles: Record<FactoryBoardLane, { /** Marker color. */ marker: string; /** Readable text color. */ text: string }> = {
  processing: { marker: 'bg-blue-600', text: 'text-fg-blue-700' },
  'no-run': { marker: 'bg-slate-400', text: 'text-fg-slate-600' },
  decision: { marker: 'bg-amber-500', text: 'text-fg-amber-800' },
  stalled: { marker: 'bg-amber-700', text: 'text-fg-amber-800' },
  failed: { marker: 'bg-red-600', text: 'text-fg-red-700' },
  completed: { marker: 'bg-emerald-600', text: 'text-fg-emerald-700' },
}

/** Badge class of each run display state. */
const runStateBadgeClasses: Record<AgentRunDisplayState, string> = {
  running: 'workbench-badge-primary',
  stalled: 'workbench-badge-warning',
  completed: 'workbench-badge-success',
  paused: 'workbench-badge',
  failed: 'workbench-badge-danger',
  released: 'workbench-badge',
  superseded: 'workbench-badge',
}

/** Lanes rendered as their own section; the run-less group closes the processing lane. */
const sectionLanes: readonly FactoryBoardLane[] = ['processing', 'decision', 'stalled', 'failed', 'completed']

/**
 * Checks whether a click should stay with the browser, such as a new-tab or modified click.
 *
 * @param event - Click event.
 * @returns True when the browser should handle the click.
 */
function isBrowserHandledClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

/**
 * Shows a Team's Agent Runs in lanes by the decision they need, with a detail pane for one Work Item.
 * Lanes are evaluated at the board's read time with the shared contract rule. Desktop shows the
 * detail beside the lanes; phone switches between the lanes and the detail with a back action.
 *
 * @param props - Board data, text, selection, and actions.
 * @returns Board.
 */
export function FactoryBoard({
  board,
  errorMessage,
  formatDateTime,
  getWorkItemHref,
  initialFilters = defaultFactoryBoardFilters,
  initialFocusedStation,
  isLoading,
  isRefreshing = false,
  labels,
  onNavigate,
  onRefresh,
  onRelease,
  onSelect,
  projectNames,
  reports,
  selectedWorkItemId,
  view = 'lanes',
  onViewChange,
}: FactoryBoardProps) {
  const [filters, setFilters] = useState(initialFilters)
  const [focusedStation, setFocusedStation] = useState(initialFocusedStation)
  const detailId = useId()
  const lanesRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  const items = board?.items ?? []
  const now = new Date(board?.generatedAt ?? 0)
  const visible = filterFactoryBoardItems(items, filters)
  const groups = groupFactoryBoardItems(visible, now)
  const allGroups = groupFactoryBoardItems(items, now)
  /**
   * Reads the visible tiles of one lane.
   *
   * @param lane - Lane.
   * @returns Tiles after the filters.
   */
  const laneItems = (lane: FactoryBoardLane) => groups.find((group) => group.lane === lane)?.items ?? []
  /**
   * Counts every tile of one lane, ignoring the filters.
   *
   * @param lane - Lane.
   * @returns Tile count.
   */
  const countLane = (lane: FactoryBoardLane) => allGroups.find((group) => group.lane === lane)?.items.length ?? 0
  const selected = visible.find((item) => item.workItem.id === selectedWorkItemId)
  const lineGroups = view === 'line' ? groupFactoryLineItems(visible, now) : []
  const options = readFactoryBoardFilterOptions(items, filters)

  /**
   * Opens a tile's detail and, on phone where the lanes give way to the detail, moves focus to it.
   *
   * @param workItemId - Selected Work Item.
   */
  const select = (workItemId: string) => {
    onSelect(workItemId)
    requestAnimationFrame(() => {
      if (lanesRef.current && lanesRef.current.getClientRects().length === 0) detailRef.current?.focus()
    })
  }

  /** Returns from the phone detail to the lanes and focuses the tile that opened it. */
  const back = () => {
    const previous = selectedWorkItemId
    onSelect(undefined)
    requestAnimationFrame(() => {
      const tile = Array.from(lanesRef.current?.querySelectorAll<HTMLButtonElement>('[data-factory-board-item]') ?? [])
        .find((candidate) => candidate.dataset.factoryBoardItem === previous)
      tile?.focus()
    })
  }

  /**
   * Updates one filter and closes a detail the new filters would hide.
   *
   * @param next - New filters.
   */
  const changeFilters = (next: FactoryBoardFilters) => {
    setFilters(next)
    if (selectedWorkItemId !== undefined && !filterFactoryBoardItems(items, next).some((item) => item.workItem.id === selectedWorkItemId)) {
      onSelect(undefined)
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-3" data-testid="factory-board">
      <div className="flex flex-wrap items-end gap-3 border-b border-[var(--workbench-border)] pb-3">
        <p className="min-w-0 flex-1 basis-full text-xs font-medium text-[var(--workbench-muted)] min-[760px]:basis-auto" role="status">
          {board
            ? labels.summary
              .replace('{processing}', String(countLane('processing') + countLane('no-run')))
              .replace('{decision}', String(countLane('decision')))
              .replace('{stalled}', String(countLane('stalled')))
            : null}
        </p>
        <fieldset aria-label={labels.filterLabel} className="flex min-w-0 flex-wrap items-end gap-2">
          <FilterSelect
            label={labels.filterRuntime}
            onChange={(value) => changeFilters({ ...filters, runtime: options.runtimes.find((runtime) => runtime === value) ?? FACTORY_BOARD_FILTER_ALL })}
            options={[{ value: FACTORY_BOARD_FILTER_ALL, label: labels.filterAll }, ...options.runtimes.map((runtime) => ({ value: runtime, label: labels.runs.runtimes[runtime] }))]}
            value={filters.runtime}
          />
          <FilterSelect
            label={labels.filterAssignee}
            onChange={(value) => changeFilters({ ...filters, assigneeUserId: value })}
            options={[{ value: FACTORY_BOARD_FILTER_ALL, label: labels.filterAll }, ...options.assignees.map((assignee) => ({ value: assignee.userId, label: assignee.label }))]}
            value={filters.assigneeUserId}
          />
          <FilterSelect
            label={labels.filterProject}
            onChange={(value) => changeFilters({ ...filters, projectId: value })}
            options={[
              { value: FACTORY_BOARD_FILTER_ALL, label: labels.filterAll },
              ...options.projectIds.map((projectId) => ({ value: projectId, label: projectNames[projectId] ?? projectId })),
              ...(options.hasUnassignedProject ? [{ value: FACTORY_BOARD_FILTER_NO_PROJECT, label: labels.filterNoProject }] : []),
            ]}
            value={filters.projectId}
          />
        </fieldset>
        {onViewChange ? (
          <div aria-label={labels.viewLabel} className="flex rounded-md border border-[var(--workbench-border)] p-0.5" role="group">
            {factoryBoardViews.map((option) => (
              <button
                aria-pressed={view === option}
                className={`min-h-[40px] rounded px-3 text-sm font-semibold ${view === option ? 'bg-[var(--workbench-primary-surface)] text-[var(--workbench-primary-text)]' : 'text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'}`}
                key={option}
                onClick={() => onViewChange(option)}
                type="button"
              >
                {option === 'lanes' ? labels.viewLanes : labels.viewLine}
              </button>
            ))}
          </div>
        ) : null}
        <button
          className="workbench-button-secondary min-h-[44px] px-3"
          disabled={isRefreshing}
          onClick={onRefresh}
          type="button"
        >
          {labels.refresh}
        </button>
      </div>

      {errorMessage ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{errorMessage}</span>
          <button className="workbench-button-secondary min-h-[44px] px-3" onClick={onRefresh} type="button">{labels.retry}</button>
        </div>
      ) : null}

      {board && isFactoryBoardIncomplete(board) ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-fg-amber-800" role="note">{labels.incomplete}</p>
      ) : null}

      {!board ? (
        isLoading ? <p className="py-8 text-sm font-medium text-[var(--workbench-muted)]" role="status">{labels.loading}</p> : null
      ) : items.length === 0 ? (
        <div className="grid place-content-center gap-2 px-4 py-12 text-center">
          <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{labels.empty}</h2>
          <p className="max-w-sm text-sm leading-6 text-[var(--workbench-muted)]">{labels.emptyDescription}</p>
        </div>
      ) : view === 'line' ? (
        <div className="grid min-h-0 min-w-0 gap-4 min-[1000px]:grid-cols-[minmax(0,1fr)_340px] min-[1280px]:grid-cols-[minmax(0,1fr)_380px]">
          <FactoryLine
            focusedStation={focusedStation}
            groups={lineGroups}
            idPrefix={`${detailId}-line`}
            labels={labels.line}
            onFocusStation={setFocusedStation}
            {...(selected ? { selectedWorkItemId: selected.workItem.id } : {})}
          />
          <aside
            aria-label={labels.detailLabel}
            className="min-w-0 rounded-lg border border-[var(--workbench-border)] bg-surface p-4 min-[1000px]:sticky min-[1000px]:top-0 min-[1000px]:max-h-[calc(100svh-12rem)] min-[1000px]:overflow-y-auto"
            id={detailId}
            ref={detailRef}
            tabIndex={-1}
          >
            {selected ? (
              <>
                <button className="mb-3 flex min-h-[44px] items-center gap-1 text-sm font-medium text-fg-teal-700" onClick={() => onSelect(undefined)} type="button">
                  <ChevronIcon className="size-4 rotate-90 fill-none stroke-current stroke-2" />{labels.line.backToStation}
                </button>
                <FactoryBoardDetail
                  formatDateTime={formatDateTime}
                  item={selected}
                  key={selected.workItem.id}
                  labels={labels}
                  lane={groups.find((group) => group.items.includes(selected))?.lane}
                  now={now}
                  onNavigate={onNavigate}
                  onRelease={onRelease}
                  projectNames={projectNames}
                  reports={reports}
                  workItemHref={getWorkItemHref(selected)}
                />
              </>
            ) : (
              <StationPanel
                detailId={detailId}
                entries={focusedStation === undefined ? undefined : lineGroups.find((group) => group.station === focusedStation)?.entries ?? []}
                formatDateTime={formatDateTime}
                labels={labels}
                now={now}
                onSelect={(workItemId) => onSelect(workItemId)}
                station={focusedStation}
              />
            )}
          </aside>
        </div>
      ) : (
        <div className="grid min-h-0 min-w-0 gap-4 min-[1000px]:grid-cols-[minmax(0,1fr)_340px] min-[1280px]:grid-cols-[minmax(0,1fr)_380px]">
          <div className={`${selected ? 'hidden min-[1000px]:block' : 'block'} min-w-0`} ref={lanesRef}>
            {visible.length === 0 ? (
              <p className="py-8 text-sm text-[var(--workbench-muted)]" role="status">{labels.noResults}</p>
            ) : sectionLanes.map((lane) => (
              <section aria-label={labels.lanes[lane]} className="mb-4 border-b border-[var(--workbench-border)] pb-4 last:mb-0 last:border-0" key={lane}>
                <LaneHeading count={laneItems(lane).length + (lane === 'processing' ? laneItems('no-run').length : 0)} label={labels.lanes[lane]} lane={lane} />
                {laneItems(lane).length === 0 && (lane !== 'processing' || laneItems('no-run').length === 0) ? (
                  <p className="py-2 pl-3 text-xs text-[var(--workbench-muted)]">{labels.laneEmpty}</p>
                ) : (
                  <TileGrid
                    detailId={detailId}
                    formatDateTime={formatDateTime}
                    items={laneItems(lane)}
                    labels={labels}
                    lane={lane}
                    now={now}
                    onSelect={select}
                    selectedWorkItemId={selected?.workItem.id}
                  />
                )}
                {lane === 'processing' && laneItems('no-run').length > 0 ? (
                  <div className="mt-3 grid gap-2 border-t border-dashed border-[var(--workbench-border)] pt-3" data-testid="factory-board-no-run">
                    <div>
                      <h3 className="text-xs font-semibold text-[var(--workbench-text)]">{labels.lanes['no-run']}</h3>
                      <p className="text-xs text-[var(--workbench-muted)]">{labels.noRunDescription}</p>
                    </div>
                    <TileGrid
                      detailId={detailId}
                      formatDateTime={formatDateTime}
                      items={laneItems('no-run')}
                      labels={labels}
                      lane="no-run"
                      now={now}
                      onSelect={select}
                      selectedWorkItemId={selected?.workItem.id}
                    />
                  </div>
                ) : null}
              </section>
            ))}
          </div>
          <aside
            aria-label={labels.detailLabel}
            className={`${selected ? 'block' : 'hidden min-[1000px]:block'} min-w-0 rounded-lg border border-[var(--workbench-border)] bg-surface p-4 min-[1000px]:sticky min-[1000px]:top-0 min-[1000px]:max-h-[calc(100svh-12rem)] min-[1000px]:overflow-y-auto`}
            id={detailId}
            ref={detailRef}
            tabIndex={-1}
          >
            {selected ? (
              <>
                <button className="mb-3 flex min-h-[44px] items-center gap-1 text-sm font-medium text-fg-teal-700 min-[1000px]:hidden" onClick={back} type="button">
                  <ChevronIcon className="size-4 rotate-90 fill-none stroke-current stroke-2" />{labels.back}
                </button>
                <FactoryBoardDetail
                  formatDateTime={formatDateTime}
                  item={selected}
                  key={selected.workItem.id}
                  labels={labels}
                  lane={groups.find((group) => group.items.includes(selected))?.lane}
                  now={now}
                  onNavigate={onNavigate}
                  onRelease={onRelease}
                  projectNames={projectNames}
                  reports={reports}
                  workItemHref={getWorkItemHref(selected)}
                />
              </>
            ) : (
              <p className="text-sm text-[var(--workbench-muted)]">{labels.detailPlaceholder}</p>
            )}
          </aside>
        </div>
      )}
    </section>
  )
}

/**
 * Shows what one station of the line holds: its name and purpose, then each task with its assignee,
 * agent, latest report, and time. Without a chosen station it explains the line.
 *
 * @param props - Station, its tasks, and text.
 * @returns Station panel.
 */
function StationPanel({ detailId, entries, formatDateTime, labels, now, onSelect, station }: {
  /** ID of the detail pane the tasks control. */
  detailId: string
  /** Tasks at the station; absent when no station is chosen. */
  entries: readonly FactoryLineEntry[] | undefined
  /** Formats an ISO 8601 timestamp. */
  formatDateTime: (value: string) => string
  /** Board text. */
  labels: FactoryBoardLabels
  /** Board read time. */
  now: Date
  /** Opens a task's detail. */
  onSelect: (workItemId: string) => void
  /** Station the camera follows. */
  station: FactoryLineStation | undefined
}) {
  if (station === undefined || entries === undefined) {
    return (
      <div className="grid gap-2">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.line.overviewTitle}</h2>
        <p className="text-sm leading-6 text-[var(--workbench-muted)]">{labels.line.overviewDescription}</p>
      </div>
    )
  }
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">
          {labels.line.stations[station]}
          <span className="ml-2 text-xs font-medium tabular-nums text-[var(--workbench-muted)]">{labels.line.count.replace('{count}', String(entries.length))}</span>
        </h2>
        <p className="text-sm leading-6 text-[var(--workbench-muted)]">{labels.line.stationDescriptions[station]}</p>
      </div>
      {entries.length === 0 ? <p className="text-sm text-[var(--workbench-muted)]">{labels.line.empty}</p> : (
        <ul className="grid gap-2">
          {entries.map(({ item, stalled }) => (
            <li key={item.workItem.id}>
              <button
                aria-controls={detailId}
                className="flex w-full min-w-0 flex-col rounded-lg border border-[var(--workbench-border)] bg-surface p-3 text-left hover:border-[var(--workbench-border-strong)]"
                data-factory-line-item={item.workItem.id}
                onClick={() => onSelect(item.workItem.id)}
                type="button"
              >
                <span className="break-words text-sm font-semibold leading-6 text-[var(--workbench-text)]">{item.workItem.title}</span>
                <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-[var(--workbench-muted)]">
                  <span>{readFactoryBoardAssigneeLabel(item.workItem)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-semibold text-[var(--workbench-text)]">{item.run ? item.run.agentName : labels.line.noAgent}</span>
                  {item.run && item.run.agentName !== labels.runs.runtimes[item.run.runtime] ? <span className="workbench-badge">{labels.runs.runtimes[item.run.runtime]}</span> : null}
                  {stalled ? <span className="workbench-badge-warning">{labels.line.stalled}</span> : null}
                </span>
                {item.run ? <ReportSummary item={item} labels={labels} /> : null}
                {item.run ? (
                  <span className="mt-2 flex items-center gap-1 text-xs tabular-nums text-[var(--workbench-muted)]">
                    <ClockIcon className="size-3.5 shrink-0 fill-none stroke-current stroke-2" />
                    <RunTime formatDateTime={formatDateTime} labels={labels} now={now} run={item.run} />
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Shows one labeled filter select.
 *
 * @param props - Label, choices, and selection.
 * @returns Select field.
 */
function FilterSelect({ label, onChange, options, value }: {
  /** Visible label. */
  label: string
  /** Receives the chosen value. */
  onChange: (value: string) => void
  /** Choices in display order. */
  options: ReadonlyArray<{ /** Choice value. */ value: string; /** Choice text. */ label: string }>
  /** Selected value. */
  value: string
}) {
  return (
    <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <select
        className="min-h-[44px] min-w-0 max-w-[14rem] rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 text-sm font-medium text-[var(--workbench-text)]"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}

/**
 * Shows a lane name with its marker and count.
 *
 * @param props - Lane, name, and count.
 * @returns Heading row.
 */
function LaneHeading({ count, label, lane }: {
  /** Number of tiles in the lane. */
  count: number
  /** Lane name. */
  label: string
  /** Lane. */
  lane: FactoryBoardLane
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span aria-hidden="true" className={`h-4 w-1 rounded-sm ${laneStyles[lane].marker}`} />
      <h2 className="text-sm font-semibold text-[var(--workbench-text)]">{label}</h2>
      <span className="ml-1 text-xs tabular-nums text-[var(--workbench-muted)]">{count}</span>
    </div>
  )
}

/** Props shared by the tiles of one lane. */
type TileGridProps = {
  /** ID of the detail pane the tiles control. */
  detailId: string
  /** Formats an ISO 8601 timestamp. */
  formatDateTime: (value: string) => string
  /** Tiles in display order. */
  items: readonly FactoryBoardItem[]
  /** Board text. */
  labels: FactoryBoardLabels
  /** Lane of the tiles. */
  lane: FactoryBoardLane
  /** Board read time. */
  now: Date
  /** Opens a tile's detail. */
  onSelect: (workItemId: string) => void
  /** Work Item whose detail is open. */
  selectedWorkItemId?: string
}

/**
 * Shows the tiles of one lane in a responsive grid.
 *
 * @param props - Tiles, lane, and selection.
 * @returns Tile grid.
 */
function TileGrid({ detailId, formatDateTime, items, labels, lane, now, onSelect, selectedWorkItemId }: TileGridProps) {
  return (
    <div className="grid gap-2 min-[640px]:grid-cols-2 min-[1280px]:grid-cols-3">
      {items.map((item) => {
        const isSelected = item.workItem.id === selectedWorkItemId
        return (
          <button
            aria-controls={detailId}
            aria-pressed={isSelected}
            className={`flex min-w-0 flex-col justify-start rounded-lg border bg-surface p-3 text-left transition-colors ${isSelected ? 'border-teal-600 ring-1 ring-teal-600' : 'border-[var(--workbench-border)] hover:border-[var(--workbench-border-strong)]'}`}
            data-factory-board-item={item.workItem.id}
            key={item.workItem.id}
            onClick={() => onSelect(item.workItem.id)}
            type="button"
          >
            <p className={`flex items-center gap-1.5 text-xs font-medium ${laneStyles[lane].text}`}>
              <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${laneStyles[lane].marker}`} />
              {labels.lanes[lane]}
            </p>
            <p className="mt-2 break-words text-sm font-semibold leading-6 text-[var(--workbench-text)]">{item.workItem.title}</p>
            {item.run ? (
              <p className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-[var(--workbench-muted)]">
                <span className="truncate font-semibold text-[var(--workbench-text)]">{item.run.agentName}</span>
                {item.run.agentName !== labels.runs.runtimes[item.run.runtime] ? <span className="workbench-badge">{labels.runs.runtimes[item.run.runtime]}</span> : null}
              </p>
            ) : null}
            {item.run ? <ReportSummary item={item} labels={labels} /> : null}
            {item.run ? (
              <p className="mt-3 flex items-center gap-1 text-xs tabular-nums text-[var(--workbench-muted)]">
                <ClockIcon className="size-3.5 shrink-0 fill-none stroke-current stroke-2" />
                <RunTime formatDateTime={formatDateTime} labels={labels} now={now} run={item.run} />
              </p>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Shows the latest report of a tile's run: its kind, the start of its message, and its checks.
 *
 * @param props - Item and text.
 * @returns Report summary.
 */
function ReportSummary({ item, labels }: {
  /** Board item with a run. */
  item: FactoryBoardItem
  /** Board text. */
  labels: FactoryBoardLabels
}) {
  const report = item.latestReport
  if (!report) return <p className="mt-2 text-xs text-[var(--workbench-muted)]">{labels.noReport}</p>
  const asksForDecision = report.kind === 'blocker' || report.kind === 'handoff'
  const checks = report.verificationCounts.passed + report.verificationCounts.failed
  return (
    <div className="mt-2 grid gap-1">
      <p className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className={asksForDecision ? 'workbench-badge-warning' : 'workbench-badge'}>{labels.reportChips.kinds[report.kind]}</span>
        {checks > 0 ? (
          <span className="text-[var(--workbench-muted)]">
            {labels.verifications
              .replace('{passed}', String(report.verificationCounts.passed))
              .replace('{failed}', String(report.verificationCounts.failed))}
          </span>
        ) : null}
      </p>
      {report.excerpt ? <p className="line-clamp-2 break-words text-xs leading-5 text-[var(--workbench-text)]">{report.excerpt}</p> : null}
    </div>
  )
}

/**
 * Shows the time that matters for a run: the lease left or overdue while active, otherwise when it
 * finished.
 *
 * @param props - Run, read time, and text.
 * @returns Time text.
 */
function RunTime({ formatDateTime, labels, now, run }: {
  /** Formats an ISO 8601 timestamp. */
  formatDateTime: (value: string) => string
  /** Board text. */
  labels: FactoryBoardLabels
  /** Board read time. */
  now: Date
  /** Run to describe. */
  run: AgentRunView
}) {
  if (run.state === 'active') {
    const minutes = readLeaseMinutesRemaining(run.leaseExpiresAt, now)
    return (
      <time dateTime={run.leaseExpiresAt}>
        {minutes > 0
          ? labels.leaseRemaining.replace('{minutes}', String(minutes))
          : labels.leaseExpired.replace('{minutes}', String(Math.abs(minutes)))}
      </time>
    )
  }
  return run.finishedAt
    ? <time dateTime={run.finishedAt}>{labels.finishedAt.replace('{time}', formatDateTime(run.finishedAt))}</time>
    : null
}

/** Props of the detail pane. */
type FactoryBoardDetailProps = Pick<FactoryBoardProps, 'formatDateTime' | 'labels' | 'onNavigate' | 'onRelease' | 'projectNames' | 'reports'> & {
  /** Selected item. */
  item: FactoryBoardItem
  /** Lane of the item at the read time. */
  lane?: FactoryBoardLane
  /** Board read time. */
  now: Date
  /** In-app link of the Work Item. */
  workItemHref: string
}

/**
 * Shows one Work Item's run: its state, times, start revision, latest report, report timeline with
 * checks and artifacts, and the only two actions the board offers, release and open.
 *
 * @param props - Item, reports, text, and actions.
 * @returns Detail content.
 */
function FactoryBoardDetail({ formatDateTime, item, labels, lane, now, onNavigate, onRelease, projectNames, reports, workItemHref }: FactoryBoardDetailProps) {
  const [isReleasing, setIsReleasing] = useState(false)
  const [releaseFailed, setReleaseFailed] = useState(false)
  const { run, workItem } = item
  const runReports = run ? (reports.items ?? []).filter((report) => report.runId === run.runId) : []
  const displayState = run ? readAgentRunDisplayState(run) : undefined

  /** Releases the active run after the viewer confirms it. */
  const release = async () => {
    if (!run || !onRelease || !window.confirm(labels.runs.releaseConfirm)) return
    setIsReleasing(true)
    setReleaseFailed(false)
    try {
      await onRelease(run)
    } catch {
      setReleaseFailed(true)
    } finally {
      setIsReleasing(false)
    }
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="min-w-0">
        {lane ? (
          <p className={`flex items-center gap-1.5 text-xs font-semibold ${laneStyles[lane].text}`}>
            <span aria-hidden="true" className={`size-2 rounded-full ${laneStyles[lane].marker}`} />{labels.lanes[lane]}
          </p>
        ) : null}
        <h2 className="mt-2 break-words text-lg font-semibold leading-7 text-[var(--workbench-text)]">{workItem.title}</h2>
        <dl className="mt-2 grid gap-1 text-xs">
          <DetailField label={labels.assignee} value={readFactoryBoardAssigneeLabel(workItem)} />
          {workItem.assignedProjectId ? (
            <DetailField label={labels.filterProject} value={projectNames[workItem.assignedProjectId] ?? workItem.assignedProjectId} />
          ) : null}
        </dl>
      </div>

      <div className="flex flex-wrap gap-2">
        <a
          className="workbench-button-primary flex min-h-[44px] items-center justify-center gap-2 px-3"
          href={workItemHref}
          onClick={(event) => {
            if (isBrowserHandledClick(event)) return
            event.preventDefault()
            onNavigate(workItemHref)
          }}
        >
          {labels.openWorkItem}<ExternalLinkIcon className="size-4 fill-none stroke-current stroke-2" />
        </a>
        {run?.state === 'active' && run.canRelease && onRelease ? (
          <button className="workbench-button-secondary min-h-[44px] px-3" disabled={isReleasing} onClick={() => { void release() }} type="button">
            {labels.runs.release}
          </button>
        ) : null}
      </div>
      {releaseFailed ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">{labels.runs.releaseError}</p>
      ) : null}

      {run && displayState ? (
        <div className="grid min-w-0 gap-2 border-y border-[var(--workbench-border)] py-3">
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={runStateBadgeClasses[displayState]}>{labels.runs.states[displayState]}</span>
            <span className="truncate text-sm font-semibold text-[var(--workbench-text)]">{run.agentName}</span>
            {run.agentName !== labels.runs.runtimes[run.runtime] ? <span className="workbench-badge">{labels.runs.runtimes[run.runtime]}</span> : null}
          </p>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <DetailField label={labels.startRevision} value={String(run.startRevision)} />
            <DetailField label={labels.runs.startedAt} value={formatDateTime(run.startedAt)} />
            <DetailField label={labels.runs.lastActivity} value={formatDateTime(run.lastHeartbeatAt)} />
            {run.state === 'active'
              ? <DetailField label={labels.runs.leaseExpiresAt} value={formatDateTime(run.leaseExpiresAt)} />
              : run.finishedAt ? <DetailField label={labels.runs.finishedAt} value={formatDateTime(run.finishedAt)} /> : null}
          </dl>
          {run.state === 'active' && readLeaseMinutesRemaining(run.leaseExpiresAt, now) <= 0 ? (
            <p className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.runs.stalledHint}</p>
          ) : null}
          {item.latestReport?.excerpt ? (
            <div className="grid gap-1">
              <h3 className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.latestReport}</h3>
              <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--workbench-text)]">{item.latestReport.excerpt}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="border-y border-[var(--workbench-border)] py-3 text-sm leading-6 text-[var(--workbench-muted)]">{labels.noRunDetail}</p>
      )}

      {run ? (
        <div className="grid min-w-0 gap-2">
          <h3 className="flex items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            <ClockIcon className="size-4 fill-none stroke-current stroke-2" />{labels.reports}
          </h3>
          {reports.errorMessage ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-fg-red-700" role="alert">
              <span>{reports.errorMessage}</span>
              {reports.onRetry ? <button className="workbench-button-secondary min-h-[44px] px-3" onClick={reports.onRetry} type="button">{labels.retry}</button> : null}
            </div>
          ) : reports.isLoading && !reports.items ? (
            <p className="text-xs text-[var(--workbench-muted)]" role="status">{labels.reportsLoading}</p>
          ) : runReports.length === 0 ? (
            <p className="text-xs text-[var(--workbench-muted)]">{labels.reportsEmpty}</p>
          ) : (
            <ol className="border-l border-[var(--workbench-border)] pl-4">
              {runReports.map((report) => (
                <li className="relative pb-4 last:pb-0" key={`${report.runId}-${report.sequence}`}>
                  <span aria-hidden="true" className="absolute -left-[20px] top-1.5 size-[7px] rounded-full bg-[var(--workbench-border-strong)]" />
                  <time className="block text-xs tabular-nums text-[var(--workbench-muted)]" dateTime={report.createdAt}>{formatDateTime(report.createdAt)}</time>
                  <AgentRunReportChips labels={labels.reportChips} report={report} />
                </li>
              ))}
            </ol>
          )}
          {reports.hasMore && runReports.length > 0 ? <p className="text-xs text-[var(--workbench-muted)]">{labels.reportsTruncated}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Shows one labeled value of the detail.
 *
 * @param props - Label and value.
 * @returns Definition list entry.
 */
function DetailField({ label, value }: {
  /** Field label. */
  label: string
  /** Display value. */
  value: string
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="truncate font-medium text-[var(--workbench-text)]">{value}</dd>
    </div>
  )
}
