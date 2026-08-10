import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SavedViewVisibility } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  CheckIcon,
  ChevronIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PinIcon,
  SlidersIcon,
  StarIcon,
} from '../../shared/ui/icons'
import { useModalFocus } from '../../shared/ui/useModalFocus'
import type { TaskViewPresentationSettings } from '../model/taskViewPresentation'

const taskViewDensities: readonly TaskViewPresentationSettings['density'][] = [
  'compact',
  'comfortable',
  'spacious',
]

/** A compact option available to grouping, subgrouping, or column controls. */
export type TaskViewFieldOption = {
  /** Stable field identifier persisted in a view definition. */
  id: string
  /** Human-readable field label. */
  label: string
}

/** Saved-view summary rendered by the view switcher. */
export type TaskViewOption = {
  /** Whether the current user may edit or delete the saved definition. */
  canEdit: boolean
  /** Whether the current user has favorited the view. */
  favorite: boolean
  /** Stable saved-view identifier. */
  id: string
  /** Whether the view is explicitly configured as the current user's personal default. */
  isPersonalDefault: boolean
  /** Whether the view is the default for its Team scope. */
  isTeamDefault: boolean
  /** Human-readable saved-view name. */
  name: string
  /** Whether the current user has pinned the view. */
  pinned: boolean
  /** Team receiving a Team-visible view. */
  teamId?: string
  /** Sharing boundary of the saved view. */
  visibility: SavedViewVisibility
}

/** Draft submitted when a user saves the current state as a new view. */
export type TaskViewSaveDraft = {
  /** Optional description explaining the view's intent. */
  description?: string
  /** Human-readable saved-view name. */
  name: string
  /** Team receiving a Team-visible view. */
  teamId?: string
  /** Sharing boundary of the new view. */
  visibility: SavedViewVisibility
}

/** Preference fields that can be changed without replacing a view definition. */
export type TaskViewPreferencePatch = {
  /** Next favorite preference. */
  favorite?: boolean
  /** Next personal-default preference. */
  isDefault?: boolean
  /** Next Team-default preference. */
  isTeamDefault?: boolean
  /** Next pin preference. */
  pinned?: boolean
}

/** Team option available when a Team-visible view is created. */
export type TaskViewTeamOption = {
  /** Stable Team identifier. */
  id: string
  /** Human-readable Team label. */
  name: string
}

