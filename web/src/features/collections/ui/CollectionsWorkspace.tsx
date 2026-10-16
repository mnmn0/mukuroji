import type { WorkItemCollection, WorkItemCollectionEntry } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { MessageKey } from '../../../shared/i18n/i18n'

/** Work Item that can be added to a Collection. */
export type CollectionCandidate = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item identifier. */
  issueId: string
  /** Current title. */
  title: string
}

/** Props accepted by the Collections workspace. */
export type CollectionsWorkspaceProps = {
  /** Translator for the current locale. */
  t: (key: MessageKey) => string
  /** Collections, or undefined while loading. */
  collections: WorkItemCollection[] | undefined
  /** Whether the latest Collection list request failed, including a refresh of loaded data. */
  collectionsFailed: boolean
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
  /** Work Items that can be added. */
  candidates: CollectionCandidate[]
  /** Whether the Work Items that can be added failed to load. */
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
          <CollectionDetail key={`${selected.collectionId}:${selected.revision}`} {...props} collection={selected} />
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
        <input className="workbench-input min-h-10 px-3" maxLength={1000} onChange={(event) => setDescription(event.target.value)} value={description} />
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
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(collection.name)
  const [description, setDescription] = useState(collection.description ?? '')
  const [candidateKey, setCandidateKey] = useState('')
  const listedKeys = new Set((props.items ?? []).map((item) => candidateValue(item.teamId, item.issueId)))
  const candidates = props.candidates.filter((candidate) => !listedKeys.has(candidateValue(candidate.teamId, candidate.issueId)))

  /**
   * Saves the edited name and description.
   *
   * @param event - Form submit event.
   */
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim()) return
    if (await props.onRename(collection, name.trim(), description.trim())) setEditing(false)
  }

  /** Adds the chosen candidate. */
  const add = () => {
    const candidate = props.candidates.find((entry) => candidateValue(entry.teamId, entry.issueId) === candidateKey)
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
            <input className="workbench-input min-h-10 px-3" maxLength={1000} onChange={(event) => setDescription(event.target.value)} value={description} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="workbench-button-primary min-h-10 px-4" disabled={props.pending || !name.trim()} type="submit">{t('collections.detail.save')}</button>
            <button className="workbench-button-secondary min-h-10 px-4" onClick={() => setEditing(false)} type="button">{t('collections.detail.cancel')}</button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{collection.name}</h2>
            {collection.description ? <p className="mt-1 text-sm text-[var(--workbench-muted)]">{collection.description}</p> : null}
          </div>
          {props.canEdit ? (
            <div className="flex flex-wrap gap-2">
              <button className="workbench-button-secondary min-h-10 px-3" disabled={props.pending} onClick={() => setEditing(true)} type="button">{t('collections.detail.edit')}</button>
              <button
                className="workbench-button-secondary min-h-10 px-3"
                disabled={props.pending}
                onClick={() => {
                  if (window.confirm(t('collections.detail.deleteConfirm'))) props.onDelete(collection)
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
      {props.canEdit && !props.candidatesFailed ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-[240px] flex-1 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('collections.add.label')}
            <select className="workbench-input min-h-10 px-3" onChange={(event) => setCandidateKey(event.target.value)} value={candidateKey}>
              <option value="">{t('collections.add.placeholder')}</option>
              {candidates.map((candidate) => (
                <option key={candidateValue(candidate.teamId, candidate.issueId)} value={candidateValue(candidate.teamId, candidate.issueId)}>
                  {candidate.title}
                </option>
              ))}
            </select>
          </label>
          <button className="workbench-button-primary min-h-10 px-4" disabled={props.pending || !candidateKey} onClick={add} type="button">
            {t('collections.add.submit')}
          </button>
        </div>
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
            <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] px-3 py-2" key={candidateValue(item.teamId, item.issueId)}>
              <div className="min-w-0">
                <Link className="text-sm font-semibold text-[var(--workbench-text)] underline-offset-2 hover:underline" to={props.workItemHref(item.teamId, item.issueId)}>
                  {item.title}
                </Link>
                <p className="text-xs text-[var(--workbench-muted)]">
                  {t(statusMessageKeys[item.statusCategory])}
                  {' · '}
                  {item.assignedProjectId ?? t('collections.items.unassigned')}
                </p>
              </div>
              {props.canEdit ? (
                <button
                  aria-label={`${t('collections.items.remove')}: ${item.title}`}
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
 * Encodes a Work Item reference as a select value.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @returns Stable value for the pair.
 */
function candidateValue(teamId: string, issueId: string): string {
  return JSON.stringify([teamId, issueId])
}
