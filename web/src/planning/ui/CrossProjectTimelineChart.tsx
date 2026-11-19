import type {
  PlanningDependency,
  PlanningEntity,
  PlanningEntityType,
  WorkItemAffectedProject,
} from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import {
  CROSS_PROJECT_TIMELINE_ENTITY_ROW_HEIGHT,
  CROSS_PROJECT_TIMELINE_GROUP_ROW_HEIGHT,
  createCrossProjectTimelineChart,
  formatLocalCalendarDate,
  type CrossProjectTimelineDirectoryTeam,
  type CrossProjectTimelineEntityRow,
  type CrossProjectTimelineGrouping,
} from '../model/crossProjectTimeline'

/** Localized labels used by the cross-Project timeline chart. */
export type CrossProjectTimelineLabels = {
  /** Section heading. */
  title: string
  /** Section description. */
  description: string
  /** Accessible label of the grouping selector. */
  groupBy: string
  /** Option that groups rows by Project. */
  groupByProject: string
  /** Option that groups rows by Portfolio. */
  groupByPortfolio: string
  /** Group label for entities without a Team or Project scope. */
  workspaceGroup: string
  /** Group label for entities without a Portfolio ancestor. */
  noPortfolioGroup: string
  /** Legend and line label for today. */
  today: string
  /** Legend label for the forecast bar. */
  forecastLegend: string
  /** Legend label for the baseline bar. */
  baselineLegend: string
  /** Legend label for dependency lines. */
  dependencyLegend: string
  /** Action that opens a Project from its group header. */
  openProject: string
  /** Text for a non-zero forecast drift against the baseline end. */
  variance: (days: number) => string
  /** Summary of how many Projects the chart compares. */
  projectCount: (count: number) => string
  /** Message shown when no timeline entity has drawable dates. */
  empty: string
}

/** Props for {@link CrossProjectTimelineChart}. */
export type CrossProjectTimelineChartProps = {
  /** Planning entities already filtered to what the viewer may read. */
  entities: readonly PlanningEntity[]
  /** Planning dependencies from the same snapshot. */
  dependencies: readonly PlanningDependency[]
  /** Project directory used to name Project groups. */
  directory?: readonly CrossProjectTimelineDirectoryTeam[]
  /** Entity IDs on the critical path. */
  criticalEntityIds: ReadonlySet<string>
  /** Localized chart labels. */
  labels: CrossProjectTimelineLabels
  /** Localized entity type names. */
  entityTypes: Record<PlanningEntityType, string>
  /** Today's date in `YYYY-MM-DD` form; the viewer's local date is used when omitted. */
  today?: string
  /** Whether row selection is temporarily disabled. */
  disabled?: boolean
  /** Selects an entity in the Planning screen. */
  onSelectEntity: (entityId: string) => void
  /** Opens a Project overview from its group header. */
  onOpenProject?: (project: WorkItemAffectedProject) => void
}

/**
 * Draws Phase, Milestone, Cycle, and Release entities of every visible Project on one time axis.
 *
 * The chart is read-only: it shows forecast bars over baseline bars, dependency lines,
 * and a today line, and lets the viewer open a Project or select an entity.
 *
 * @param props - Visible entities, dependencies, labels, and navigation callbacks.
 * @returns The chart section.
 */
