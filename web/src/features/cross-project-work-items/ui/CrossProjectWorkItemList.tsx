import type { CanonicalWorkItem, ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import {
  resolveWorkItemAssignee,
  resolveWorkItemWorkflowStatusLabel,
} from '../../../work-items/model/workItemDisplay'
import {
  createCrossProjectWorkItemProjectKey,
  type CrossProjectWorkItemFilterOption,
  type CrossProjectWorkItemGroup,
  type CrossProjectWorkItemListState,
  type CrossProjectWorkItemProjectOption,
} from '../model/crossProjectWorkItems'

/** Translation function used by the cross-Project Work Item list. */
type CrossProjectWorkItemTranslator = (key: MessageKey) => string

/** Props of {@link CrossProjectWorkItemList}. */
export type CrossProjectWorkItemListProps = {
  /** Current filters and grouping. */
  state: CrossProjectWorkItemListState
  /** Readable Projects that can be selected. */
  projectOptions: CrossProjectWorkItemProjectOption[]
  /** Members who appear as contributors on the readable Work Items. */
  memberOptions: CrossProjectWorkItemFilterOption[]
  /** Job roles that contributors can be planned against. */
  jobRoleOptions: CrossProjectWorkItemFilterOption[]
  /** Grouped, filtered Work Items. */
  groups: CrossProjectWorkItemGroup[]
  /** Number of Work Items across every group. */
  totalCount: number
  /** Resolved Team configurations used for status labels, keyed by Team ID. */
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Display labels of Workspace members, keyed by member key. */
  memberLabels: ReadonlyMap<string, string>
  /** Whether the Work Items are still loading. */
  isLoading: boolean
  /** Whether the Work Items could not be loaded; the page shows the error notice instead of a count. */
  loadFailed: boolean
  /** Translation function for the current locale. */
  t: CrossProjectWorkItemTranslator
  /** Replaces the list state, which the page writes to the URL. */
  onChangeState: (state: CrossProjectWorkItemListState) => void
  /** Opens one Work Item in its Team or Project route. */
  onOpenWorkItem: (workItem: CanonicalWorkItem) => void
  /** Copies the URL of the current view, resolving whether it succeeded. */
  onCopyLink: () => Promise<boolean>
}

/** Result of the latest copy-link attempt shown next to the button. */
type CopyLinkStatus = 'idle' | 'copied' | 'failed'

/**
 * Renders the Workspace-wide Work Item table with Project, involvement, and contributor filters.
 *
 * @param props - List state, options, grouped Work Items, and callbacks.
 * @returns The filter toolbar and one table section per group.
 */
export function CrossProjectWorkItemList({
  state,
  projectOptions,
  memberOptions,
  jobRoleOptions,
  groups,
  totalCount,
  configurationsByTeam,
  memberLabels,
  isLoading,
  loadFailed,
  t,
  onChangeState,
  onOpenWorkItem,
  onCopyLink,
}: CrossProjectWorkItemListProps) {
  const [copyLinkStatus, setCopyLinkStatus] = useState<CopyLinkStatus>('idle')
  const selectedProjectKeys = new Set(state.projects.map(createCrossProjectWorkItemProjectKey))
  const roleLabels = new Map(jobRoleOptions.map((option) => [option.id, option.label]))
  const update = (patch: Partial<CrossProjectWorkItemListState>) => {
    setCopyLinkStatus('idle')
    onChangeState({ ...state, ...patch })
  }
  const toggleProject = (option: CrossProjectWorkItemProjectOption) => {
    update({
      projects: selectedProjectKeys.has(option.key)
        ? state.projects.filter((ref) => createCrossProjectWorkItemProjectKey(ref) !== option.key)
        : [...state.projects, { teamId: option.teamId, projectId: option.projectId }],
    })
  }
  const projectSummary = state.projects.length === 0
    ? t('workItems.crossProject.projects.all')
    : t('workItems.crossProject.projects.selected').replace('{count}', String(state.projects.length))

  return (
    <div className="grid gap-4" data-testid="cross-project-work-items">
      <section
        aria-label={t('workItems.crossProject.filters')}
        className="workbench-toolbar flex flex-wrap items-end gap-3 px-3 py-3"
      >
        <details className="relative">
          <summary className="workbench-button-secondary flex min-h-9 cursor-pointer items-center px-3 text-sm">
            {t('workItems.crossProject.projects.label')}: {projectSummary}
          </summary>
          <fieldset className="workbench-panel absolute z-10 mt-1 grid max-h-80 w-max min-w-64 max-w-[90vw] gap-1 overflow-y-auto p-3">
            <legend className="sr-only">{t('workItems.crossProject.projects.label')}</legend>
            {projectOptions.length === 0 ? (
              <p className="text-sm text-[var(--workbench-muted)]">{t('workItems.crossProject.projects.empty')}</p>
            ) : projectOptions.map((option) => (
              <label className="flex items-center gap-2 whitespace-nowrap text-sm" key={option.key}>
                <input
                  checked={selectedProjectKeys.has(option.key)}
                  onChange={() => toggleProject(option)}
                  type="checkbox"
                />
                <span>{option.name}</span>
                <span className="text-xs text-[var(--workbench-muted)]">{option.teamName}</span>
              </label>
            ))}
            {state.projects.length > 0 ? (
              <button
                className="workbench-button-secondary mt-1 min-h-8 px-2 text-xs"
                onClick={() => update({ projects: [] })}
                type="button"
              >
                {t('workItems.crossProject.projects.clear')}
              </button>
            ) : null}
          </fieldset>
        </details>
        <label className="grid gap-1 text-xs text-[var(--workbench-muted)]">
          {t('workItems.crossProject.member')}
          <select
            className="workbench-input min-h-9 px-2 text-sm"
            onChange={(event) => update({ contributorMemberId: event.target.value || undefined })}
            value={state.contributorMemberId ?? ''}
          >
            <option value="">{t('workItems.crossProject.any')}</option>
            {memberOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-[var(--workbench-muted)]">
          {t('workItems.crossProject.jobRole')}
          <select
            className="workbench-input min-h-9 px-2 text-sm"
            onChange={(event) => update({ contributorJobRoleId: event.target.value || undefined })}
            value={state.contributorJobRoleId ?? ''}
          >
            <option value="">{t('workItems.crossProject.any')}</option>
            {jobRoleOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-[var(--workbench-muted)]">
          {t('workItems.crossProject.groupBy')}
          <select
            className="workbench-input min-h-9 px-2 text-sm"
            onChange={(event) => update({ grouping: event.target.value === 'assignee' ? 'assignee' : 'project' })}
            value={state.grouping}
          >
            <option value="project">{t('workItems.crossProject.groupBy.project')}</option>
            <option value="assignee">{t('workItems.crossProject.groupBy.assignee')}</option>
          </select>
        </label>
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            checked={state.mine}
            onChange={(event) => update({ mine: event.target.checked })}
            type="checkbox"
          />
          {t('workItems.crossProject.mine')}
        </label>
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            checked={!state.openOnly}
            onChange={(event) => update({ openOnly: !event.target.checked })}
            type="checkbox"
          />
          {t('workItems.crossProject.includeClosed')}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span aria-live="polite" className="text-xs text-[var(--workbench-muted)]">
            {copyLinkStatus === 'copied'
              ? t('workItems.crossProject.copyLink.copied')
              : copyLinkStatus === 'failed'
                ? t('workItems.crossProject.copyLink.failed')
                : ''}
          </span>
          <button
            className="workbench-button-secondary min-h-9 px-3 text-sm"
            onClick={() => {
              void onCopyLink().then((copied) => setCopyLinkStatus(copied ? 'copied' : 'failed'))
            }}
            type="button"
          >
            {t('workItems.crossProject.copyLink')}
          </button>
        </div>
      </section>
      {loadFailed ? null : (
        <p className="text-sm text-[var(--workbench-muted)]" data-testid="cross-project-work-items-count">
          {isLoading
            ? t('workItems.crossProject.loading')
            : t('workItems.crossProject.count').replace('{count}', String(totalCount))}
        </p>
      )}
      {!isLoading && !loadFailed && groups.length === 0 ? (
        <p className="workbench-panel px-4 py-6 text-sm text-[var(--workbench-muted)]">
          {t('workItems.crossProject.empty')}
        </p>
      ) : null}
      {groups.map((group) => {
        const heading = group.isUnassigned
          ? t(state.grouping === 'assignee'
            ? 'workItems.crossProject.group.noAssignee'
            : 'workItems.crossProject.group.noProject')
          : group.label
        return (
          <section
            aria-label={heading}
            className="workbench-panel overflow-x-auto"
            data-testid="cross-project-work-item-group"
            key={group.key}
          >
            <h2 className="flex items-baseline gap-2 px-4 pt-3 text-sm font-semibold text-[var(--workbench-text)]">
              <span>{heading}</span>
              {group.detail ? (
                <span className="text-xs font-normal text-[var(--workbench-muted)]">{group.detail}</span>
              ) : null}
              <span className="workbench-badge px-2 text-xs">{group.workItems.length}</span>
            </h2>
            <table className="mt-2 w-full border-collapse text-left text-sm">
              <thead>
                <tr className="workbench-table-head">
                  <th className="px-4 py-2" scope="col">{t('workItems.crossProject.column.workItem')}</th>
                  <th className="px-4 py-2" scope="col">{t('workItems.crossProject.column.status')}</th>
                  <th className="px-4 py-2 max-[760px]:hidden" scope="col">{t('workItems.crossProject.column.assignee')}</th>
                  <th className="px-4 py-2 max-[760px]:hidden" scope="col">{t('workItems.crossProject.column.contributors')}</th>
                  <th className="px-4 py-2 max-[760px]:hidden" scope="col">{t('workItems.crossProject.column.dueDate')}</th>
                </tr>
              </thead>
              <tbody>
                {group.workItems.map((workItem) => (
                  <tr
                    className="border-b border-[var(--workbench-border)] text-[var(--workbench-text)]"
                    key={`${workItem.teamId}:${workItem.id}`}
                  >
                    <td className="px-4 py-2">
                      <button
                        className="text-left font-medium hover:underline"
                        onClick={() => onOpenWorkItem(workItem)}
                        type="button"
                      >
                        {workItem.key ? (
                          <span className="mr-2 text-xs text-[var(--workbench-muted)]">{workItem.key}</span>
                        ) : null}
                        {workItem.title}
                      </button>
                    </td>
                    <td className="px-4 py-2">
                      {resolveWorkItemWorkflowStatusLabel(workItem, configurationsByTeam[workItem.teamId])}
                    </td>
                    <td className="px-4 py-2 max-[760px]:hidden">
                      {workItem.assigneeUserId ? resolveWorkItemAssignee(workItem) : '-'}
                    </td>
                    <td className="px-4 py-2 max-[760px]:hidden">
                      {formatContributors(workItem, memberLabels, roleLabels)}
                    </td>
                    <td className="px-4 py-2 max-[760px]:hidden">{workItem.dueDate || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )
      })}
    </div>
  )
}

/**
 * Formats a Work Item's contributors as member names, with the job role in parentheses.
 *
 * @param workItem - Work Item whose contributors to show.
 * @param memberLabels - Member display labels keyed by member key.
 * @param roleLabels - Job role names keyed by role ID.
 * @returns Comma-separated contributor labels, or `-` when there are none.
 */
function formatContributors(
  workItem: CanonicalWorkItem,
  memberLabels: ReadonlyMap<string, string>,
  roleLabels: ReadonlyMap<string, string>,
) {
  const labels = (workItem.contributorAssignments ?? []).map((assignment) => {
    const member = assignment.memberUserId
      ? memberLabels.get(assignment.memberUserId) ?? assignment.memberUserId
      : undefined
    const role = assignment.jobRoleId
      ? roleLabels.get(assignment.jobRoleId) ?? assignment.jobRoleId
      : undefined
    return member && role ? `${member} (${role})` : member ?? role ?? ''
  }).filter(Boolean)
  return labels.length > 0 ? labels.join(', ') : '-'
}
