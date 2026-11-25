import type {
  AiPlanningDraft,
  WorkItemDependencyEndpoint,
} from '@mukuroji/contracts'
import { useId, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import {
  AiPlanningStructureAdoptionError,
  useAiPlanningStructureAdoption,
  type AiPlanningStructureAdoptionInput,
  type AiPlanningStructureAdoptionResult,
  type AiPlanningStructureParent,
} from '../mutations/useAiPlanningStructureAdoption'

/** Work Item Type offered for the children. */
export type AiPlanningChildTypeOption = {
  /** Work Item Type ID. */
  id: string
  /** Visible Type name. */
  name: string
}

/** Props for choosing and creating the child Work Items and dependencies of a Planning draft. */
export type AiPlanningStructureAdoptionProps = {
  /** Available Planning draft whose rows are offered. */
  draft: AiPlanningDraft
  /** Generation the draft belongs to; it scopes the idempotency of each row. */
  generationId: string
  /** Child Work Item Types the parent's type allows. */
  childTypes: readonly AiPlanningChildTypeOption[]
  /** Whether another operation on the Work Item is in flight. */
  disabled?: boolean
  /**
   * Records approval of the generation before anything is created. It resolves to `true` only when
   * the server approved the draft, which it refuses after the source, revision, or access changed.
   */
  approve: () => Promise<boolean>
  /** Creates the selected rows. */
  adopt: (input: AiPlanningStructureAdoptionInput) => Promise<AiPlanningStructureAdoptionResult>
  /** Whether the adoption is in flight. */
  isPending: boolean
  /** Refreshes the Work Item views after rows were created. */
  onAdopted?: () => void | Promise<void>
  /** Resolves a visible Team-qualified Work Item endpoint for review. */
  resolveWorkItemLabel?: (endpoint: WorkItemDependencyEndpoint) => string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Reviewer edits of one proposed child row. */
type ChildRowState = {
  /** Whether the row is selected for creation. */
  selected: boolean
  /** Edited title. */
  title: string
  /** Edited planned effort in hours as typed; empty means none. */
  effortHours: string
}

/** Outcome message shown after an adoption attempt. */
type AdoptionNotice = 'success' | 'error' | 'child-type-denied' | 'decision-required' | 'invalid-title'

/**
 * Lets the reviewer choose proposed child Work Items and dependencies, edit each child, and create
 * them in one operation after approving the draft.
 *
 * @param props - Draft, allowed child types, approval and adoption actions, and display resolvers.
 * @returns The adoption section, or nothing when the draft proposes no rows.
 */
export function AiPlanningStructureAdoption({
  adopt,
  approve,
  childTypes,
  disabled = false,
  draft,
  generationId,
  isPending,
  onAdopted,
  resolveWorkItemLabel,
  t,
}: AiPlanningStructureAdoptionProps) {
  const headingId = useId()
  const [childRows, setChildRows] = useState<Record<string, ChildRowState>>(() =>
    Object.fromEntries(draft.subtasks.map((subtask) => [subtask.id, {
      effortHours: subtask.plannedEffortMinutes === undefined
        ? ''
        : String(Math.round((subtask.plannedEffortMinutes / 60) * 100) / 100),
      selected: true,
      title: subtask.title,
    }])))
  const [selectedDependencies, setSelectedDependencies] = useState<ReadonlySet<string>>(
    () => new Set(draft.dependencies.map((dependency) => dependency.id)),
  )
  const [childTypeId, setChildTypeId] = useState(childTypes[0]?.id ?? '')
  const [createdChildRows, setCreatedChildRows] = useState<ReadonlySet<string>>(() => new Set())
  const [createdDependencyRows, setCreatedDependencyRows] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState<AdoptionNotice>()

  if (draft.subtasks.length === 0 && draft.dependencies.length === 0) return null

  const canCreateChildren = childTypes.some((type) => type.id === childTypeId)
  const pendingChildren = draft.subtasks.filter((subtask) =>
    canCreateChildren && childRows[subtask.id]?.selected && !createdChildRows.has(subtask.id))
  const pendingDependencies = draft.dependencies.filter((dependency) =>
    selectedDependencies.has(dependency.id) && !createdDependencyRows.has(dependency.id))
  const isBusy = disabled || isPending
  const canSubmit = !isBusy && (pendingChildren.length > 0 || pendingDependencies.length > 0)

  /** Replaces one field of a child row. */
  const updateChildRow = (rowId: string, patch: Partial<ChildRowState>) => {
    setChildRows((current) => {
      const row = current[rowId]
      return row ? { ...current, [rowId]: { ...row, ...patch } } : current
    })
  }

  /** Approves the draft, then creates the selected rows that were not created yet. */
  const submit = async () => {
    if (!canSubmit) return
    const children = pendingChildren.map((subtask) => {
      const row = childRows[subtask.id]
      return {
        ...(subtask.description ? { description: subtask.description } : {}),
        ...readEffortMinutes(row?.effortHours ?? ''),
        priority: subtask.priority,
        rowId: subtask.id,
        title: (row?.title ?? '').trim(),
      }
    })
    if (children.some((child) => child.title === '')) {
      setNotice('invalid-title')
      return
    }
    setNotice(undefined)
    try {
      if (!await approve()) {
        setNotice('decision-required')
        return
      }
      const result = await adopt({
        childWorkItemTypeId: childTypeId,
        children,
        dependencies: pendingDependencies.map((dependency) => ({
          lagDays: dependency.lagDays,
          predecessor: dependency.predecessor,
          rowId: dependency.id,
          successor: dependency.successor,
          type: dependency.type,
        })),
        generationId,
      })
      setCreatedChildRows((current) => new Set([...current, ...Object.keys(result.childWorkItemIds)]))
      setCreatedDependencyRows((current) => new Set([...current, ...result.dependencyRowIds]))
      setNotice('success')
      await onAdopted?.()
    } catch (error) {
      setNotice(error instanceof AiPlanningStructureAdoptionError && error.reason === 'child-type-denied'
        ? 'child-type-denied'
        : 'error')
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-4 border-t border-[var(--workbench-border)] pt-4"
      data-testid="ai-planning-structure-adoption"
    >
      <div>
        <h3 className="text-app-body font-semibold text-[var(--workbench-text)]" id={headingId}>
          {t('ai.planning.structure.title')}
        </h3>
        <p className="mt-1 text-app-caption leading-5 text-[var(--workbench-muted)]">
          {t('ai.planning.structure.description')}
        </p>
      </div>

      {draft.subtasks.length > 0 ? (
        <fieldset className="grid gap-3" disabled={isBusy}>
          <legend className="text-app-caption font-semibold text-[var(--workbench-muted)]">
            {t('ai.planning.structure.childrenHeading')}
          </legend>
          {childTypes.length === 0 ? (
            <p className="text-app-caption text-[var(--workbench-muted)]" role="note">
              {t('ai.planning.structure.noChildType')}
            </p>
          ) : (
            <label className="grid max-w-xs gap-1 text-app-caption text-[var(--workbench-muted)]">
              {t('ai.planning.structure.childType')}
              <select
                className="workbench-input min-h-[44px]"
                onChange={(event) => setChildTypeId(event.currentTarget.value)}
                value={childTypeId}
              >
                {childTypes.map((type) => (
                  <option key={type.id} value={type.id}>{type.name}</option>
                ))}
              </select>
            </label>
          )}
          <ul className="grid gap-3">
            {draft.subtasks.map((subtask) => {
              const row = childRows[subtask.id]
              const created = createdChildRows.has(subtask.id)
              return (
                <li className="grid gap-2 border-l-2 border-[var(--workbench-border)] pl-3" key={subtask.id}>
                  <label className="flex min-h-[44px] items-center gap-2 text-app-body">
                    <input
                      aria-label={`${t('ai.planning.structure.select')}: ${subtask.title}`}
                      checked={row?.selected ?? false}
                      disabled={created || !canCreateChildren}
                      onChange={(event) => updateChildRow(subtask.id, { selected: event.currentTarget.checked })}
                      type="checkbox"
                    />
                    <span>{t('ai.planning.structure.select')}</span>
                    {created ? (
                      <span className="text-app-caption font-semibold text-[var(--workbench-success)]">
                        {t('ai.planning.structure.created')}
                      </span>
                    ) : null}
                  </label>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <label className="grid gap-1 text-app-caption text-[var(--workbench-muted)]">
                      {t('ai.planning.structure.childTitle')}
                      <input
                        className="workbench-input min-h-[44px]"
                        disabled={created || !canCreateChildren}
                        maxLength={256}
                        onChange={(event) => updateChildRow(subtask.id, { title: event.currentTarget.value })}
                        value={row?.title ?? ''}
                      />
                    </label>
                    <label className="grid gap-1 text-app-caption text-[var(--workbench-muted)]">
                      {t('ai.planning.structure.effortHours')}
                      <input
                        className="workbench-input min-h-[44px]"
                        disabled={created || !canCreateChildren}
                        inputMode="decimal"
                        min={0}
                        onChange={(event) => updateChildRow(subtask.id, { effortHours: event.currentTarget.value })}
                        step={0.25}
                        type="number"
                        value={row?.effortHours ?? ''}
                      />
                    </label>
                  </div>
                </li>
              )
            })}
          </ul>
        </fieldset>
      ) : null}

      {draft.dependencies.length > 0 ? (
        <fieldset className="grid gap-2" disabled={isBusy}>
          <legend className="text-app-caption font-semibold text-[var(--workbench-muted)]">
            {t('ai.planning.structure.dependenciesHeading')}
          </legend>
          {draft.dependencies.map((dependency) => {
            const created = createdDependencyRows.has(dependency.id)
            return (
              <label className="flex min-h-[44px] items-center gap-2 text-app-body" key={dependency.id}>
                <input
                  checked={selectedDependencies.has(dependency.id)}
                  disabled={created}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    setSelectedDependencies((current) => {
                      const next = new Set(current)
                      if (checked) next.add(dependency.id)
                      else next.delete(dependency.id)
                      return next
                    })
                  }}
                  type="checkbox"
                />
                <span>
                  {formatEndpoint(dependency.predecessor, resolveWorkItemLabel)}
                  {' → '}
                  {formatEndpoint(dependency.successor, resolveWorkItemLabel)}
                </span>
                {created ? (
                  <span className="text-app-caption font-semibold text-[var(--workbench-success)]">
                    {t('ai.planning.structure.created')}
                  </span>
                ) : null}
              </label>
            )
          })}
        </fieldset>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="workbench-button-primary min-h-[44px] px-4 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSubmit}
          onClick={() => void submit()}
          type="button"
        >
          {isPending ? t('ai.planning.structure.submitting') : t('ai.planning.structure.submit')}
        </button>
        {notice ? (
          <p
            className={notice === 'success'
              ? 'text-app-caption font-semibold text-[var(--workbench-success)]'
              : 'text-app-caption font-semibold text-[var(--workbench-danger)]'}
            role={notice === 'success' ? 'status' : 'alert'}
          >
            {t(noticeMessageKeys[notice])}
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** Message shown for each adoption outcome. */
const noticeMessageKeys: Record<AdoptionNotice, MessageKey> = {
  'child-type-denied': 'ai.planning.structure.childTypeDenied',
  'decision-required': 'ai.planning.structure.decisionRequired',
  error: 'ai.planning.structure.error',
  'invalid-title': 'ai.planning.structure.invalidTitle',
  success: 'ai.planning.structure.success',
}

/**
 * Converts the typed effort in hours to whole minutes.
 *
 * @param hours - Effort as typed; empty or invalid input means no effort.
 * @returns The planned effort field, or nothing.
 */
function readEffortMinutes(hours: string): { plannedEffortMinutes?: number } {
  if (hours.trim() === '') return {}
  const value = Number(hours)
  if (!Number.isFinite(value) || value < 0) return {}
  return { plannedEffortMinutes: Math.round(value * 60) }
}

/**
 * Labels a dependency endpoint for review.
 *
 * @param endpoint - Team-qualified Work Item.
 * @param resolveWorkItemLabel - Optional visible label resolver.
 * @returns The label, or the Team and Work Item IDs.
 */
function formatEndpoint(
  endpoint: WorkItemDependencyEndpoint,
  resolveWorkItemLabel?: (endpoint: WorkItemDependencyEndpoint) => string,
): string {
  return resolveWorkItemLabel?.(endpoint) ?? `${endpoint.teamId} / ${endpoint.workItemId}`
}

/** Context a Work Item route supplies so its planning assistant can create children and dependencies. */
export type AiPlanningStructureAdoptionContext = {
  /** Parent Work Item that receives the children. */
  parent: AiPlanningStructureParent
  /** Child Work Item Types the parent's type allows. */
  childTypes: readonly AiPlanningChildTypeOption[]
  /** Refreshes the Work Item views after rows were created. */
  onAdopted?: () => void | Promise<void>
}

/** Props for the stateful adoption section. */
export type AiPlanningStructureAdoptionContainerProps = Omit<
  AiPlanningStructureAdoptionProps,
  'adopt' | 'childTypes' | 'isPending' | 'onAdopted'
> & {
  /** Workspace member bearer token. */
  accessToken?: string
  /** Parent, allowed child types, and refresh callback from the Work Item route. */
  context: AiPlanningStructureAdoptionContext
}

/**
 * Connects the adoption section to the Work Item, hierarchy, and Planning APIs.
 *
 * @param props - Bearer token, route context, draft, approval action, and display resolvers.
 * @returns The adoption section.
 */
export function AiPlanningStructureAdoptionContainer({
  accessToken,
  context,
  ...props
}: AiPlanningStructureAdoptionContainerProps) {
  const { adopt, isPending } = useAiPlanningStructureAdoption({ accessToken, parent: context.parent })
  return (
    <AiPlanningStructureAdoption
      {...props}
      adopt={adopt}
      childTypes={context.childTypes}
      isPending={isPending}
      onAdopted={context.onAdopted}
    />
  )
}
