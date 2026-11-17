import type {
  ArchivedPlanningEntitySummary,
  PlanningEntityType,
} from '@mukuroji/contracts'
import { useState } from 'react'
import {
  hasPendingPlanningRestore,
  type PlanningRestoreResultView,
} from '../model/archive'

/** Localized text of the archived plans panel. */
export type PlanningArchiveLabels = {
  /** Panel heading, also the disclosure toggle. */
  title: string
  /** What archiving and restoring do. */
  description: string
  /** Shown when the caller has no archived plan to restore. */
  empty: string
  /** Shown while the first page loads. */
  loading: string
  /** Shown when the list cannot be loaded. */
  error: string
  /** Loads the next page. */
  loadMore: string
  /** Formats when an entity was archived. */
  archivedAt: (archivedAt: string) => string
  /** Restore button. */
  restore: string
  /** Restore button while its request runs. */
  restoring: string
  /** Restores the references the previous restore left in the archive. */
  continueRestore: string
  /** Sentences describing a restore outcome. */
  restoreResult: (result: PlanningRestoreResultView) => string[]
}

/** Data and callbacks the archived plans panel needs from the page. */
export type PlanningArchiveController = {
  /** Restorable archived entities in display order. */
  entities: readonly ArchivedPlanningEntitySummary[]
  /** Whether the archive list has another page. */
  hasMore: boolean
  /** Whether the first page is loading. */
  isLoading: boolean
  /** Whether a further page is loading. */
  isLoadingMore: boolean
  /** List load error message. */
  errorMessage?: string
  /** Entity whose restore request is running. */
  restoringEntityId?: string
  /** Restore outcomes, newest first; earlier ones stay while references remain in the archive. */
  results: readonly PlanningRestoreResultView[]
  /** Starts loading the list when the panel opens. */
  onOpen: () => void
  /** Loads the next page. */
  onLoadMore: () => void | Promise<unknown>
  /** Reloads the list after an error. */
  onRetry: () => void
  /** Restores an entity, or continues a restore that left references behind. */
  onRestore: (entity: Pick<ArchivedPlanningEntitySummary, 'id' | 'title'>) => void | Promise<void>
}

/**
 * Lists the archived plans the caller can restore, closed until the caller opens it.
 *
 * @param props - Archive controller, initial open state, localized text, and the entity type and retry labels.
 * @returns The disclosure panel.
 */
export function PlanningArchivePanel({
  archive,
  defaultOpen = false,
  entityTypes,
  labels,
  retry,
}: {
  archive: PlanningArchiveController
  /** Whether the disclosure starts open, for stories. */
  defaultOpen?: boolean
  entityTypes: Record<PlanningEntityType, string>
  labels: PlanningArchiveLabels
  retry: string
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const isRestoring = archive.restoringEntityId !== undefined
  return (
    <details
      className="workbench-panel grid gap-4 p-5"
      data-testid="planning-archived-entities"
      open={isOpen}
      onToggle={(event) => {
        const open = event.currentTarget.open
        setIsOpen(open)
        if (open) archive.onOpen()
      }}
    >
      <summary className="cursor-pointer text-base font-semibold text-[var(--workbench-text)]">
        {labels.title}
      </summary>
      <p className="mt-3 max-w-[820px] text-sm font-medium text-[var(--workbench-muted)]">
        {labels.description}
      </p>
      {archive.results.map((result) => (
        <div
          className="mt-3 grid gap-2 rounded-lg border border-[var(--workbench-border)] px-4 py-3"
          data-entity-id={result.entityId}
          data-testid="planning-restore-result"
          key={result.entityId}
          role="status"
        >
          {labels.restoreResult(result).map((sentence) => (
            <p className="text-sm font-medium text-[var(--workbench-text)]" key={sentence}>
              {sentence}
            </p>
          ))}
          {hasPendingPlanningRestore(result.summary) ? (
            <div>
              <button
                aria-label={`${labels.continueRestore}: ${result.title}`}
                className="workbench-button-secondary min-h-9 px-3"
                data-testid="planning-restore-continue"
                disabled={isRestoring}
                type="button"
                onClick={() => void archive.onRestore({ id: result.entityId, title: result.title })}
              >
                {archive.restoringEntityId === result.entityId ? labels.restoring : labels.continueRestore}
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {archive.errorMessage ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
          <p className="text-sm font-semibold text-fg-red-800">{archive.errorMessage}</p>
          <button className="workbench-button-secondary min-h-9 px-3" type="button" onClick={archive.onRetry}>
            {retry}
          </button>
        </div>
      ) : archive.isLoading ? (
        <p className="mt-3 text-sm font-semibold text-[var(--workbench-muted)]">{labels.loading}</p>
      ) : archive.entities.length === 0 && !archive.hasMore ? (
        <p className="mt-3 text-sm font-medium text-[var(--workbench-muted)]">{labels.empty}</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {archive.entities.map((entity) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] px-4 py-3"
              data-testid={`planning-archived-entity-${entity.id}`}
              key={entity.id}
            >
              <div className="grid min-w-0 gap-1">
                <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">{entity.title}</p>
                <p className="text-xs font-medium text-[var(--workbench-muted)]">
                  {entityTypes[entity.type]} · {entity.id} · {labels.archivedAt(entity.archivedAt)}
                </p>
              </div>
              <button
                aria-label={`${labels.restore}: ${entity.title}`}
                className="workbench-button-secondary min-h-9 px-3"
                disabled={isRestoring}
                type="button"
                onClick={() => void archive.onRestore(entity)}
              >
                {archive.restoringEntityId === entity.id ? labels.restoring : labels.restore}
              </button>
            </li>
          ))}
        </ul>
      )}
      {archive.hasMore && !archive.errorMessage && !archive.isLoading ? (
        <div className="mt-3">
          <button
            className="workbench-button-secondary min-h-9 px-3"
            disabled={archive.isLoadingMore}
            type="button"
            onClick={() => void archive.onLoadMore()}
          >
            {archive.isLoadingMore ? labels.loading : labels.loadMore}
          </button>
        </div>
      ) : null}
    </details>
  )
}