export function CrossProjectTimelineChart({
  criticalEntityIds,
  dependencies,
  directory,
  disabled = false,
  entities,
  entityTypes,
  labels,
  onOpenProject,
  onSelectEntity,
  today,
}: CrossProjectTimelineChartProps) {
  const [grouping, setGrouping] = useState<CrossProjectTimelineGrouping>('project')
  const resolvedToday = today ?? formatLocalCalendarDate(new Date())
  const chart = useMemo(() => createCrossProjectTimelineChart({
    dependencies,
    directory,
    entities,
    grouping,
    noPortfolioLabel: labels.noPortfolioGroup,
    today: resolvedToday,
    workspaceLabel: labels.workspaceGroup,
  }), [dependencies, directory, entities, grouping, labels, resolvedToday])

  return (
    <section className="workbench-panel overflow-hidden" data-testid="planning-cross-project-timeline">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.title}</h2>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">{labels.description}</p>
          {chart ? (
            <p className="mt-1 text-xs font-semibold text-[var(--workbench-muted)]" data-testid="cross-project-timeline-project-count">
              {labels.projectCount(chart.projectCount)} · {chart.startDate} – {chart.endDate}
            </p>
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {labels.groupBy}
          <select
            className="workbench-input h-9 px-3"
            data-testid="cross-project-timeline-grouping"
            value={grouping}
            onChange={(event) => setGrouping(event.target.value === 'portfolio' ? 'portfolio' : 'project')}
          >
            <option value="project">{labels.groupByProject}</option>
            <option value="portfolio">{labels.groupByPortfolio}</option>
          </select>
        </label>
      </div>
      {chart ? (
        <>
          <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
            <div className="grid min-w-[960px] grid-cols-[240px_minmax(0,1fr)]">
              <div className="h-8 border-b border-r border-[var(--workbench-border)]" />
              <div aria-hidden="true" className="relative h-8 border-b border-[var(--workbench-border)]">
                {chart.ticks.map((tick) => (
                  <span
                    className="absolute top-2 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-[var(--workbench-muted)]"
                    key={tick.date}
                    style={{ left: `${tick.leftPercent}%` }}
                  >
                    {tick.date.slice(0, 7)}
                  </span>
                ))}
              </div>
              <div className="border-r border-[var(--workbench-border)]">
                {chart.rows.map((row) => row.kind === 'group' ? (
                  <div
                    className="flex items-center justify-between gap-2 bg-[var(--workbench-surface-muted)] px-3"
                    data-testid={`cross-project-timeline-group-${row.key}`}
                    key={`group:${row.key}`}
                    style={{ height: CROSS_PROJECT_TIMELINE_GROUP_ROW_HEIGHT }}
                  >
                    <span className="min-w-0 truncate text-xs font-bold text-[var(--workbench-text)]">
                      {row.label} <span className="font-semibold text-[var(--workbench-muted)]">({row.entityCount})</span>
                    </span>
                    {row.project && onOpenProject ? (
                      <button
                        className="shrink-0 text-xs font-semibold text-[var(--workbench-primary-text)] hover:underline"
                        data-testid={`cross-project-timeline-open-project-${row.project.projectId}`}
                        type="button"
                        onClick={() => row.project && onOpenProject(row.project)}
                      >
                        {labels.openProject}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <button
                    className="flex w-full min-w-0 flex-col justify-center px-3 text-left hover:bg-[var(--workbench-row-selected)] disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid={`cross-project-timeline-entity-${row.entity.id}`}
                    disabled={disabled}
                    key={row.entity.id}
                    style={{ height: CROSS_PROJECT_TIMELINE_ENTITY_ROW_HEIGHT }}
                    type="button"
                    onClick={() => onSelectEntity(row.entity.id)}
                  >
                    <span className="block truncate text-sm font-semibold text-[var(--workbench-text)]">{row.entity.title}</span>
                    <span className="block truncate text-[11px] font-semibold text-[var(--workbench-muted)]">
                      {row.scopeLabel ? `${row.scopeLabel} · ` : ''}
                      {entityTypes[row.entity.type]}
                      {row.endVarianceDays !== 0 ? ` · ${labels.variance(row.endVarianceDays)}` : ''}
                    </span>
                  </button>
                ))}
              </div>
              <div className="relative" style={{ height: chart.height }}>
                {chart.rows.map((row) => row.kind === 'group' ? (
                  <div
                    aria-hidden="true"
                    className="absolute inset-x-0 bg-[var(--workbench-surface-muted)]"
                    key={`group-band:${row.key}`}
                    style={{ height: CROSS_PROJECT_TIMELINE_GROUP_ROW_HEIGHT, top: row.top }}
                  />
                ) : null)}
                {chart.ticks.map((tick) => (
                  <div
                    aria-hidden="true"
                    className="absolute inset-y-0 w-px bg-[var(--workbench-gantt-grid)]"
                    key={`grid:${tick.date}`}
                    style={{ left: `${tick.leftPercent}%` }}
                  />
                ))}
                {chart.rows.map((row) => row.kind === 'entity' ? (
                  <TimelineBar
                    critical={criticalEntityIds.has(row.entity.id)}
                    disabled={disabled}
                    entityTypes={entityTypes}
                    key={`bar:${row.entity.id}`}
                    labels={labels}
                    row={row}
                    onSelectEntity={onSelectEntity}
                  />
                ) : null)}
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                  data-testid="cross-project-timeline-links"
                >
                  <defs>
                    <marker id="cross-project-timeline-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
                      <path d="M0,0 L6,3 L0,6 z" fill="var(--workbench-gantt-link)" />
                    </marker>
                    <marker id="cross-project-timeline-arrow-conflict" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
                      <path d="M0,0 L6,3 L0,6 z" fill="var(--workbench-gantt-link-conflict)" />
                    </marker>
                  </defs>
                  {chart.links.map((link) => (
                    <line
                      data-testid={`cross-project-timeline-link-${link.id}`}
                      data-violated={link.violated ? 'true' : 'false'}
                      key={link.id}
                      markerEnd={link.violated
                        ? 'url(#cross-project-timeline-arrow-conflict)'
                        : 'url(#cross-project-timeline-arrow)'}
                      stroke={link.violated ? 'var(--workbench-gantt-link-conflict)' : 'var(--workbench-gantt-link)'}
                      strokeDasharray={link.violated ? '4 3' : undefined}
                      strokeWidth="1.5"
                      x1={`${link.fromPercent}%`}
                      x2={`${link.toPercent}%`}
                      y1={link.fromY}
                      y2={link.toY}
                    />
                  ))}
                </svg>
                {chart.todayPercent === undefined ? null : (
                  <div
                    className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--workbench-danger)]"
                    data-testid="cross-project-timeline-today"
                    style={{ left: `${chart.todayPercent}%` }}
                    title={labels.today}
                  />
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 border-t border-[var(--workbench-border)] px-5 py-3 text-xs font-semibold text-[var(--workbench-muted)]">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-6 rounded-sm bg-[var(--workbench-primary)]" />{labels.forecastLegend}</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-1 w-6 rounded-sm bg-slate-400" />{labels.baselineLegend}</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-px w-6 bg-[var(--workbench-gantt-link)]" />{labels.dependencyLegend}</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-0.5 bg-[var(--workbench-danger)]" />{labels.today}</span>
          </div>
        </>
      ) : (
        <p className="border-t border-[var(--workbench-border)] px-5 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {labels.empty}
        </p>
      )}
    </section>
  )
}

/**
 * Draws one entity's baseline and forecast on its chart row.
 *
 * @param props - Row geometry, labels, and selection callback.
 * @returns Absolutely positioned bar elements.
 */
function TimelineBar({
  critical,
  disabled,
  entityTypes,
  labels,
  onSelectEntity,
  row,
}: {
  /** Whether the entity is on the critical path. */
  critical: boolean
  /** Whether selection is disabled. */
  disabled: boolean
  /** Localized entity type names. */
  entityTypes: Record<PlanningEntityType, string>
  /** Localized chart labels. */
  labels: CrossProjectTimelineLabels
  /** Selects the entity. */
  onSelectEntity: (entityId: string) => void
  /** Computed entity row. */
  row: CrossProjectTimelineEntityRow
}) {
  const { entity } = row
  const accessibleName = `${entity.title} (${entityTypes[entity.type]}): ${formatRange(entity.forecast)}` +
    (row.endVarianceDays !== 0 ? `, ${labels.variance(row.endVarianceDays)}` : '')
  const barColor = critical
    ? 'bg-[var(--workbench-gantt-link-critical)]'
    : entity.type === 'cycle'
      ? 'bg-slate-500'
      : entity.type === 'release'
        ? 'bg-indigo-500'
        : 'bg-[var(--workbench-primary)]'
  const center = row.top + CROSS_PROJECT_TIMELINE_ENTITY_ROW_HEIGHT / 2

  if (entity.type === 'milestone') {
    return (
      <>
        <span
          aria-hidden="true"
          className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-slate-400 bg-transparent"
          style={{ left: `${row.baseline.leftPercent}%`, top: center }}
        />
        <button
          aria-label={accessibleName}
          className={`absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 ${barColor} disabled:cursor-not-allowed`}
          data-testid={`cross-project-timeline-bar-${entity.id}`}
          disabled={disabled}
          style={{ left: `${row.forecast.leftPercent}%`, top: center }}
          title={accessibleName}
          type="button"
          onClick={() => onSelectEntity(entity.id)}
        />
      </>
    )
  }

  return (
    <>
      <span
        aria-hidden="true"
        className="absolute h-1 rounded-sm bg-slate-400"
        style={{
          left: `${row.baseline.leftPercent}%`,
          top: center + 7,
          width: `${row.baseline.widthPercent}%`,
        }}
      />
      <button
        aria-label={accessibleName}
        className={`absolute h-3.5 min-w-1 -translate-y-1/2 rounded-sm ${barColor} disabled:cursor-not-allowed`}
        data-testid={`cross-project-timeline-bar-${entity.id}`}
        disabled={disabled}
        style={{
          left: `${row.forecast.leftPercent}%`,
          top: center - 2,
          width: `${row.forecast.widthPercent}%`,
        }}
        title={accessibleName}
        type="button"
        onClick={() => onSelectEntity(entity.id)}
      />
    </>
  )
}

/**
 * Formats an inclusive date range for accessible names.
 *
 * @param range - Range with `YYYY-MM-DD` dates.
 * @returns One date for single-day ranges, otherwise the start and end dates.
 */
function formatRange(range: PlanningEntity['forecast']): string {
  return range.startDate === range.endDate ? range.endDate : `${range.startDate} – ${range.endDate}`
}
