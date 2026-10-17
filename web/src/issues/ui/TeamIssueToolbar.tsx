import { createSearchWorkItemTypeKey } from '@mukuroji/contracts'
import { type MessageKey } from '../../shared/i18n/i18n'
import {
  resolveWorkItemTypes,
  createWorkItemTypeWorkflowStatusKey,
  type WorkItemTypeWorkflowStatus,
} from '../../work-items/model/workItemDisplay'
import { type IssueViewMode, issueViewPanelId } from './teamIssueScreenShared'

/**
 * Issue 一覧の検索、status filter、表示切り替えをまとめた toolbar です。
 */
export function IssueToolbar({
  onSearchQueryChange,
  onStatusFilterChange,
  onWorkItemTypeFilterChange,
  onViewModeChange,
  searchQuery,
  statusFilter,
  teamId,
  t,
  viewMode,
  workItemTypeFilter,
  workItemTypes,
  workflowStatuses,
}: {
  /**
   * 検索 query を更新する callback です。
   */
  onSearchQueryChange: (query: string) => void
  /**
   * Workflow status filter を更新する callback です。
   */
  onStatusFilterChange: (status: string) => void
  /** Team-qualified Work Item Type filter callback. */
  onWorkItemTypeFilterChange: (workItemTypeKey: string) => void
  /**
   * Issue 表示 mode を更新する callback です。
   */
  onViewModeChange: (mode: IssueViewMode) => void
  /**
   * 検索 input の現在値です。
   */
  searchQuery: string
  /**
   * Status select の現在値です。
   */
  statusFilter: string
  /** Team-qualified Work Item Type key or the all-type sentinel. */
  workItemTypeFilter: string
  /** Team owning the Work Item Type definitions shown in this toolbar. */
  teamId: string
  /**
   * 画面文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * 現在表示中の Issue view mode です。
   */
  viewMode: IssueViewMode
  /** Work Item Types available to the Team. */
  workItemTypes: ReturnType<typeof resolveWorkItemTypes>
  /**
   * Status filter に表示する workflow status です。
   */
  workflowStatuses: readonly WorkItemTypeWorkflowStatus[]
}) {
  return (
    <div className="workbench-toolbar flex flex-wrap items-center justify-between gap-3 px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="grid gap-1">
          <span className="sr-only">{t('issues.search')}</span>
          <input
            aria-label={t('issues.search')}
            className="workbench-input h-9 w-[min(260px,calc(100vw-52px))] px-3.5 placeholder:text-[var(--workbench-muted-soft)]"
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder={t('issues.search')}
            type="search"
            value={searchQuery}
          />
        </label>
        <select
          aria-label={t('issues.filter.status')}
          className="workbench-input h-9 px-3"
          onChange={(event) => onStatusFilterChange(event.target.value)}
          value={statusFilter}
        >
          <option value="all">{t('tasks.filter.statusAll')}</option>
          {workflowStatuses.map(({ status, workItemTypeId }) => {
            const value = createWorkItemTypeWorkflowStatusKey(teamId, workItemTypeId, status.id)
            const workItemTypeName = workItemTypes.find((type) => type.id === workItemTypeId)?.name ??
              workItemTypeId
            return (
              <option key={value} value={value}>
                {workItemTypeName} · {status.name}
              </option>
            )
          })}
        </select>
        <select
          aria-label={t('tasks.filter.workItemType')}
          className="workbench-input h-9 px-3"
          onChange={(event) => onWorkItemTypeFilterChange(event.target.value)}
          value={workItemTypeFilter}
        >
          <option value="all">{t('tasks.filter.workItemTypeAll')}</option>
          {workItemTypes.map((type) => (
            <option
              key={createSearchWorkItemTypeKey(teamId, type.id)}
              value={createSearchWorkItemTypeKey(teamId, type.id)}
            >
              {type.name}
            </option>
          ))}
        </select>
      </div>
      <div className="inline-flex h-9 overflow-hidden rounded-[7px] border border-[var(--workbench-border-strong)] bg-white">
        {(['table', 'board'] as const).map((mode) => (
          <button
            aria-controls={issueViewPanelId}
            aria-pressed={viewMode === mode}
            className={`px-3.5 text-sm font-semibold transition ${
              viewMode === mode ? 'bg-[var(--workbench-primary)] text-white' : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]'
            }`}
            key={mode}
            onClick={() => onViewModeChange(mode)}
            type="button"
          >
            {t(`issues.view.${mode}`)}
          </button>
        ))}
      </div>
    </div>
  )
}
