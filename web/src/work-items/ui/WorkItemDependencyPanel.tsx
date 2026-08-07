import type {
  CreateWorkItemScheduleDependencyInput,
  PlanningSnapshot,
  PlanningWorkItemSummary,
  ScheduleDependencyConstraint,
  ScheduleDependencyType,
  WorkItemDependencyEndpoint,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
} from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { resolvePlanningErrorMessageKey } from '../../planning/api/errors'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createWorkItemDependencyEndpointKey,
  createWorkItemDependencyRows,
  createWorkItemDependencySummaries,
  createWorkItemScheduleDependencyPatch,
  filterWorkItemDependencyRows,
  resolveWorkItemDependencySummary,
  type WorkItemDependencyRuleDraft,
} from '../model/workItemDependencies'
import { WorkItemDependencyChips } from './WorkItemDependencyChips'

const dependencyTypes: readonly ScheduleDependencyType[] = [
  'finish-to-start',
  'start-to-start',
  'finish-to-finish',
  'start-to-finish',
]

/** Editable canonical dependency fields emitted by the create form. */
export type WorkItemDependencyCreateDraft = Omit<
  CreateWorkItemScheduleDependencyInput,
  'expectedRevision' | 'id'
>

/** Props for the shared Work Item schedule-dependency editor. */
export type WorkItemDependencyPanelProps = {
  /** Determines whether the current user may mutate dependencies involving an endpoint. */
  canManageEndpoint?: (endpoint: WorkItemDependencyEndpoint) => boolean
  /** Optional Work Item that limits the list and anchors one side of new edges. */
  currentEndpoint?: WorkItemDependencyEndpoint
  /** Creates a new canonical dependency. */
  onCreate?: (input: WorkItemDependencyCreateDraft) => void | Promise<void>
  /** Deletes a canonical dependency. */
  onDelete?: (dependency: WorkItemScheduleDependency) => void | Promise<void>
  /** Updates editable fields of a canonical dependency. */
  onUpdate?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
  /** Opens one visible Work Item endpoint from a dependency row. */
  onOpenWorkItem?: (workItem: PlanningWorkItemSummary) => void
  /** Opens one affected Project from the management summary. */
  onOpenProject?: (projectId: string) => void
  /** Opens one affected Milestone from the management summary. */
  onOpenMilestone?: (milestoneId: string) => void
  /** Optional endpoint set that limits rows and new edges to one contextual scope. */
  scopeEndpoints?: readonly WorkItemDependencyEndpoint[]
  /** Authoritative graph and visible Work Item projections. */
  snapshot?: PlanningSnapshot
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Displays and edits the same canonical Work Item dependency graph in task and planning views.
 *
 * @param props - Snapshot, optional current item, translator, and mutation callbacks.
 * @returns A dependency summary, edge list, and revision-agnostic edit forms.
 */
export function WorkItemDependencyPanel({
  canManageEndpoint,
  currentEndpoint,
  onCreate,
  onDelete,
  onOpenMilestone,
  onOpenProject,
  onOpenWorkItem,
  onUpdate,
  scopeEndpoints,
  snapshot,
  t,
}: WorkItemDependencyPanelProps) {
  const [busyKey, setBusyKey] = useState<string>()
  const [errorMessage, setErrorMessage] = useState<string>()
  const allRows = useMemo(() => createWorkItemDependencyRows(snapshot), [snapshot])
  const scopeEndpointKeys = useMemo(
    () => scopeEndpoints
      ? new Set(scopeEndpoints.map(createWorkItemDependencyEndpointKey))
      : undefined,
    [scopeEndpoints],
  )
  const rows = useMemo(
    () => currentEndpoint
      ? filterWorkItemDependencyRows(allRows, currentEndpoint)
      : scopeEndpointKeys
        ? allRows.filter((row) =>
            scopeEndpointKeys.has(createWorkItemDependencyEndpointKey(row.dependency.predecessor)) ||
            scopeEndpointKeys.has(createWorkItemDependencyEndpointKey(row.dependency.successor))
          )
        : allRows,
    [allRows, currentEndpoint, scopeEndpointKeys],
  )
  const summaries = useMemo(
    () => createWorkItemDependencySummaries(snapshot),
    [snapshot],
  )
  const currentSummary = currentEndpoint
    ? resolveWorkItemDependencySummary(summaries, currentEndpoint)
    : undefined
  const items = snapshot?.workItems ?? []
  const manageableItems = canManageEndpoint
    ? items.filter((item) => canManageEndpoint({ teamId: item.teamId, workItemId: item.id }))
    : items
  const contextualManageableItems = scopeEndpointKeys
    ? manageableItems.toSorted((left, right) => Number(scopeEndpointKeys.has(
        createWorkItemDependencyEndpointKey({ teamId: right.teamId, workItemId: right.id }),
      )) - Number(scopeEndpointKeys.has(
        createWorkItemDependencyEndpointKey({ teamId: left.teamId, workItemId: left.id }),
      )))
    : manageableItems
  const selectableItems = currentEndpoint
    ? contextualManageableItems.filter((item) => createWorkItemDependencyEndpointKey({
        teamId: item.teamId,
        workItemId: item.id,
      }) !== createWorkItemDependencyEndpointKey(currentEndpoint))
    : contextualManageableItems
  const currentEndpointIsManageable = !currentEndpoint ||
    !canManageEndpoint ||
    canManageEndpoint(currentEndpoint)
  const canCreate = Boolean(onCreate && currentEndpointIsManageable)
  const canEditAnyRow = rows.some((row) =>
    (!canManageEndpoint || (
      canManageEndpoint(row.dependency.predecessor) &&
      canManageEndpoint(row.dependency.successor)
    )) && Boolean(onDelete || onUpdate)
  )
  const editable = canCreate || canEditAnyRow

  /** Runs one dependency mutation while retaining local progress and errors. */
  const runMutation = async (key: string, request: () => void | Promise<void>) => {
    setBusyKey(key)
    setErrorMessage(undefined)
    try {
      await request()
    } catch (error) {
      setErrorMessage(t(resolvePlanningErrorMessageKey(error, 'mutation')))
    } finally {
      setBusyKey(undefined)
    }
  }

  return (
    <section className="grid gap-4" data-testid="work-item-dependency-panel">
      <div>
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">
          {t('workItems.dependencies.title')}
        </h2>
        <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
          {t('workItems.dependencies.description')}
        </p>
        {currentSummary ? (
          <WorkItemDependencyChips className="mt-2" summary={currentSummary} t={t} />
        ) : null}
      </div>

      {!currentEndpoint && !scopeEndpointKeys && snapshot ? (
        <div className="grid grid-cols-4 gap-2 max-[760px]:grid-cols-2">
          <DependencyMetric
            label={t('workItems.dependencies.unresolved').replace(
              '{count}',
              String(snapshot.workItemDependencySummary.unresolvedBlockerCount),
            )}
          />
          <DependencyMetric
            label={t('workItems.dependencies.affectedProjects').replace(
              '{count}',
              String(snapshot.workItemDependencySummary.affectedProjectIds.length),
            )}
            onOpenValue={onOpenProject}
            values={snapshot.workItemDependencySummary.affectedProjectIds}
          />
          <DependencyMetric
            label={t('workItems.dependencies.affectedMilestones').replace(
              '{count}',
              String(snapshot.workItemDependencySummary.affectedMilestoneIds.length),
            )}
            onOpenValue={onOpenMilestone}
            values={snapshot.workItemDependencySummary.affectedMilestoneIds}
          />
          <DependencyMetric
            label={t('workItems.dependencies.criticalDays').replace(
              '{count}',
              String(snapshot.workItemDependencySummary.criticalPath.totalDurationDays),
            )}
          />
        </div>
      ) : null}

      <div className="grid gap-2" role="list">
        {rows.map((row) => {
          const predecessorWorkItem = row.predecessor
          const successorWorkItem = row.successor
          const rowIsManageable = !canManageEndpoint || (
            canManageEndpoint(row.dependency.predecessor) &&
            canManageEndpoint(row.dependency.successor)
          )
          return (
            <DependencyRow
              busy={busyKey === row.dependency.id}
              dependency={row.dependency}
              conflictCount={row.conflicts.length}
              key={`${row.dependency.id}:${row.dependency.updatedAt}`}
              onDelete={onDelete && rowIsManageable
                ? () => runMutation(row.dependency.id, () => onDelete(row.dependency))
                : undefined}
              onUpdate={onUpdate && rowIsManageable
                ? (patch) => runMutation(
                    row.dependency.id,
                    () => onUpdate(row.dependency, patch),
                  )
                : undefined}
              onOpenPredecessor={onOpenWorkItem && predecessorWorkItem
                ? () => onOpenWorkItem(predecessorWorkItem)
                : undefined}
              onOpenSuccessor={onOpenWorkItem && successorWorkItem
                ? () => onOpenWorkItem(successorWorkItem)
                : undefined}
              predecessorTitle={row.predecessor?.title ?? row.dependency.predecessor.workItemId}
              readOnly={!rowIsManageable}
              successorTitle={row.successor?.title ?? row.dependency.successor.workItemId}
              critical={row.critical}
              t={t}
            />
          )
        })}
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] p-4 text-sm font-medium text-[var(--workbench-muted)]">
            {t('workItems.dependencies.empty')}
          </p>
        ) : null}
      </div>

      {canCreate && onCreate && snapshot && (
        currentEndpoint ? selectableItems.length > 0 : selectableItems.length > 1
      ) ? (
        <DependencyCreateForm
          busy={busyKey === 'create'}
          currentEndpoint={currentEndpoint}
          items={contextualManageableItems}
          onCreate={(input) => runMutation('create', () => onCreate(input))}
          scopeEndpointKeys={scopeEndpointKeys}
          selectableItems={selectableItems}
          t={t}
        />
      ) : !editable ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">
          {t('workItems.dependencies.readOnly')}
        </p>
      ) : null}
      {errorMessage ? <p className="text-sm font-semibold text-red-700" role="alert">{errorMessage}</p> : null}
    </section>
  )
}

