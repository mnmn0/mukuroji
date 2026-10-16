import type { WorkItemCollection, WorkItemCollectionEntry } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { collectionCandidateKey, type CollectionCandidate } from '../model/collectionCandidates'

/** Props accepted by the Collections workspace. */
export type CollectionsWorkspaceProps = {
  /** Translator for the current locale. */
  t: (key: MessageKey) => string
  /** Collections, or undefined while loading. */
  collections: WorkItemCollection[] | undefined
  /** Whether the latest Collection list request failed, including a refresh of loaded data. */
  collectionsFailed: boolean
  /** Whether the caller is not allowed to view Collections; retrying cannot help. */
  accessDenied?: boolean
  /** Reloads the Collection list. */
  onRetryCollections: () => void
  /** Selected Collection identifier. */
  selectedId: string | undefined
  /** Items of the selected Collection, or undefined while loading. */
  items: WorkItemCollectionEntry[] | undefined
  /** Whether the latest request for the selected Collection's items failed. */
  itemsFailed: boolean
  /** Reloads the selected Collection's items. */
  onRetryItems: () => void
  /** Keyword of the latest candidate search; blank before the first search. */
  candidateQuery: string
  /** Searches the Work Items that can be added. */
  onSearchCandidates: (keyword: string) => void
  /** Work Items matching the candidate search, or undefined while searching. */
  candidates: CollectionCandidate[] | undefined
  /** Whether the candidate search failed. */
  candidatesFailed: boolean
  /** Reloads the Work Items that can be added. */
  onRetryCandidates: () => void
  /** Whether the caller may change Collections. */
  canEdit: boolean
  /** Whether a mutation is running. */
  pending: boolean
  /** Message of the latest failed action. */
  errorMessage?: string
  /** Builds the link to a Work Item's canonical detail. */
  workItemHref: (teamId: string, issueId: string) => string
  /** Selects a Collection. */
  onSelect: (collectionId: string) => void
  /** Creates a Collection. */
  onCreate: (name: string, description: string) => Promise<boolean>
  /** Renames or re-describes a Collection. */
  onRename: (collection: WorkItemCollection, name: string, description: string) => Promise<boolean>
  /** Deletes a Collection. */
  onDelete: (collection: WorkItemCollection) => void
  /** Adds a Work Item to the selected Collection. */
  onAddItem: (teamId: string, issueId: string) => void
  /** Removes a Work Item from the selected Collection. */
  onRemoveItem: (teamId: string, issueId: string) => void
}

/**
 * Lists Collections and shows the readable Work Items of the selected one.
 *
 * @param props - Collection data, permissions, and callbacks.
 * @returns The Collections workspace.
 */