/** Props accepted by the shared task-view lifecycle and display toolbar. */
export type TaskViewToolbarProps = {
  /** Name used for the unsaved built-in view. */
  builtInName: string
  /** Whether the current viewer may assign a Team default in this resource scope. */
  canSetTeamDefault?: boolean
  /** Whether the current user may create saved views. */
  canWrite: boolean
  /** Whether the current user may create Workspace-shared views. */
  canManageShared: boolean
  /** Column choices supported by the current surface. */
  columnOptions: readonly TaskViewFieldOption[]
  /** Current error from a saved-view mutation. */
  errorMessage?: string
  /** Grouping choices supported by the current surface. */
  groupOptions: readonly TaskViewFieldOption[]
  /** Column identifiers that the current layout requires to remain visible. */
  requiredColumnIds?: readonly string[]
  /** Whether the current surface can render the child Work Item toggle. */
  supportsSubtasks?: boolean
  /** Whether the active layout renders grouping, columns, density, and wrapping. */
  supportsLayoutPresentation?: boolean
  /** Whether the current surface implements J/K and range-selection shortcuts. */
  supportsKeyboardSelection?: boolean
  /** Whether the active table can render persisted column width and pin metadata. */
  supportsColumnLayoutMetadata?: boolean
  /** Whether the active board can show or hide empty workflow columns. */
  supportsEmptyGroups?: boolean
  /** Whether the effective definition differs from its saved baseline. */
  isDirty: boolean
  /** Whether a saved-view mutation is in progress. */
  isSaving?: boolean
  /** Migration and permission fallback warnings for the current definition. */
  migrationWarnings?: readonly string[]
  /** Copies a permalink containing the selected view and temporary overrides. */
  onCopyLink: () => void | Promise<void>
  /** Deletes a saved view definition. */
  onDelete: (viewId: string) => void | Promise<void>
  /** Duplicates a saved view without mutating the original definition. */
  onDuplicate: (viewId: string) => void | Promise<void>
  /** Changes favorite, pin, personal-default, or Team-default preferences. */
  onPatchPreference: (
    viewId: string,
    patch: TaskViewPreferencePatch,
  ) => void | Promise<void>
  /** Removes temporary overrides and restores the selected baseline. */
  onReset: () => void
  /** Persists the current effective definition as a new saved view. */
  onSaveAs: (draft: TaskViewSaveDraft) => void | Promise<void>
  /** Selects a saved view, or the built-in fallback when omitted. */
  onSelectView: (viewId?: string) => void
  /** Replaces presentation settings in the effective view definition. */
  onSettingsChange: (settings: TaskViewPresentationSettings) => void
  /** Updates the selected saved definition with temporary overrides. */
  onUpdate?: () => void | Promise<void>
  /** Selected saved view, or undefined for the built-in view. */
  selectedView?: TaskViewOption
  /** Effective presentation settings. */
  settings: TaskViewPresentationSettings
  /** Team choices available to the save sheet. */
  teams: readonly TaskViewTeamOption[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Saved views available on the current surface and scope. */
  views: readonly TaskViewOption[]
}

/**
 * Renders the shared task-view switcher, lifecycle actions, and display settings.
 *
 * @param props - Effective view state, saved-view lifecycle callbacks, and supported fields.
 * @returns A responsive two-level toolbar and save-view sheet.
 */
export function TaskViewToolbar({
  builtInName,
  canManageShared,
  canSetTeamDefault = false,
  canWrite,
  columnOptions,
  errorMessage,
  groupOptions,
  requiredColumnIds = ['title'],
  supportsSubtasks = false,
  supportsLayoutPresentation = true,
  supportsKeyboardSelection = false,
  supportsColumnLayoutMetadata = false,
  supportsEmptyGroups = false,
  isDirty,
  isSaving = false,
  migrationWarnings = [],
  onCopyLink,
  onDelete,
  onDuplicate,
  onPatchPreference,
  onReset,
  onSaveAs,
  onSelectView,
  onSettingsChange,
  onUpdate,
  selectedView,
  settings,
  teams,
  t,
  views,
}: TaskViewToolbarProps) {
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isMoreOpen, setIsMoreOpen] = useState(false)
  const [isSaveSheetOpen, setIsSaveSheetOpen] = useState(false)
  const [deleteConfirmationViewId, setDeleteConfirmationViewId] = useState<string>()
  const [copied, setCopied] = useState(false)
  const sortedViews = useMemo(
    () => [...views].sort((left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      Number(right.favorite) - Number(left.favorite) ||
      left.name.localeCompare(right.name),
    ),
    [views],
  )

  /** Copies the canonical view link and briefly exposes a visible confirmation. */
  const copyLink = async () => {
    await onCopyLink()
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2_000)
  }

  return (
    <section
      className="workbench-panel mb-3 overflow-visible"
      data-can-set-team-default={canSetTeamDefault ? 'true' : 'false'}
      data-testid="task-view-toolbar"
    >
      <div className="grid gap-2 px-3 py-2.5 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
          <div className="col-span-2 min-w-0 sm:col-span-1">
            <Popover
              align="left"
              button={(
                <button
                  aria-expanded={isSwitcherOpen}
                  aria-haspopup="menu"
                  className="inline-flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-[var(--workbench-border-strong)] bg-white px-3 text-sm font-semibold text-[var(--workbench-text)] shadow-sm transition hover:border-[#99d7cf] hover:bg-[#f6fbfa] sm:w-auto sm:max-w-[min(320px,70vw)]"
                  onClick={() => setIsSwitcherOpen((isOpen) => !isOpen)}
                  type="button"
                >
                  <span className="truncate">{selectedView?.name ?? builtInName}</span>
                  <ChevronIcon className="h-4 w-4 flex-none fill-none stroke-current stroke-2 text-[var(--workbench-muted)]" />
                </button>
              )}
              isOpen={isSwitcherOpen}
              onClose={() => setIsSwitcherOpen(false)}
            >
              <div
                aria-label={t('search.saved.title')}
                className="max-h-[min(420px,70vh)] w-[min(340px,calc(100vw-32px))] overflow-auto p-2"
                role="menu"
              >
                <ViewOptionButton
                  active={!selectedView}
                  label={builtInName}
                  meta={t('taskViews.builtIn')}
                  onClick={() => {
                    onSelectView(undefined)
                    setIsSwitcherOpen(false)
                  }}
                />
                {sortedViews.map((view) => (
                  <ViewOptionButton
                    active={selectedView?.id === view.id}
                    badge={view.pinned ? <PinIcon className="h-3.5 w-3.5" filled />
                      : view.favorite ? <StarIcon className="h-3.5 w-3.5" filled /> : undefined}
                    key={view.id}
                    label={view.name}
                    meta={formatViewMeta(view, t)}
                    onClick={() => {
                      onSelectView(view.id)
                      setIsSwitcherOpen(false)
                    }}
                  />
                ))}
                {sortedViews.length === 0 ? (
                  <p className="px-3 py-5 text-center text-xs font-medium text-[var(--workbench-muted)]">
                    {t('search.saved.empty')}
                  </p>
                ) : null}
              </div>
            </Popover>
          </div>

          <span
            className={isDirty ? 'workbench-badge-warning' : 'workbench-badge'}
            data-testid="task-view-dirty-state"
          >
            {isDirty ? t('taskViews.dirty') : t('taskViews.clean')}
          </span>

          {canWrite && isDirty && selectedView?.canEdit && onUpdate ? (
            <button
              className="workbench-button-primary h-9 px-3"
              disabled={isSaving}
              onClick={() => runToolbarAction(onUpdate)}
              type="button"
            >
              {t('search.saved.update')}
            </button>
          ) : null}
          {canWrite ? (
            <button
              className="workbench-button-secondary col-span-2 h-9 px-3 sm:col-span-1"
              disabled={isSaving}
              onClick={() => setIsSaveSheetOpen(true)}
              type="button"
            >
              {t('taskViews.saveAs')}
            </button>
          ) : null}
          {isDirty ? (
            <button
              className="col-span-2 h-9 rounded-md px-2.5 text-left text-xs font-semibold text-[var(--workbench-muted)] transition hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)] sm:col-span-1 sm:text-center"
              onClick={onReset}
              type="button"
            >
              {t('taskViews.reset')}
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            aria-label={t('taskViews.copyLink')}
            className="grid h-9 w-9 place-items-center rounded-md text-[var(--workbench-muted)] transition hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)]"
            onClick={() => runToolbarAction(copyLink)}
            title={t('taskViews.copyLink')}
            type="button"
          >
            {copied ? <CheckIcon className="h-4 w-4 text-[var(--workbench-primary)]" />
              : <CopyIcon className="h-4 w-4" />}
          </button>
          <button
            aria-expanded={isSettingsOpen}
            className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-semibold transition ${
              isSettingsOpen
                ? 'border-[#99d7cf] bg-[#e5f7f4] text-[var(--workbench-primary)]'
                : 'border-[var(--workbench-border-strong)] bg-white text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]'
            }`}
            onClick={() => setIsSettingsOpen((isOpen) => !isOpen)}
            type="button"
          >
            <SlidersIcon className="h-4 w-4" />
            {t('taskViews.settings')}
          </button>
          {canWrite && selectedView ? (
            <Popover
              align="right"
              button={(
                <button
                  aria-expanded={isMoreOpen}
                  aria-label={t('tasks.action.more')}
                  aria-haspopup="menu"
                  className="grid h-9 w-9 place-items-center rounded-md text-[var(--workbench-muted)] transition hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)]"
                  onClick={() => setIsMoreOpen((isOpen) => !isOpen)}
                  type="button"
                >
                  <MoreHorizontalIcon className="h-5 w-5" />
                </button>
              )}
              isOpen={isMoreOpen}
              onClose={() => setIsMoreOpen(false)}
            >
              <div className="grid w-52 gap-1 p-1.5" role="menu">
                <TaskViewPreferenceButton
                  active={selectedView.favorite}
                  disabled={isSaving}
                  icon={<StarIcon className="h-4 w-4" filled={selectedView.favorite} />}
                  label={t('search.saved.favorite')}
                  onClick={() => runToolbarAction(() => onPatchPreference(selectedView.id, {
                    favorite: !selectedView.favorite,
                  }))}
                />
                <TaskViewPreferenceButton
                  active={selectedView.pinned}
                  disabled={isSaving}
                  icon={<PinIcon className="h-4 w-4" filled={selectedView.pinned} />}
                  label={t('search.saved.pin')}
                  onClick={() => runToolbarAction(() => onPatchPreference(selectedView.id, {
                    pinned: !selectedView.pinned,
                  }))}
                />
                <TaskViewPreferenceButton
                  active={selectedView.isPersonalDefault}
                  disabled={isSaving}
                  label={t('search.saved.makeDefault')}
                  onClick={() => runToolbarAction(() => onPatchPreference(selectedView.id, {
                    isDefault: !selectedView.isPersonalDefault,
                  }))}
                />
                {selectedView.visibility === 'team' && canSetTeamDefault ? (
                  <TaskViewPreferenceButton
                    active={selectedView.isTeamDefault}
                    disabled={isSaving}
                    label={t('taskViews.teamDefault')}
                    onClick={() => runToolbarAction(() => onPatchPreference(selectedView.id, {
                      isTeamDefault: !selectedView.isTeamDefault,
                    }))}
                  />
                ) : null}
                <TaskViewPreferenceButton
                  disabled={isSaving}
                  label={t('search.saved.clone')}
                  onClick={() => runToolbarAction(() => onDuplicate(selectedView.id))}
                />
                {selectedView.canEdit ? (
                  deleteConfirmationViewId === selectedView.id ? (
                    <div className="grid grid-cols-2 gap-1 border-t border-red-100 pt-1">
                      <TaskViewPreferenceButton
                        label={t('sidebar.archive.cancel')}
                        onClick={() => setDeleteConfirmationViewId(undefined)}
                      />
                      <TaskViewPreferenceButton
                        danger
                        disabled={isSaving}
                        label={t('search.saved.delete')}
                        onClick={() => runToolbarAction(() => onDelete(selectedView.id))}
                      />
                    </div>
                  ) : (
                  <TaskViewPreferenceButton
                      danger
                      label={t('search.saved.delete')}
                      onClick={() => setDeleteConfirmationViewId(selectedView.id)}
                    />
                  )
                ) : null}
              </div>
            </Popover>
          ) : null}
        </div>
      </div>

      {copied ? (
        <p className="border-t border-[var(--workbench-border)] px-3 py-2 text-xs font-semibold text-[var(--workbench-primary)]" role="status">
          {t('taskViews.copied')}
        </p>
      ) : null}
      {errorMessage ? (
        <p className="border-t border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {migrationWarnings.length > 0 ? (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800" role="status">
          <p>{t('taskViews.migration')}</p>
          <ul className="mt-1 list-disc pl-4 font-medium">
            {migrationWarnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      ) : null}
      {isSettingsOpen ? (
        <TaskViewSettingsPanel
          columnOptions={columnOptions}
          groupOptions={groupOptions}
          onChange={onSettingsChange}
          requiredColumnIds={requiredColumnIds}
          settings={settings}
          supportsColumnLayoutMetadata={supportsColumnLayoutMetadata}
          supportsEmptyGroups={supportsEmptyGroups}
          supportsKeyboardSelection={supportsKeyboardSelection}
          supportsLayoutPresentation={supportsLayoutPresentation}
          supportsSubtasks={supportsSubtasks}
          t={t}
        />
      ) : null}

      {canWrite && isSaveSheetOpen ? (
        <SaveViewSheet
          canManageShared={canManageShared}
          errorMessage={errorMessage}
          isSaving={isSaving}
          onClose={() => setIsSaveSheetOpen(false)}
          onSave={async (draft) => {
            await onSaveAs(draft)
            setIsSaveSheetOpen(false)
          }}
          t={t}
          teams={teams}
        />
      ) : null}
    </section>
  )
}

/**
 * Runs a callback whose owner reports failures through the toolbar error state.
 *
 * @param operation - Synchronous or asynchronous lifecycle operation to start.
 * @returns Nothing after scheduling rejection handling.
 */
function runToolbarAction(operation: () => void | Promise<void>): void {
  try {
    void Promise.resolve(operation()).catch(() => undefined)
  } catch {
    return
  }
}

/** Props accepted by a lightweight anchored popover. */
type PopoverProps = {
  /** Horizontal edge used to align the popover. */
  align: 'left' | 'right'
  /** Trigger node rendered inside the positioned root. */
  button: ReactNode
  /** Popover content. */
  children: ReactNode
  /** Whether the content is visible. */
  isOpen: boolean
  /** Closes the popover after outside pointer input. */
  onClose: () => void
}

/** Renders a positioned popover with outside-click dismissal. */
function Popover({ align, button, children, isOpen, onClose }: PopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return undefined

    /** Closes the popover after pointer input outside its positioned root. */
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        onClose()
      }
    }

    /** Closes the popover while preserving the trigger as the next tab stop. */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          onClose()
        }
      }}
      ref={rootRef}
    >
      {button}
      {isOpen ? (
        <div
          className={`absolute top-[calc(100%+6px)] z-40 rounded-md border border-[var(--workbench-border-strong)] bg-white shadow-xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** Props accepted by one saved-view switcher option. */
type ViewOptionButtonProps = {
  /** Whether this option is selected. */
  active: boolean
  /** Optional favorite or pin marker. */
  badge?: ReactNode
  /** Primary view label. */
  label: string
  /** Sharing and default metadata. */
  meta: string
  /** Selects the option. */
  onClick: () => void
}

/** Renders one accessible saved-view choice. */
function ViewOptionButton({ active, badge, label, meta, onClick }: ViewOptionButtonProps) {
  return (
    <button
      aria-checked={active}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition ${
        active ? 'bg-[#e5f7f4]' : 'hover:bg-[var(--workbench-surface-muted)]'
      }`}
      onClick={onClick}
      role="menuitemradio"
      type="button"
    >
      <span className={`grid h-4 w-4 flex-none place-items-center rounded-full border ${
        active ? 'border-[var(--workbench-primary)] bg-[var(--workbench-primary)] text-white' : 'border-[var(--workbench-border-strong)]'
      }`}>
        {active ? <CheckIcon className="h-2.5 w-2.5" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-[var(--workbench-text)]">{label}</span>
        <span className="mt-0.5 block text-[11px] font-medium text-[var(--workbench-muted)]">{meta}</span>
      </span>
      <span className="flex-none text-[var(--workbench-primary)]">{badge}</span>
    </button>
  )
}

/** Props accepted by a saved-view preference action. */
type PreferenceButtonProps = {
  /** Whether this preference is active. */
  active?: boolean
  /** Whether the action uses destructive styling. */
  danger?: boolean
  /** Whether a concurrent saved-view mutation blocks the action. */
  disabled?: boolean
  /** Optional leading icon. */
  icon?: ReactNode
  /** Visible action label. */
  label: string
  /** Runs the preference action. */
  onClick: () => void
}

/**
 * Renders one compact preference toggle or lifecycle action.
 *
 * @param props - Visible label, optional toggle state, and action callback.
 * @returns An accessible menu item that exposes checked state for toggles.
 */
export function TaskViewPreferenceButton({
  active,
  danger = false,
  disabled = false,
  icon,
  label,
  onClick,
}: PreferenceButtonProps) {
  const isActive = active === true
  return (
    <button
      aria-checked={active}
      className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? 'text-red-700 hover:bg-red-50'
          : isActive
            ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
            : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]'
      }`}
      disabled={disabled}
      onClick={onClick}
      role={active === undefined ? 'menuitem' : 'menuitemcheckbox'}
      type="button"
    >
      {icon}
      <span>{label}</span>
      {active ? <CheckIcon className="ml-auto h-3.5 w-3.5" /> : null}
    </button>
  )
}

/** Props accepted by the expanded display-settings panel. */
export type TaskViewSettingsPanelProps = {
  /** Column choices supported by the current surface. */
  columnOptions: readonly TaskViewFieldOption[]
  /** Grouping choices supported by the current surface. */
  groupOptions: readonly TaskViewFieldOption[]
  /** Applies a complete next presentation state. */
  onChange: (settings: TaskViewPresentationSettings) => void
  /** Columns that cannot be hidden in the current layout. */
  requiredColumnIds: readonly string[]
  /** Current presentation state. */
  settings: TaskViewPresentationSettings
  /** Whether grouping, columns, density, and wrapping are implemented by the active layout. */
  supportsLayoutPresentation: boolean
  /** Whether the active table renders persisted column width and pin metadata. */
  supportsColumnLayoutMetadata: boolean
  /** Whether the active board renders empty workflow columns. */
  supportsEmptyGroups: boolean
  /** Whether J/K and range-selection shortcuts are implemented by the surface. */
  supportsKeyboardSelection: boolean
  /** Whether child Work Item visibility is implemented by the surface. */
  supportsSubtasks: boolean
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders group, subgroup, columns, density, and display settings. */
export function TaskViewSettingsPanel({
  columnOptions,
  groupOptions,
  onChange,
  requiredColumnIds,
  settings,
  supportsColumnLayoutMetadata,
  supportsEmptyGroups,
  supportsKeyboardSelection,
  supportsLayoutPresentation,
  supportsSubtasks,
  t,
}: TaskViewSettingsPanelProps) {
  const sortRules = settings.sort ?? []
  const sortRemoveButtonRefs = useRef(new Map<number, HTMLButtonElement>())
  const sortFieldSelectRefs = useRef(new Map<number, HTMLSelectElement>())
  const addSortButtonRef = useRef<HTMLButtonElement>(null)
  const pendingSortFocusRef = useRef<number | 'add' | `field:${number}` | undefined>(undefined)
  const [sortFocusRequestId, setSortFocusRequestId] = useState(0)
  const nextSortOption = groupOptions.find(
    (option) => !sortRules.some((sort) => sort.field === option.id),
  )
  useEffect(() => {
    const pendingSortFocus = pendingSortFocusRef.current
    if (pendingSortFocus === undefined) return
    pendingSortFocusRef.current = undefined
    if (pendingSortFocus === 'add') {
      addSortButtonRef.current?.focus()
    } else if (typeof pendingSortFocus === 'string') {
      const fieldIndex = Number(pendingSortFocus.slice('field:'.length))
      sortFieldSelectRefs.current.get(fieldIndex)?.focus()
    } else {
      sortRemoveButtonRefs.current.get(pendingSortFocus)?.focus()
    }
  }, [sortFocusRequestId])
  return (
    <div className="grid gap-4 border-t border-[var(--workbench-border)] bg-[#fbfdfd] px-3 py-3 sm:grid-cols-[minmax(150px,0.7fr)_minmax(150px,0.7fr)_minmax(220px,1.2fr)]" data-testid="task-view-settings">
      {supportsLayoutPresentation ? (
        <fieldset className="grid content-start gap-1.5">
          <legend className="text-xs font-semibold text-[var(--workbench-muted)]">
            {t('taskViews.group')}
          </legend>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(104px,0.55fr)] gap-2">
            <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
              {t('taskViews.group.field')}
              <select
                className="workbench-input h-9 min-w-0 px-2.5 text-sm font-medium text-[var(--workbench-text)]"
                onChange={(event) => onChange({
                  ...settings,
                  groupBy: event.target.value || undefined,
                  subgroupBy: !event.target.value || event.target.value === settings.subgroupBy
                    ? undefined
                    : settings.subgroupBy,
                })}
                value={settings.groupBy ?? ''}
              >
                <option value="">{t('taskViews.none')}</option>
                {groupOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
              {t('taskViews.group.direction')}
              <select
                className="workbench-input h-9 min-w-0 px-2.5 text-sm font-medium text-[var(--workbench-text)]"
                disabled={!settings.groupBy}
                onChange={(event) => onChange({
                  ...settings,
                  groupDirection: event.target.value === 'desc' ? 'desc' : 'asc',
                })}
                value={settings.groupDirection ?? 'asc'}
              >
                <option value="asc">{t('taskViews.sort.asc')}</option>
                <option value="desc">{t('taskViews.sort.desc')}</option>
              </select>
            </label>
          </div>
        </fieldset>
      ) : null}
      {supportsLayoutPresentation ? (
        <fieldset className="grid content-start gap-1.5">
          <legend className="text-xs font-semibold text-[var(--workbench-muted)]">
            {t('taskViews.subgroup')}
          </legend>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(104px,0.55fr)] gap-2">
            <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
              {t('taskViews.group.field')}
              <select
                className="workbench-input h-9 min-w-0 px-2.5 text-sm font-medium text-[var(--workbench-text)]"
                disabled={!settings.groupBy}
                onChange={(event) => onChange({
                  ...settings,
                  subgroupBy: event.target.value || undefined,
                })}
                value={settings.subgroupBy ?? ''}
              >
                <option value="">{t('taskViews.none')}</option>
                {groupOptions.filter((option) => option.id !== settings.groupBy).map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
              {t('taskViews.group.direction')}
              <select
                className="workbench-input h-9 min-w-0 px-2.5 text-sm font-medium text-[var(--workbench-text)]"
                disabled={!settings.subgroupBy}
                onChange={(event) => onChange({
                  ...settings,
                  subgroupDirection: event.target.value === 'desc' ? 'desc' : 'asc',
                })}
                value={settings.subgroupDirection ?? 'asc'}
              >
                <option value="asc">{t('taskViews.sort.asc')}</option>
                <option value="desc">{t('taskViews.sort.desc')}</option>
              </select>
            </label>
          </div>
        </fieldset>
      ) : null}
      {supportsLayoutPresentation ? <fieldset className="grid content-start gap-1.5">
        <legend className="text-xs font-semibold text-[var(--workbench-muted)]">{t('taskViews.density')}</legend>
        <div className="inline-flex w-fit rounded-md border border-[var(--workbench-border-strong)] bg-white p-0.5">
          {taskViewDensities.map((density) => (
            <button
              aria-pressed={settings.density === density}
              className={`h-8 rounded px-3 text-xs font-semibold transition ${
                settings.density === density
                  ? 'bg-[var(--workbench-primary)] text-white'
                  : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'
              }`}
              key={density}
              onClick={() => onChange({ ...settings, density })}
              type="button"
            >
              {t(`taskViews.density.${density}`)}
            </button>
          ))}
        </div>
      </fieldset> : null}
      {supportsLayoutPresentation ? <fieldset className="grid content-start gap-2 sm:col-span-3">
        <legend className="text-xs font-semibold text-[var(--workbench-muted)]">{t('taskViews.sort')}</legend>
        <div className="grid gap-2">
          {sortRules.map((sort, index) => {
            const availableOptions = groupOptions.filter((option) =>
              option.id === sort.field || !sortRules.some((rule) => rule.field === option.id)
            )
            const position = String(index + 1)
            return (
              <div
                className="grid gap-2 rounded-md border border-[var(--workbench-border)] bg-white p-2 sm:grid-cols-[minmax(150px,1fr)_minmax(120px,0.55fr)_auto]"
                data-testid="task-view-sort-rule"
                key={index}
              >
                <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
                  {t('taskViews.sort.field').replace('{index}', position)}
                  <select
                    className="workbench-input h-9 px-2.5 text-sm font-medium text-[var(--workbench-text)]"
                    onChange={(event) => onChange({
                      ...settings,
                      sort: sortRules.map((rule, ruleIndex) => ruleIndex === index
                        ? { ...rule, field: event.target.value }
                        : rule),
                    })}
                    ref={(element) => {
                      if (element) {
                        sortFieldSelectRefs.current.set(index, element)
                      } else {
                        sortFieldSelectRefs.current.delete(index)
                      }
                    }}
                    value={sort.field}
                  >
                    {availableOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
                  {t('taskViews.sort.direction').replace('{index}', position)}
                  <select
                    className="workbench-input h-9 px-2.5 text-sm font-medium text-[var(--workbench-text)]"
                    onChange={(event) => onChange({
                      ...settings,
                      sort: sortRules.map((rule, ruleIndex) => ruleIndex === index
                        ? {
                            ...rule,
                            direction: event.target.value === 'desc' ? 'desc' : 'asc',
                          }
                        : rule),
                    })}
                    value={sort.direction}
                  >
                    <option value="asc">{t('taskViews.sort.asc')}</option>
                    <option value="desc">{t('taskViews.sort.desc')}</option>
                  </select>
                </label>
                <button
                  aria-label={t('taskViews.sort.remove').replace('{index}', position)}
                  className="self-end rounded-md px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50"
                  onClick={() => {
                    const nextSortRules = sortRules.filter(
                      (_, ruleIndex) => ruleIndex !== index,
                    )
                    pendingSortFocusRef.current = nextSortRules.length === 0
                      ? 'add'
                      : Math.min(index, nextSortRules.length - 1)
                    setSortFocusRequestId((currentId) => currentId + 1)
                    onChange({ ...settings, sort: nextSortRules })
                  }}
                  ref={(element) => {
                    if (element) {
                      sortRemoveButtonRefs.current.set(index, element)
                    } else {
                      sortRemoveButtonRefs.current.delete(index)
                    }
                  }}
                  type="button"
                >
                  {t('taskViews.sort.removeShort')}
                </button>
              </div>
            )
          })}
          {nextSortOption ? (
            <button
              className="w-fit rounded-md border border-dashed border-[var(--workbench-border-strong)] bg-white px-3 py-2 text-xs font-semibold text-[var(--workbench-primary)] transition hover:border-[#99d7cf] hover:bg-[#e5f7f4]"
              onClick={() => {
                pendingSortFocusRef.current = `field:${sortRules.length}`
                setSortFocusRequestId((currentId) => currentId + 1)
                onChange({
                  ...settings,
                  sort: [...sortRules, { direction: 'asc', field: nextSortOption.id }],
                })
              }}
              ref={addSortButtonRef}
              type="button"
            >
              {t('taskViews.sort.add')}
            </button>
          ) : null}
        </div>
      </fieldset> : null}
      {supportsLayoutPresentation ? <fieldset className="grid content-start gap-2 sm:col-span-2">
        <legend className="text-xs font-semibold text-[var(--workbench-muted)]">{t('taskViews.columns')}</legend>
        <div className="flex flex-wrap gap-1.5">
          {columnOptions.map((option) => {
            const selected = settings.columns.some((column) => column.field === option.id)
            const required = requiredColumnIds.includes(option.id)
            return (
              <button
                aria-pressed={selected}
                disabled={required}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition ${
                  selected
                    ? 'border-[#99d7cf] bg-[#e5f7f4] text-[var(--workbench-primary)]'
                    : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:border-[var(--workbench-border-strong)]'
                }`}
                key={option.id}
                onClick={() => {
                  if (required) return
                  onChange({
                    ...settings,
                    columns: selected
                      ? settings.columns.filter((column) => column.field !== option.id)
                      : [...settings.columns, { field: option.id }],
                  })
                }}
                type="button"
              >
                {selected ? <CheckIcon className="h-3 w-3" /> : null}
                {option.label}
              </button>
            )
          })}
        </div>
        {supportsColumnLayoutMetadata ? (
          <div className="grid gap-2" data-testid="task-view-column-layout">
            {settings.columns.map((column, index) => {
              const option = columnOptions.find((candidate) => candidate.id === column.field)
              const label = option?.label ?? column.field
              return (
                <div
                  aria-label={t('taskViews.column.settings').replace('{column}', label)}
                  className="grid gap-2 rounded-md border border-[var(--workbench-border)] bg-white p-2 sm:grid-cols-[minmax(130px,1fr)_auto_minmax(104px,0.6fr)_minmax(112px,0.7fr)] sm:items-end"
                  data-testid="task-view-column-setting"
                  key={column.field}
                  role="group"
                >
                  <p className="self-center truncate text-xs font-semibold text-[var(--workbench-text)]">
                    {label}
                  </p>
                  <div className="flex items-center gap-1 self-center">
                    <button
                      aria-label={t('taskViews.column.moveUp').replace('{column}', label)}
                      className="grid h-8 w-8 place-items-center rounded-md border border-[var(--workbench-border)] text-sm font-bold text-[var(--workbench-muted)] transition hover:border-[var(--workbench-border-strong)] hover:bg-[var(--workbench-surface-muted)] disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={index === 0}
                      onClick={() => {
                        const nextColumns = [...settings.columns]
                        const currentColumn = nextColumns[index]
                        const previousColumn = nextColumns[index - 1]
                        if (!currentColumn || !previousColumn) return
                        nextColumns[index - 1] = currentColumn
                        nextColumns[index] = previousColumn
                        onChange({ ...settings, columns: nextColumns })
                      }}
                      type="button"
                    >
                      ↑
                    </button>
                    <button
                      aria-label={t('taskViews.column.moveDown').replace('{column}', label)}
                      className="grid h-8 w-8 place-items-center rounded-md border border-[var(--workbench-border)] text-sm font-bold text-[var(--workbench-muted)] transition hover:border-[var(--workbench-border-strong)] hover:bg-[var(--workbench-surface-muted)] disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={index === settings.columns.length - 1}
                      onClick={() => {
                        const nextColumns = [...settings.columns]
                        const currentColumn = nextColumns[index]
                        const nextColumn = nextColumns[index + 1]
                        if (!currentColumn || !nextColumn) return
                        nextColumns[index] = nextColumn
                        nextColumns[index + 1] = currentColumn
                        onChange({ ...settings, columns: nextColumns })
                      }}
                      type="button"
                    >
                      ↓
                    </button>
                  </div>
                  <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
                    {t('taskViews.column.width')}
                    <input
                      aria-label={t('taskViews.column.widthLabel').replace('{column}', label)}
                      className="workbench-input h-9 min-w-0 px-2.5 text-sm font-medium text-[var(--workbench-text)]"
                      inputMode="numeric"
                      max={640}
                      min={80}
                      onBlur={() => {
                        if (column.width === undefined) return
                        const normalizedWidth = Math.min(
                          640,
                          Math.max(80, Math.round(column.width)),
                        )
                        if (normalizedWidth === column.width) return
                        onChange({
                          ...settings,
                          columns: settings.columns.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? { ...candidate, width: normalizedWidth }
                              : candidate
                          ),
                        })
                      }}
                      onChange={(event) => {
                        const nextColumn = { ...column }
                        if (
                          event.target.value &&
                          Number.isFinite(event.target.valueAsNumber) &&
                          event.target.valueAsNumber > 0
                        ) {
                          nextColumn.width = Math.round(event.target.valueAsNumber)
                        } else {
                          delete nextColumn.width
                        }
                        onChange({
                          ...settings,
                          columns: settings.columns.map((candidate, candidateIndex) =>
                            candidateIndex === index ? nextColumn : candidate
                          ),
                        })
                      }}
                      placeholder={t('taskViews.column.auto')}
                      step={10}
                      type="number"
                      value={column.width ?? ''}
                    />
                  </label>
                  <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
                    {t('taskViews.column.pin')}
                    <select
                      aria-label={t('taskViews.column.pinLabel').replace('{column}', label)}
                      className="workbench-input h-9 min-w-0 px-2.5 text-sm font-medium text-[var(--workbench-text)]"
                      onChange={(event) => {
                        const nextColumn = { ...column }
                        if (event.target.value === 'start' || event.target.value === 'end') {
                          nextColumn.pin = event.target.value
                        } else {
                          delete nextColumn.pin
                        }
                        onChange({
                          ...settings,
                          columns: settings.columns.map((candidate, candidateIndex) =>
                            candidateIndex === index ? nextColumn : candidate
                          ),
                        })
                      }}
                      value={column.pin ?? ''}
                    >
                      <option value="">{t('taskViews.column.pin.none')}</option>
                      <option value="start">{t('taskViews.column.pin.start')}</option>
                      <option value="end">{t('taskViews.column.pin.end')}</option>
                    </select>
                  </label>
                </div>
              )
            })}
          </div>
        ) : null}
      </fieldset> : null}
      <fieldset className="grid content-start gap-2">
        <legend className="text-xs font-semibold text-[var(--workbench-muted)]">{t('taskViews.display')}</legend>
        <div className="grid gap-1.5 text-xs font-medium text-[var(--workbench-text)]">
          <DisplayOption
            checked={settings.display.showArchived}
            label={t('taskViews.display.archived')}
            onChange={(showArchived) => onChange({
              ...settings,
              display: { ...settings.display, showArchived },
            })}
          />
          <DisplayOption
            checked={settings.display.showCompleted}
            label={t('taskViews.display.completed')}
            onChange={(showCompleted) => onChange({
              ...settings,
              display: { ...settings.display, showCompleted },
            })}
          />
          {supportsSubtasks ? (
            <DisplayOption
              checked={settings.display.showSubtasks}
              label={t('taskViews.display.subtasks')}
              onChange={(showSubtasks) => onChange({
                ...settings,
                display: { ...settings.display, showSubtasks },
              })}
            />
          ) : null}
          {supportsLayoutPresentation ? (
            <DisplayOption
              checked={settings.display.showAssigneeAvatars}
              label={t('taskViews.display.avatars')}
              onChange={(showAssigneeAvatars) => onChange({
                ...settings,
                display: { ...settings.display, showAssigneeAvatars },
              })}
            />
          ) : null}
          {supportsEmptyGroups ? (
            <DisplayOption
              checked={settings.display.showEmptyGroups}
              label={t('taskViews.display.emptyGroups')}
              onChange={(showEmptyGroups) => onChange({
                ...settings,
                display: { ...settings.display, showEmptyGroups },
              })}
            />
          ) : null}
          {supportsLayoutPresentation ? <DisplayOption
            checked={settings.display.wrapTitles}
            label={t('taskViews.display.wrap')}
            onChange={(wrapTitles) => onChange({
              ...settings,
              display: { ...settings.display, wrapTitles },
            })}
          /> : null}
        </div>
      </fieldset>
      {supportsKeyboardSelection ? (
        <p className="text-[11px] font-medium leading-5 text-[var(--workbench-muted)] sm:col-span-3">
          {t('taskViews.keyboard')}
        </p>
      ) : null}
    </div>
  )
}

/** Props accepted by one checkbox-backed display option. */
type DisplayOptionProps = {
  /** Current option value. */
  checked: boolean
  /** Visible option label. */
  label: string
  /** Applies a next option value. */
  onChange: (checked: boolean) => void
}

/** Renders one native checkbox display option. */
function DisplayOption({ checked, label, onChange }: DisplayOptionProps) {
  return (
    <label className="flex min-h-7 items-center gap-2">
      <input
        checked={checked}
        className="h-4 w-4 accent-[var(--workbench-primary)]"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  )
}

/** Props accepted by the new-saved-view sheet. */
type SaveViewSheetProps = {
  /** Whether Workspace-shared visibility is available to the current user. */
  canManageShared: boolean
  /** Current mutation failure shown without closing the sheet. */
  errorMessage?: string
  /** Whether view creation is in progress. */
  isSaving: boolean
  /** Closes the sheet without saving. */
  onClose: () => void
  /** Creates a saved view from the completed draft. */
  onSave: (draft: TaskViewSaveDraft) => void | Promise<void>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Teams available for Team visibility. */
  teams: readonly TaskViewTeamOption[]
}

/** Renders a responsive right-side sheet for creating a saved view. */
function SaveViewSheet({
  canManageShared,
  errorMessage,
  isSaving,
  onClose,
  onSave,
  t,
  teams,
}: SaveViewSheetProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<SavedViewVisibility>('personal')
  const [teamId, setTeamId] = useState(() => teams.length === 1 ? teams[0]?.id ?? '' : '')
  const dialogRef = useModalFocus<HTMLDivElement>(onClose)
  const hasWritableTeams = teams.length > 0
  const effectiveVisibility = visibility === 'team' && !hasWritableTeams
    ? 'personal'
    : visibility
  const hasWritableTeamSelection = teams.some((team) => team.id === teamId)
  const canSubmit = Boolean(
    name.trim() && (effectiveVisibility !== 'team' || hasWritableTeamSelection),
  )

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/20" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        aria-labelledby="task-view-save-title"
        aria-modal="true"
        className="h-full w-[min(440px,100vw)] overflow-auto border-l border-[var(--workbench-border-strong)] bg-white p-5 shadow-2xl max-[520px]:border-l-0"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--workbench-border)] pb-4">
          <div>
            <p className="workbench-eyebrow">{t('search.saved.title')}</p>
            <h2 className="mt-1 text-lg font-semibold text-[var(--workbench-text)]" id="task-view-save-title">
              {t('taskViews.saveAs')}
            </h2>
          </div>
          <button
            aria-label={t('sidebar.archive.cancel')}
            className="grid h-9 w-9 place-items-center rounded-md text-lg text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <form
          className="grid gap-4 pt-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            runToolbarAction(() => onSave({
              description: description.trim() || undefined,
              name: name.trim(),
              teamId: effectiveVisibility === 'team' ? teamId : undefined,
              visibility: effectiveVisibility,
            }))
          }}
        >
          {errorMessage ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700" role="alert">
              {errorMessage}
            </p>
          ) : null}
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('search.saved.name')}
            <input
              autoComplete="off"
              className="workbench-input h-10 px-3 text-sm text-[var(--workbench-text)]"
              data-modal-initial-focus
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('search.saved.description')}
            <textarea
              className="workbench-input min-h-24 resize-y px-3 py-2 text-sm text-[var(--workbench-text)]"
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('search.saved.visibility')}
            <select
              className="workbench-input h-10 px-3 text-sm text-[var(--workbench-text)]"
              onChange={(event) => setVisibility(readSavedViewVisibility(event.target.value))}
              value={effectiveVisibility}
            >
              <option value="personal">{t('search.saved.personal')}</option>
              {hasWritableTeams ? (
                <option value="team">{t('search.saved.team')}</option>
              ) : null}
              {canManageShared ? (
                <option value="shared">{t('search.saved.shared')}</option>
              ) : null}
            </select>
          </label>
          {effectiveVisibility === 'team' ? (
            <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('search.filters.team')}
              <select
                className="workbench-input h-10 px-3 text-sm text-[var(--workbench-text)]"
                onChange={(event) => setTeamId(event.target.value)}
                required
                value={teamId}
              >
                <option value="">{t('search.filters.team')}</option>
                {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </label>
          ) : null}
          <div className="mt-2 flex justify-end gap-2 border-t border-[var(--workbench-border)] pt-4">
            <button className="workbench-button-secondary h-10 px-4" onClick={onClose} type="button">
              {t('sidebar.archive.cancel')}
            </button>
            <button className="workbench-button-primary h-10 px-4" disabled={!canSubmit || isSaving} type="submit">
              {t('search.saved.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** Formats visibility and default metadata shown beneath a saved-view name. */
function formatViewMeta(view: TaskViewOption, t: (key: MessageKey) => string): string {
  const parts = [t(`search.saved.${view.visibility}`)]
  if (view.isPersonalDefault) parts.push(t('search.saved.default'))
  if (view.isTeamDefault) parts.push(t('taskViews.teamDefault'))
  return parts.join(' · ')
}

/** Narrows a native select value to a supported saved-view visibility. */
function readSavedViewVisibility(value: string): SavedViewVisibility {
  if (value === 'team' || value === 'shared') return value
  return 'personal'
}