/** Props for one compact dependency management metric. */
type DependencyMetricProps = {
  /** Fully formatted metric label. */
  label: string
  /** Opens one metric identifier through a keyboard-operable control. */
  onOpenValue?: (value: string) => void
  /** Optional canonical identifiers included in the metric. */
  values?: readonly string[]
}

/** Renders one management metric. */
function DependencyMetric({ label, onOpenValue, values }: DependencyMetricProps) {
  return (
    <div className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3 text-xs font-semibold text-[var(--workbench-text)]">
      <p>{label}</p>
      {values && values.length > 0 ? (
        <ul className="mt-2 grid gap-1 font-mono text-[11px] font-medium text-[var(--workbench-muted)]">
          {values.map((value) => (
            <li className="break-all" key={value}>
              {onOpenValue ? (
                <button
                  aria-label={`${label}: ${value}`}
                  className="text-left underline decoration-dotted underline-offset-2 hover:text-[var(--workbench-primary)]"
                  onClick={() => onOpenValue(value)}
                  type="button"
                >
                  {value}
                </button>
              ) : value}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Props for a single editable dependency edge row. */
type DependencyRowProps = {
  /** Whether a mutation for this edge is in flight. */
  busy: boolean
  /** Whether the edge is part of the critical path. */
  critical: boolean
  /** Canonical edge being displayed. */
  dependency: WorkItemScheduleDependency
  /** Number of server-reported conflicts for the edge. */
  conflictCount: number
  /** Deletes the edge. */
  onDelete?: () => void | Promise<void>
  /** Opens the predecessor Work Item when navigation is available. */
  onOpenPredecessor?: () => void
  /** Opens the successor Work Item when navigation is available. */
  onOpenSuccessor?: () => void
  /** Updates editable edge fields. */
  onUpdate?: (patch: WorkItemScheduleDependencyPatch) => void | Promise<void>
  /** Visible predecessor title or identifier fallback. */
  predecessorTitle: string
  /** Whether exact endpoint authority makes this edge reference-only. */
  readOnly: boolean
  /** Visible successor title or identifier fallback. */
  successorTitle: string
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/** Renders an edge as a readable arrow and an optional inline rule editor. */
function DependencyRow({
  busy,
  critical,
  dependency,
  conflictCount,
  onDelete,
  onOpenPredecessor,
  onOpenSuccessor,
  onUpdate,
  predecessorTitle,
  readOnly,
  successorTitle,
  t,
}: DependencyRowProps) {
  const hasConflicts = conflictCount > 0
  return (
    <article
      className={`rounded-lg border p-3 ${hasConflicts
        ? 'border-red-300 bg-red-50'
        : critical
          ? 'border-amber-300 bg-amber-50'
          : 'border-[var(--workbench-border)] bg-white'}`}
      data-critical={critical ? 'true' : 'false'}
      data-conflict={hasConflicts ? 'true' : 'false'}
      data-testid={`work-item-dependency-${dependency.id}`}
      role="listitem"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 text-sm font-semibold text-[var(--workbench-text)]">
          {onOpenPredecessor ? (
            <button
              aria-label={`${t('workItems.dependencies.predecessor')}: ${predecessorTitle}`}
              className="text-left underline decoration-dotted underline-offset-2 hover:text-[var(--workbench-primary)]"
              onClick={onOpenPredecessor}
              type="button"
            >
              {predecessorTitle}
            </button>
          ) : (
            <span>
              <span className="sr-only">{t('workItems.dependencies.predecessor')}: </span>
              {predecessorTitle}
            </span>
          )}
          <span aria-hidden="true">→</span>
          {onOpenSuccessor ? (
            <button
              aria-label={`${t('workItems.dependencies.successor')}: ${successorTitle}`}
              className="text-left underline decoration-dotted underline-offset-2 hover:text-[var(--workbench-primary)]"
              onClick={onOpenSuccessor}
              type="button"
            >
              {successorTitle}
            </button>
          ) : (
            <span>
              <span className="sr-only">{t('workItems.dependencies.successor')}: </span>
              {successorTitle}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {critical ? <span className="workbench-badge-danger">{t('workItems.dependencies.critical')}</span> : null}
          {hasConflicts ? (
            <span className="workbench-badge-danger">
              {t('workItems.dependencies.conflictsCount').replace(
                '{count}',
                String(conflictCount),
              )}
            </span>
          ) : null}
        </div>
      </div>
      <form
        className="mt-3 grid grid-cols-[minmax(150px,1fr)_110px_minmax(160px,1fr)_auto] items-end gap-2 max-[760px]:grid-cols-1"
        onSubmit={(event) => {
          event.preventDefault()
          const rule = readDependencyRule(new FormData(event.currentTarget))
          if (rule) {
            void onUpdate?.(createWorkItemScheduleDependencyPatch(rule))
          }
        }}
      >
        <fieldset className="contents" disabled={!onUpdate || busy}>
          <DependencyTypeSelect defaultValue={dependency.type} t={t} />
          <DependencyLagInput defaultValue={dependency.lagDays} t={t} />
          <DependencyConstraintFields constraint={dependency.constraint} compact t={t} />
        </fieldset>
        <div className="flex gap-2">
          {onUpdate ? (
            <button
              aria-label={`${t('workItems.dependencies.update')}: ${predecessorTitle} → ${successorTitle}`}
              className="workbench-button-secondary min-h-9 px-3"
              disabled={busy}
              type="submit"
            >
              {busy ? t('workItems.dependencies.saving') : t('workItems.dependencies.update')}
            </button>
          ) : null}
          {onDelete ? (
            <button
              aria-label={`${t('workItems.dependencies.remove')}: ${predecessorTitle} → ${successorTitle}`}
              className="workbench-button-secondary min-h-9 px-3"
              disabled={busy}
              onClick={() => void onDelete()}
              type="button"
            >
              {t('workItems.dependencies.remove')}
            </button>
          ) : null}
        </div>
      </form>
      {readOnly ? (
        <p className="mt-2 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('workItems.dependencies.readOnly')}
        </p>
      ) : null}
    </article>
  )
}

/** Props for the dependency create form. */
type DependencyCreateFormProps = {
  /** Whether creation is in flight. */
  busy: boolean
  /** Optional current endpoint anchoring one side of the new edge. */
  currentEndpoint?: WorkItemDependencyEndpoint
  /** Every visible Work Item projection. */
  items: PlanningSnapshot['workItems']
  /** Emits a validated dependency draft. */
  onCreate: (input: WorkItemDependencyCreateDraft) => void | Promise<void>
  /** Optional contextual endpoint set that every new edge must touch. */
  scopeEndpointKeys?: ReadonlySet<string>
  /** Valid targets when a current endpoint is present. */
  selectableItems: PlanningSnapshot['workItems']
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/** Renders the canonical dependency create form for detail or management context. */
function DependencyCreateForm({
  busy,
  currentEndpoint,
  items,
  onCreate,
  scopeEndpointKeys,
  selectableItems,
  t,
}: DependencyCreateFormProps) {
  const [validationMessage, setValidationMessage] = useState<string>()
  return (
    <form
      className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4"
      data-testid="work-item-dependency-create"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const direction = data.get('direction') === 'incoming' ? 'incoming' : 'outgoing'
        const selectedTarget = parseEndpointValue(String(data.get('target') ?? ''))
        const predecessor = currentEndpoint
          ? direction === 'outgoing' ? currentEndpoint : selectedTarget
          : parseEndpointValue(String(data.get('predecessor') ?? ''))
        const successor = currentEndpoint
          ? direction === 'outgoing' ? selectedTarget : currentEndpoint
          : parseEndpointValue(String(data.get('successor') ?? ''))
        const rule = readDependencyRule(data)
        if (!predecessor || !successor || !rule || (
          createWorkItemDependencyEndpointKey(predecessor) ===
          createWorkItemDependencyEndpointKey(successor)
        ) || (
          scopeEndpointKeys &&
          !scopeEndpointKeys.has(createWorkItemDependencyEndpointKey(predecessor)) &&
          !scopeEndpointKeys.has(createWorkItemDependencyEndpointKey(successor))
        )) {
          setValidationMessage(t('workItems.dependencies.invalid'))
          return
        }
        setValidationMessage(undefined)
        void onCreate({ predecessor, successor, ...rule })
      }}
    >
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
        {t('workItems.dependencies.add')}
      </h3>
      <div className="grid grid-cols-2 gap-3 max-[680px]:grid-cols-1">
        {currentEndpoint ? (
          <>
            <label className="grid gap-1.5 text-sm font-semibold">
              {t('workItems.dependencies.direction')}
              <select className="workbench-input h-10 px-3" name="direction">
                <option value="outgoing">{t('workItems.dependencies.outgoing')}</option>
                <option value="incoming">{t('workItems.dependencies.incoming')}</option>
              </select>
            </label>
            <EndpointSelect items={selectableItems} label={t('workItems.relations.target')} name="target" />
          </>
        ) : (
          <>
            <EndpointSelect items={items} label={t('workItems.dependencies.predecessor')} name="predecessor" />
            <EndpointSelect defaultValue={items[1]} items={items} label={t('workItems.dependencies.successor')} name="successor" />
          </>
        )}
        <DependencyTypeSelect t={t} />
        <DependencyLagInput defaultValue={0} t={t} />
      </div>
      <DependencyConstraintFields t={t} />
      {validationMessage ? <p className="text-sm font-semibold text-red-700" role="alert">{validationMessage}</p> : null}
      <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={busy} type="submit">
        {busy ? t('workItems.dependencies.saving') : t('workItems.dependencies.add')}
      </button>
    </form>
  )
}

/** Props for a Work Item endpoint select. */
type EndpointSelectProps = {
  /** Optional initial selected projection. */
  defaultValue?: PlanningSnapshot['workItems'][number]
  /** Visible Work Item projections. */
  items: PlanningSnapshot['workItems']
  /** Visible field label. */
  label: string
  /** Submitted form field name. */
  name: string
}

/** Renders a Team-qualified Work Item endpoint selector. */
function EndpointSelect({ defaultValue, items, label, name }: EndpointSelectProps) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold">
      {label}
      <select className="workbench-input h-10 min-w-0 px-3" defaultValue={defaultValue ? createEndpointValue({ teamId: defaultValue.teamId, workItemId: defaultValue.id }) : undefined} name={name}>
        {items.map((item) => (
          <option key={`${item.teamId}:${item.id}`} value={createEndpointValue({ teamId: item.teamId, workItemId: item.id })}>
            {item.title} · {item.teamId}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Props for the shared dependency type selector. */
type DependencyTypeSelectProps = {
  /** Initial relationship type. */
  defaultValue?: ScheduleDependencyType
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/** Renders all four scheduling dependency types, including start-to-finish. */
function DependencyTypeSelect({ defaultValue = 'finish-to-start', t }: DependencyTypeSelectProps) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold">
      {t('workItems.dependencies.type')}
      <select className="workbench-input h-10 px-3" defaultValue={defaultValue} name="dependencyType">
        {dependencyTypes.map((type) => (
          <option key={type} value={type}>{t(`workItems.dependencies.type.${type}`)}</option>
        ))}
      </select>
    </label>
  )
}

/** Props for the signed dependency lag input. */
type DependencyLagInputProps = {
  /** Initial signed calendar-day value. */
  defaultValue: number
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/** Renders a signed lead/lag field without clamping negative values. */
function DependencyLagInput({ defaultValue, t }: DependencyLagInputProps) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold">
      {t('workItems.dependencies.lagDays')}
      <input className="workbench-input h-10 px-3" defaultValue={defaultValue} name="lagDays" step="1" type="number" />
      <span className="text-xs font-medium text-[var(--workbench-muted)]">{t('workItems.dependencies.lagHint')}</span>
    </label>
  )
}

/** Props for optional date-constraint controls. */
type DependencyConstraintFieldsProps = {
  /** Initial constraint. */
  constraint?: ScheduleDependencyConstraint
  /** Whether controls use a compact single-column layout. */
  compact?: boolean
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/** Renders optional successor anchor, rule, and local date controls. */
function DependencyConstraintFields({
  compact = false,
  constraint,
  t,
}: DependencyConstraintFieldsProps) {
  return (
    <fieldset className={`grid gap-2 ${compact ? 'grid-cols-1' : 'grid-cols-3 max-[680px]:grid-cols-1'}`}>
      <legend className="sr-only">{t('workItems.dependencies.constraint')}</legend>
      <label className="grid gap-1.5 text-sm font-semibold">
        {t('workItems.dependencies.constraint.kind')}
        <select className="workbench-input h-10 px-3" defaultValue={constraint?.kind ?? ''} name="constraintKind">
          <option value="">{t('workItems.dependencies.constraint.none')}</option>
          <option value="on">{t('workItems.dependencies.constraint.kind.on')}</option>
          <option value="not-before">{t('workItems.dependencies.constraint.kind.not-before')}</option>
          <option value="not-after">{t('workItems.dependencies.constraint.kind.not-after')}</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        {t('workItems.dependencies.constraint.anchor')}
        <select className="workbench-input h-10 px-3" defaultValue={constraint?.anchor ?? 'start'} name="constraintAnchor">
          <option value="start">{t('workItems.dependencies.constraint.anchor.start')}</option>
          <option value="finish">{t('workItems.dependencies.constraint.anchor.finish')}</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        {t('workItems.dependencies.constraint.date')}
        <input className="workbench-input h-10 px-3" defaultValue={constraint?.date ?? ''} name="constraintDate" type="date" />
      </label>
    </fieldset>
  )
}

/** Parses editable scheduling fields from a dependency form. */
function readDependencyRule(data: FormData): WorkItemDependencyRuleDraft | undefined {
  const type = readDependencyType(data.get('dependencyType'))
  const lagValue = Number(data.get('lagDays'))
  if (!type || !Number.isSafeInteger(lagValue)) return undefined
  const constraintKind = readConstraintKind(data.get('constraintKind'))
  if (!constraintKind) return { lagDays: lagValue, type }
  const constraintAnchor = readConstraintAnchor(data.get('constraintAnchor'))
  const constraintDate = String(data.get('constraintDate') ?? '').trim()
  if (!constraintAnchor || !/^\d{4}-\d{2}-\d{2}$/.test(constraintDate)) return undefined
  return {
    constraint: { anchor: constraintAnchor, date: constraintDate, kind: constraintKind },
    lagDays: lagValue,
    type,
  }
}

/** Narrows a form value to a supported dependency type. */
function readDependencyType(value: FormDataEntryValue | null): ScheduleDependencyType | undefined {
  const text = String(value ?? '')
  return dependencyTypes.find((type) => type === text)
}

/** Narrows an optional form value to a supported constraint kind. */
function readConstraintKind(value: FormDataEntryValue | null): ScheduleDependencyConstraint['kind'] | undefined {
  const text = String(value ?? '')
  return text === 'on' || text === 'not-before' || text === 'not-after' ? text : undefined
}

/** Narrows a form value to a supported constraint anchor. */
function readConstraintAnchor(value: FormDataEntryValue | null): ScheduleDependencyConstraint['anchor'] | undefined {
  const text = String(value ?? '')
  return text === 'start' || text === 'finish' ? text : undefined
}

/** Serializes a dependency endpoint for a native select value. */
function createEndpointValue(endpoint: WorkItemDependencyEndpoint): string {
  return `${encodeURIComponent(endpoint.teamId)}:${encodeURIComponent(endpoint.workItemId)}`
}

/** Parses a Team-qualified native select value without a type assertion. */
function parseEndpointValue(value: string): WorkItemDependencyEndpoint | undefined {
  const separator = value.indexOf(':')
  if (separator < 1 || separator === value.length - 1) return undefined
  try {
    const teamId = decodeURIComponent(value.slice(0, separator))
    const workItemId = decodeURIComponent(value.slice(separator + 1))
    return teamId && workItemId ? { teamId, workItemId } : undefined
  } catch {
    return undefined
  }
}