export function CollectionsWorkspace(props: CollectionsWorkspaceProps) {
  const { t, collections, selectedId } = props
  const selected = collections?.find((collection) => collection.collectionId === selectedId)

  if (props.accessDenied) {
    return (
      <section aria-labelledby="collections-list-title" className="workbench-panel grid content-start gap-3 p-4" data-testid="collections-workspace">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]" id="collections-list-title">
          {t('collections.list.title')}
        </h2>
        <p className="text-sm font-medium text-[var(--workbench-danger)]" role="alert">{t('collections.denied')}</p>
      </section>
    )
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]" data-testid="collections-workspace">
      <section aria-labelledby="collections-list-title" className="workbench-panel grid content-start gap-4 p-4">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]" id="collections-list-title">
          {t('collections.list.title')}
        </h2>
        {props.errorMessage ? (
          <p className="text-sm font-medium text-[var(--workbench-danger)]" role="alert">{props.errorMessage}</p>
        ) : null}
        {props.collectionsFailed ? (
          <FailureNotice message={t(collections === undefined ? 'collections.list.failed' : 'collections.refreshFailed')} onRetry={props.onRetryCollections} t={t} />
        ) : null}
        {collections === undefined ? (
          props.collectionsFailed ? null : <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('collections.list.loading')}</p>
        ) : collections.length === 0 ? (
          <p className="text-sm text-[var(--workbench-muted)]">{t('collections.list.empty')}</p>
        ) : (
          <ul className="grid gap-1">
            {collections.map((collection) => (
              <li key={collection.collectionId}>
                <button
                  aria-current={collection.collectionId === selectedId ? 'true' : undefined}
                  className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)] aria-[current=true]:bg-[var(--workbench-surface-muted)]"
                  onClick={() => props.onSelect(collection.collectionId)}
                  type="button"
                >
                  {collection.name}
                  {/* Names are not unique, so the creator and creation date tell equal names apart. */}
                  <span className="mt-0.5 block truncate text-xs font-normal text-[var(--workbench-muted)]">
                    {describeCollectionOrigin(collection)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {props.canEdit ? <CreateCollectionForm pending={props.pending} t={t} onCreate={props.onCreate} /> : (
          <p className="text-sm text-[var(--workbench-muted)]">{t('collections.readOnly')}</p>
        )}
      </section>

      <section className="workbench-panel grid content-start gap-4 p-5">
        {selected ? (
          <CollectionDetail key={selected.collectionId} {...props} collection={selected} />
        ) : selectedId && collections !== undefined ? (
          // A bookmarked or stale selection that the loaded list does not contain.
          <p className="text-sm font-medium text-[var(--workbench-danger)]" role="alert">{t('collections.select.missing')}</p>
        ) : (
          <p className="text-sm text-[var(--workbench-muted)]">{t('collections.select.prompt')}</p>
        )}
      </section>
    </div>
  )
}

/**
 * Form that creates a Collection.
 *
 * @param props - Translator, pending flag, and create callback.
 * @returns The creation form.
 */
function CreateCollectionForm({ onCreate, pending, t }: Pick<CollectionsWorkspaceProps, 'onCreate' | 'pending' | 't'>) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const id = useId()

  /**
   * Submits the form and clears it after success.
   *
   * @param event - Form submit event.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim()) return
    if (await onCreate(name.trim(), description.trim())) {
      setName('')
      setDescription('')
    }
  }

  return (
    <form aria-labelledby={`${id}-title`} className="grid gap-2 border-t border-[var(--workbench-border)] pt-4" onSubmit={(event) => { void submit(event) }}>
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('collections.create.title')}</h3>
      <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
        {t('collections.create.name')}
        <input className="workbench-input min-h-10 px-3" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} />
      </label>
      <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
        {t('collections.create.description')}
        <textarea className="workbench-input min-h-20 px-3 py-2" maxLength={1000} onChange={(event) => setDescription(event.target.value)} rows={3} value={description} />
      </label>
      <button className="workbench-button-primary min-h-10 px-4" disabled={pending || !name.trim()} type="submit">
        {t('collections.create.submit')}
      </button>
    </form>
  )
}

/**
 * Shows one Collection with its readable Work Items.
 *
 * @param props - Workspace props plus the selected Collection.
 * @returns The Collection detail.
 */
function CollectionDetail(props: CollectionsWorkspaceProps & { collection: WorkItemCollection }) {
  const { collection, t } = props
  // The Collection as it was when editing began; item-only revisions keep the draft.
  const [editBase, setEditBase] = useState<WorkItemCollection | undefined>(undefined)
  const editing = editBase !== undefined
  const [name, setName] = useState(collection.name)
  const [description, setDescription] = useState(collection.description ?? '')
  const [candidateKey, setCandidateKey] = useState('')
  const [keyword, setKeyword] = useState(props.candidateQuery)
  const listedKeys = new Set((props.items ?? []).map((item) => collectionCandidateKey(item.teamId, item.issueId)))
  const candidates = (props.candidates ?? []).filter((candidate) => !listedKeys.has(collectionCandidateKey(candidate.teamId, candidate.issueId)))

  /**
   * Searches candidates for the entered keyword.
   *
   * @param event - Form submit event.
   */
  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!keyword.trim()) return
    setCandidateKey('')
    props.onSearchCandidates(keyword.trim())
  }

  /**
   * Saves the edited name and description.
   *
   * @param event - Form submit event.
   */
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim() || !editBase) return
    // Another editor's metadata change keeps the stale revision so the save reports a conflict.
    const metadataChanged = editBase.name !== collection.name || (editBase.description ?? '') !== (collection.description ?? '')
    if (await props.onRename(metadataChanged ? editBase : collection, name.trim(), description.trim())) setEditBase(undefined)
  }

  /** Starts editing from the current name and description. */
  const startEditing = () => {
    setName(collection.name)
    setDescription(collection.description ?? '')
    setEditBase(collection)
  }

  /** Adds the chosen candidate. */
  const add = () => {
    const candidate = candidates.find((entry) => collectionCandidateKey(entry.teamId, entry.issueId) === candidateKey)
    if (!candidate) return
    props.onAddItem(candidate.teamId, candidate.issueId)
    setCandidateKey('')
  }

  return (
    <>
      {editing ? (
        <form className="grid gap-2" onSubmit={(event) => { void save(event) }}>
          <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('collections.create.name')}
            <input className="workbench-input min-h-10 px-3" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('collections.create.description')}
            <textarea className="workbench-input min-h-20 px-3 py-2" maxLength={1000} onChange={(event) => setDescription(event.target.value)} rows={3} value={description} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="workbench-button-primary min-h-10 px-4" disabled={props.pending || !name.trim()} type="submit">{t('collections.detail.save')}</button>
            <button className="workbench-button-secondary min-h-10 px-4" onClick={() => setEditBase(undefined)} type="button">{t('collections.detail.cancel')}</button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{collection.name}</h2>
            {collection.description ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--workbench-muted)]">{collection.description}</p> : null}
          </div>
          {props.canEdit ? (
            <div className="flex flex-wrap gap-2">
              <button className="workbench-button-secondary min-h-10 px-3" disabled={props.pending} onClick={startEditing} type="button">{t('collections.detail.edit')}</button>
              <button
                className="workbench-button-secondary min-h-10 px-3"
                disabled={props.pending}
                onClick={() => {
                  if (window.confirm(t('collections.detail.deleteConfirm').replace('{name}', `${collection.name} (${describeCollectionOrigin(collection)})`))) props.onDelete(collection)
                }}
                type="button"
              >
                {t('collections.detail.delete')}
              </button>
            </div>
          ) : null}
        </div>
      )}

      <p className="text-sm text-[var(--workbench-muted)]">{t('collections.items.visibility')}</p>

      {props.canEdit && props.candidatesFailed ? (
        <FailureNotice message={t('collections.add.failed')} onRetry={props.onRetryCandidates} t={t} />
      ) : null}
      {props.canEdit ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={search} role="search">
          <label className="grid min-w-[240px] flex-1 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('collections.add.search')}
            <input className="workbench-input min-h-10 px-3" maxLength={200} onChange={(event) => setKeyword(event.target.value)} type="search" value={keyword} />
          </label>
          <button className="workbench-button-secondary min-h-10 px-4" disabled={!keyword.trim()} type="submit">
            {t('collections.add.searchSubmit')}
          </button>
        </form>
      ) : null}
      {props.canEdit && props.candidateQuery && !props.candidatesFailed ? (
        props.candidates === undefined ? (
          <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('collections.add.searching')}</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('collections.add.noResults')}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-[240px] flex-1 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('collections.add.label')}
              <select className="workbench-input min-h-10 px-3" onChange={(event) => setCandidateKey(event.target.value)} value={candidateKey}>
                <option value="">{t('collections.add.placeholder')}</option>
                {candidates.map((candidate) => (
                  <option key={collectionCandidateKey(candidate.teamId, candidate.issueId)} value={collectionCandidateKey(candidate.teamId, candidate.issueId)}>
                    {`${candidate.title} (${candidate.teamId} / ${candidate.issueId})`}
                  </option>
                ))}
              </select>
            </label>
            <button className="workbench-button-primary min-h-10 px-4" disabled={props.pending || !candidateKey} onClick={add} type="button">
              {t('collections.add.submit')}
            </button>
          </div>
        )
      ) : null}

      <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('collections.items.title')}</h3>
      {props.itemsFailed ? (
        <FailureNotice message={t(props.items === undefined ? 'collections.items.failed' : 'collections.refreshFailed')} onRetry={props.onRetryItems} t={t} />
      ) : null}
      {props.items === undefined ? (
        props.itemsFailed ? null : <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('collections.items.loading')}</p>
      ) : props.items.length === 0 ? (
        <p className="text-sm text-[var(--workbench-muted)]">{t('collections.items.empty')}</p>
      ) : (
        <ul className="grid gap-2" data-testid="collection-items">
          {props.items.map((item) => (
            <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] px-3 py-2" key={collectionCandidateKey(item.teamId, item.issueId)}>
              <div className="min-w-0">
                <Link className="text-sm font-semibold text-[var(--workbench-text)] underline-offset-2 hover:underline" to={props.workItemHref(item.teamId, item.issueId)}>
                  {item.title}
                </Link>
                <p className="text-xs text-[var(--workbench-muted)]">
                  {/* Titles are not unique, so the Team and Work Item ID tell equal titles apart. */}
                  {`${item.teamId} / ${item.issueId}`}
                  {' · '}
                  {t(statusMessageKeys[item.statusCategory])}
                  {' · '}
                  {item.assignedProjectId ?? t('collections.items.unassigned')}
                </p>
              </div>
              {props.canEdit ? (
                <button
                  aria-label={`${t('collections.items.remove')}: ${item.title} (${item.teamId} / ${item.issueId})`}
                  className="workbench-button-secondary min-h-9 px-3"
                  disabled={props.pending}
                  onClick={() => props.onRemoveItem(item.teamId, item.issueId)}
                  type="button"
                >
                  {t('collections.items.remove')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * Explains a failed request and offers to retry it.
 *
 * @param props - Message, retry callback, and translator.
 * @returns An alert with a retry button.
 */
function FailureNotice({ message, onRetry, t }: { message: string; onRetry: () => void; t: CollectionsWorkspaceProps['t'] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--workbench-danger)]" role="alert">
      <span>{message}</span>
      <button className="workbench-button-secondary min-h-9 px-3" onClick={onRetry} type="button">{t('collections.retry')}</button>
    </div>
  )
}

/** Message keys for workflow status categories. */
const statusMessageKeys = {
  backlog: 'collections.status.backlog',
  unstarted: 'collections.status.unstarted',
  started: 'collections.status.started',
  completed: 'collections.status.completed',
  canceled: 'collections.status.canceled',
} satisfies Record<WorkItemCollectionEntry['statusCategory'], MessageKey>

/**
 * Describes who created a Collection and when, to tell Collections with equal names apart.
 *
 * @param collection - Collection to describe.
 * @returns The creator and the UTC creation date.
 */
function describeCollectionOrigin(collection: Pick<WorkItemCollection, 'createdBy' | 'createdAt'>): string {
  return `${collection.createdBy} · ${collection.createdAt.slice(0, 10)}`
}
