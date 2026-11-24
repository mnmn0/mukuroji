import { useState } from 'react'
import type { CustomerSavedView } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { ConfirmDeleteButton } from './CustomerEditors'

/** Props for the saved Customer view list with rename, overwrite, and delete actions. */
export type CustomerSavedViewManagerProps = {
  /** Saved views to manage. */
  views: readonly CustomerSavedView[]
  /** Whether a saved-view change is being sent. */
  isSaving: boolean
  /** Renames one saved view. Resolves true when it was saved. */
  onRename: (view: CustomerSavedView, name: string) => Promise<boolean>
  /** Replaces one saved view's filters and grouping with the current directory state. */
  onReplaceFilters: (view: CustomerSavedView) => Promise<boolean>
  /** Deletes one saved view. */
  onDelete: (view: CustomerSavedView) => Promise<boolean>
  /** Translator for control copy. */
  t: (key: MessageKey) => string
}

/** Lists saved Customer views with the edit actions a member who manages views may use.
 *
 * @param props Saved views, progress state, and edit callbacks.
 * @returns A collapsible saved-view management list.
 */
export function CustomerSavedViewManager({
  isSaving,
  onDelete,
  onRename,
  onReplaceFilters,
  t,
  views,
}: CustomerSavedViewManagerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [renamingViewId, setRenamingViewId] = useState<string>()
  if (views.length === 0) return null
  return (
    <div className="grid basis-full gap-2">
      <button
        aria-expanded={isOpen}
        className="workbench-button-secondary min-h-9 justify-self-start px-3 text-xs"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        {isOpen ? t('customers.views.closeManage') : t('customers.views.manage')}
      </button>
      {isOpen ? (
        <ul aria-label={t('customers.views.listLabel')} className="grid gap-2">
          {views.map((view) => (
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--workbench-border)] px-3 py-2 text-sm" key={view.id}>
              {renamingViewId === view.id ? (
                <RenameViewForm
                  isSaving={isSaving}
                  // A refreshed revision starts a fresh draft instead of pairing old input with new data.
                  key={view.revision}
                  onCancel={() => setRenamingViewId(undefined)}
                  onRename={async (name) => {
                    if (await onRename(view, name)) {
                      setRenamingViewId((current) => current === view.id ? undefined : current)
                    }
                  }}
                  t={t}
                  view={view}
                />
              ) : (
                <>
                  <span className="min-w-0 truncate font-semibold text-[var(--workbench-text)]">{view.name}</span>
                  <span className="flex flex-wrap gap-2">
                    <button
                      aria-label={t('customers.views.renameNamed').replace('{name}', view.name)}
                      className="workbench-button-secondary min-h-8 px-3 text-xs"
                      disabled={isSaving}
                      onClick={() => setRenamingViewId(view.id)}
                      type="button"
                    >
                      {t('customers.views.rename')}
                    </button>
                    <button
                      aria-label={t('customers.views.replaceNamed').replace('{name}', view.name)}
                      className="workbench-button-secondary min-h-8 px-3 text-xs"
                      disabled={isSaving}
                      onClick={() => void onReplaceFilters(view)}
                      type="button"
                    >
                      {t('customers.views.replace')}
                    </button>
                    <ConfirmDeleteButton
                      disabled={isSaving}
                      label={t('customers.edit.deleteNamed').replace('{name}', view.name)}
                      onDelete={() => void onDelete(view)}
                      t={t}
                    />
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Renders the inline name field used to rename one saved view. */
function RenameViewForm({
  isSaving,
  onCancel,
  onRename,
  t,
  view,
}: {
  /** Whether a saved-view change is being sent. */
  isSaving: boolean
  /** Closes the form without saving. */
  onCancel: () => void
  /** Saves the trimmed name. */
  onRename: (name: string) => Promise<void>
  /** Translator for control copy. */
  t: (key: MessageKey) => string
  /** Saved view being renamed. */
  view: CustomerSavedView
}) {
  const [name, setName] = useState(view.name)
  const trimmedName = name.trim()
  return (
    <form
      className="flex min-w-0 flex-1 flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmedName || isSaving) return
        void onRename(trimmedName)
      }}
    >
      <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
        <span>{t('customers.views.nameLabel')}</span>
        <input
          className="workbench-input min-h-9 w-full"
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </label>
      <button className="workbench-button-primary min-h-9 px-3 text-xs" disabled={!trimmedName || trimmedName === view.name || isSaving} type="submit">
        {isSaving ? t('customers.filters.saving') : t('customers.filters.save')}
      </button>
      <button className="workbench-button-secondary min-h-9 px-3 text-xs" onClick={onCancel} type="button">
        {t('customers.edit.cancel')}
      </button>
    </form>
  )
}
