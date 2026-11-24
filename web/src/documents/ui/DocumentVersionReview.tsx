import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  DOCUMENT_VERSION_NAME_MAX_LENGTH,
  type ApprovalRequest,
  type CreateDocumentVersionApprovalInput,
  type DocumentDetail,
  type DocumentRelationTarget,
  type DocumentVersion,
} from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { MentionableMember } from '../../shared/lib/memberMentions'
import { createWorkItemSearchPath } from '../../shared/routing/paths'
import type { DocumentRecord } from '../api'
import { createDocumentRelationTargetKey } from '../model/linkTargets'
import { createCanonicalWorkItemId, parseCanonicalWorkItemId } from '../model/relations'
import { resolveApprovalStatusClassName } from '../model/versionApprovals'
import { diffDocumentVersions, type DocumentBlockDiffEntry } from '../model/versionDiff'
import { useDocumentVersionDetail } from '../queries/useDocumentVersionReview'
import { DocumentReadOnlyBlock, DocumentReadOnlyContent } from './DocumentEditor'
import { DocumentRelationTargetLabel, DocumentRelationTargetPicker } from './DocumentLinkPicker'
import { focusFirstModalElement, trapModalFocus } from './modalFocus'

/** Value of the compare selector that stands for the current, unsaved-to-history content. */
const CURRENT_CONTENT = 'current'

/** Days added to today for the default approval due date. */
const DEFAULT_APPROVAL_DUE_DAYS = 7

/** A view of the version review dialog. */
type DocumentVersionReviewTab = 'preview' | 'compare' | 'approval'

/** Views of the version review dialog in tab order. */
const REVIEW_TABS: readonly DocumentVersionReviewTab[] = ['preview', 'compare', 'approval']

/**
 * Props of {@link DocumentVersionReviewDialog}.
 */
export type DocumentVersionReviewDialogProps = {
  /** Documents API token used to read version snapshots and search Work Items. */
  accessToken: string
  /** Current Document. */
  document: DocumentRecord
  /** Version under review. */
  version: DocumentVersion
  /** Loaded version history, offered as comparison targets. */
  versions: readonly DocumentVersion[]
  /** Approvals requested for this version. */
  approvals: readonly ApprovalRequest[]
  /** Members offered as reviewers. */
  members?: readonly MentionableMember[]
  /** Locale used for dates and link labels. */
  locale: Locale
  /** Tab opened first. */
  initialTab?: DocumentVersionReviewTab
  /** Translator. */
  t: (key: MessageKey) => string
  /** Closes the dialog. */
  onClose: () => void
  /** Pins the version with a name; omitted when the viewer cannot edit. */
  onPin?: (name: string) => Promise<void>
  /** Requests approval of the pinned version; omitted when the viewer cannot edit. */
  onRequestApproval?: (input: CreateDocumentVersionApprovalInput) => Promise<void>
  /** Opens an application path. */
  onNavigate?: (path: string) => void
}

/**
 * Dialog that previews one version read-only, compares it with another version block by block,
 * and pins it and requests its approval.
 *
 * @param props - Version, current Document, and review actions.
 * @returns The modal dialog.
 */
export function DocumentVersionReviewDialog({
  accessToken,
  approvals,
  document,
  initialTab = 'preview',
  locale,
  members,
  onClose,
  onNavigate,
  onPin,
  onRequestApproval,
  t,
  version,
  versions,
}: DocumentVersionReviewDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const tabIdPrefix = useId()
  const [tab, setTab] = useState<DocumentVersionReviewTab>(initialTab)

  useEffect(() => {
    const previous = globalThis.document.activeElement instanceof HTMLElement
      ? globalThis.document.activeElement
      : undefined
    focusFirstModalElement(dialogRef.current)
    return () => previous?.focus()
  }, [])

  /**
   * Closes on Escape and keeps keyboard focus inside the dialog.
   *
   * @param event - Keyboard event inside the dialog.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    trapModalFocus(event, dialogRef.current)
  }

  /**
   * Moves between tabs with the arrow, Home, and End keys.
   *
   * @param event - Keyboard event on a tab.
   * @param current - Tab that has focus.
   */
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: DocumentVersionReviewTab) => {
    const index = REVIEW_TABS.indexOf(current)
    const target = event.key === 'ArrowRight'
      ? REVIEW_TABS[(index + 1) % REVIEW_TABS.length]
      : event.key === 'ArrowLeft'
        ? REVIEW_TABS[(index - 1 + REVIEW_TABS.length) % REVIEW_TABS.length]
        : event.key === 'Home'
          ? REVIEW_TABS[0]
          : event.key === 'End'
            ? REVIEW_TABS[REVIEW_TABS.length - 1]
            : undefined
    if (!target) return
    event.preventDefault()
    setTab(target)
    globalThis.document.getElementById(`${tabIdPrefix}-tab-${target}`)?.focus()
  }

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex max-h-[min(860px,calc(100svh-48px))] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-[var(--workbench-border)] bg-surface shadow-[0_28px_90px_rgba(23,32,29,0.3)]"
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex flex-none items-start justify-between gap-4 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-6 py-4">
          <div className="min-w-0">
            <p className="workbench-eyebrow">{t('documents.versionReview.eyebrow')}</p>
            <h2 className="m-0 mt-1 truncate text-lg font-semibold text-[var(--workbench-text)]" id={titleId}>
              {version.name ?? t('documents.versions.revision').replace('{revision}', String(version.revision))}
            </h2>
            <p className="m-0 mt-1 text-xs font-medium text-[var(--workbench-muted)]">
              {t('documents.versions.revision').replace('{revision}', String(version.revision))}
              {' · '}
              {formatDateTime(version.createdAt, locale)}
            </p>
          </div>
          <button
            aria-label={t('documents.versionReview.close')}
            className="workbench-button-secondary h-8 px-3 text-xs"
            onClick={onClose}
            type="button"
          >
            {t('documents.versionReview.close')}
          </button>
        </header>
        <div
          aria-label={t('documents.versionReview.tabs')}
          className="flex flex-none gap-1 border-b border-[var(--workbench-border)] px-4"
          role="tablist"
        >
          {REVIEW_TABS.map((candidate) => (
            <button
              aria-controls={`${tabIdPrefix}-panel`}
              aria-selected={tab === candidate}
              className={`h-10 border-b-2 px-3 text-sm font-semibold ${tab === candidate ? 'border-[var(--workbench-accent)] text-[var(--workbench-text)]' : 'border-transparent text-[var(--workbench-muted)]'}`}
              id={`${tabIdPrefix}-tab-${candidate}`}
              key={candidate}
              onClick={() => setTab(candidate)}
              onKeyDown={(event) => handleTabKeyDown(event, candidate)}
              role="tab"
              tabIndex={tab === candidate ? 0 : -1}
              type="button"
            >
              {t(`documents.versionReview.tab.${candidate}`)}
            </button>
          ))}
        </div>
        <div
          aria-labelledby={`${tabIdPrefix}-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto"
          id={`${tabIdPrefix}-panel`}
          role="tabpanel"
        >
          {tab === 'preview' ? (
            <VersionPreview accessToken={accessToken} document={document} t={t} version={version} />
          ) : null}
          {tab === 'compare' ? (
            <VersionCompare
              accessToken={accessToken}
              document={document}
              locale={locale}
              t={t}
              version={version}
              versions={versions}
            />
          ) : null}
          {tab === 'approval' ? (
            <VersionApproval
              accessToken={accessToken}
              approvals={approvals}
              document={document}
              locale={locale}
              members={members}
              onNavigate={onNavigate}
              onPin={onPin}
              onRequestApproval={onRequestApproval}
              t={t}
              version={version}
            />
          ) : null}
        </div>
      </section>
    </div>
  )
}

/**
 * Read-only preview of one version's snapshot.
 *
 * @param props - Version to preview and the token that reads it.
 * @returns The preview, or a loading or error notice.
 */
function VersionPreview({
  accessToken,
  document,
  t,
  version,
}: {
  /** Documents API token. */
  accessToken: string
  /** Current Document. */
  document: DocumentRecord
  /** Translator. */
  t: (key: MessageKey) => string
  /** Version to preview. */
  version: DocumentVersion
}) {
  const detail = useDocumentVersionDetail(accessToken, document.id, version.id)
  if (!detail.data) {
    return detail.error
      ? <StatusNotice role="alert" text={t('documents.versionReview.loadError')} />
      : <StatusNotice text={t('documents.versionReview.loading')} />
  }
  const snapshot = detail.data.document
  if (snapshot.kind === 'page' || snapshot.kind === 'template') {
    return (
      <DocumentReadOnlyContent
        document={{ blocks: snapshot.blocks, title: snapshot.title, updatedAt: version.createdAt }}
        t={t}
      />
    )
  }
  if (snapshot.kind === 'whiteboard') {
    return (
      <StatusNotice
        text={t('documents.versionReview.whiteboardSummary')
          .replace('{objects}', String(snapshot.whiteboard.objects.length))}
      />
    )
  }
  return <StatusNotice text={snapshot.title} />
}

/**
 * Block-level comparison of the version with another version or the current content.
 *
 * @param props - Version under review and the comparison candidates.
 * @returns The comparison.
 */
function VersionCompare({
  accessToken,
  document,
  locale,
  t,
  version,
  versions,
}: {
  /** Documents API token. */
  accessToken: string
  /** Current Document. */
  document: DocumentRecord
  /** Locale used for dates. */
  locale: Locale
  /** Translator. */
  t: (key: MessageKey) => string
  /** Version under review. */
  version: DocumentVersion
  /** Loaded version history. */
  versions: readonly DocumentVersion[]
}) {
  const selectId = useId()
  const candidates = versions.filter((candidate) => candidate.id !== version.id)
  const [targetId, setTargetId] = useState(CURRENT_CONTENT)
  const reviewed = useDocumentVersionDetail(accessToken, document.id, version.id)
  const target = useDocumentVersionDetail(
    accessToken,
    document.id,
    targetId === CURRENT_CONTENT ? undefined : targetId,
  )
  // The current content is always the newest side, even when the history is ahead of a stale
  // client copy of the Document.
  const targetRevision = targetId === CURRENT_CONTENT
    ? Number.POSITIVE_INFINITY
    : versions.find((candidate) => candidate.id === targetId)?.revision ?? 0
  const targetSnapshot: DocumentDetail | undefined = targetId === CURRENT_CONTENT
    ? document
    : target.data?.document
  const diff = useMemo(() => {
    if (!reviewed.data || !targetSnapshot) return undefined
    return targetRevision >= version.revision
      ? diffDocumentVersions(reviewed.data.document, targetSnapshot)
      : diffDocumentVersions(targetSnapshot, reviewed.data.document)
  }, [reviewed.data, targetRevision, targetSnapshot, version.revision])

  return (
    <div className="grid gap-4 p-5">
      <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]" htmlFor={selectId}>
        {t('documents.versionReview.compareWith')}
        <select
          className="workbench-input h-9 px-2 text-sm"
          id={selectId}
          onChange={(event) => setTargetId(event.target.value)}
          value={targetId}
        >
          <option value={CURRENT_CONTENT}>{t('documents.versionReview.currentContent')}</option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name ? `${candidate.name} · ` : ''}
              {t('documents.versions.revision').replace('{revision}', String(candidate.revision))}
              {' · '}
              {formatDateTime(candidate.createdAt, locale)}
            </option>
          ))}
        </select>
      </label>
      <p className="m-0 text-xs font-medium text-[var(--workbench-muted)]">
        {t('documents.versionReview.compareDirection')}
      </p>
      {diff === undefined && (reviewed.error || target.error) ? (
        <StatusNotice role="alert" text={t('documents.versionReview.loadError')} />
      ) : diff === undefined ? (
        <StatusNotice text={t('documents.versionReview.loading')} />
      ) : !diff.hasChanges ? (
        <StatusNotice text={t('documents.versionReview.noChanges')} />
      ) : (
        <div className="grid gap-3">
          {diff.previousTitle !== undefined ? (
            <p className="m-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-fg-amber-800">
              {t('documents.versionReview.titleChanged').replace('{title}', diff.previousTitle)}
            </p>
          ) : null}
          {diff.whiteboard ? (
            <StatusNotice
              text={t('documents.versionReview.whiteboardDiff')
                .replace('{added}', String(diff.whiteboard.added))
                .replace('{removed}', String(diff.whiteboard.removed))
                .replace('{changed}', String(diff.whiteboard.changed))}
            />
          ) : null}
          {diff.blocks.map((entry, index) => (
            <BlockDiffEntry entry={entry} key={`${entry.kind}:${entry.block.id}:${index}`} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Visual treatment of each diff kind. */
const blockDiffClassNames = {
  unchanged: 'border-[var(--workbench-border)] opacity-70',
  added: 'border-emerald-300 bg-emerald-50/60',
  removed: 'border-red-300 bg-red-50/60',
  changed: 'border-amber-300 bg-amber-50/50',
  moved: 'border-sky-300 bg-sky-50/50',
} as const satisfies Record<DocumentBlockDiffEntry['kind'], string>

/**
 * One block of the comparison.
 *
 * @param props - Diff entry and translator.
 * @returns The block with its change label.
 */
function BlockDiffEntry({
  entry,
  t,
}: {
  /** Diff entry to render. */
  entry: DocumentBlockDiffEntry
  /** Translator. */
  t: (key: MessageKey) => string
}) {
  return (
    <section className={`rounded-lg border px-4 py-3 ${blockDiffClassNames[entry.kind]}`} data-diff-kind={entry.kind}>
      <p className="m-0 mb-2 text-[11px] font-bold uppercase tracking-wide text-[var(--workbench-muted)]">
        {t(`documents.versionReview.diff.${entry.kind}`)}
      </p>
      {entry.kind === 'changed' ? (
        <div className="grid gap-2">
          <div className="rounded-md bg-red-50 px-3 py-2 line-through decoration-red-400/70" aria-label={t('documents.versionReview.diff.before')}>
            <DocumentReadOnlyBlock block={entry.before} t={t} />
          </div>
          <div className="rounded-md bg-emerald-50 px-3 py-2" aria-label={t('documents.versionReview.diff.after')}>
            <DocumentReadOnlyBlock block={entry.block} t={t} />
          </div>
        </div>
      ) : (
        <div className={entry.kind === 'removed' ? 'line-through decoration-red-400/70' : undefined}>
          <DocumentReadOnlyBlock block={entry.block} t={t} />
        </div>
      )}
    </section>
  )
}

/**
 * Pins the version and requests its approval on a Work Item; lists the approvals it received.
 *
 * @param props - Version, approvals, members, and review actions.
 * @returns The approval view.
 */
function VersionApproval({
  accessToken,
  approvals,
  document,
  locale,
  members,
  onNavigate,
  onPin,
  onRequestApproval,
  t,
  version,
}: {
  /** Documents API token used to label and search Work Items. */
  accessToken: string
  /** Approvals requested for this version. */
  approvals: readonly ApprovalRequest[]
  /** Current Document whose linked Work Items are offered first. */
  document: DocumentRecord
  /** Locale used for dates and labels. */
  locale: Locale
  /** Members offered as reviewers. */
  members?: readonly MentionableMember[]
  /** Opens an application path. */
  onNavigate?: (path: string) => void
  /** Pins the version with a name. */
  onPin?: (name: string) => Promise<void>
  /** Requests approval of the pinned version. */
  onRequestApproval?: (input: CreateDocumentVersionApprovalInput) => Promise<void>
  /** Translator. */
  t: (key: MessageKey) => string
  /** Version under review. */
  version: DocumentVersion
}) {
  return (
    <div className="grid gap-5 p-5">
      {version.name === undefined ? (
        <PinVersionForm onPin={onPin} t={t} />
      ) : (
        <p className="m-0 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2 text-sm font-medium text-[var(--workbench-text)]">
          {t('documents.versionReview.pinnedValue').replace('{name}', version.name)}
        </p>
      )}
      <section className="grid gap-2">
        <h3 className="m-0 text-sm font-semibold text-[var(--workbench-text)]">
          {t('documents.versionReview.approvals')}
        </h3>
        {approvals.length === 0 ? (
          <p className="m-0 text-xs font-medium text-[var(--workbench-muted)]">
            {t('documents.versionReview.noApprovals')}
          </p>
        ) : (
          approvals.map((approval) => (
            <DocumentApprovalSummary
              accessToken={accessToken}
              approval={approval}
              key={approval.id}
              locale={locale}
              members={members}
              onNavigate={onNavigate}
              t={t}
            />
          ))
        )}
      </section>
      {version.name !== undefined && onRequestApproval ? (
        <RequestApprovalForm
          accessToken={accessToken}
          document={document}
          locale={locale}
          members={members}
          onRequestApproval={onRequestApproval}
          t={t}
        />
      ) : null}
    </div>
  )
}

/**
 * Form that names and pins the version.
 *
 * @param props - Pin action and translator.
 * @returns The form, or a notice when the viewer cannot pin.
 */
function PinVersionForm({
  onPin,
  t,
}: {
  /** Pins the version with a name. */
  onPin?: (name: string) => Promise<void>
  /** Translator. */
  t: (key: MessageKey) => string
}) {
  const inputId = useId()
  const [name, setName] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [hasError, setHasError] = useState(false)
  if (!onPin) {
    return (
      <p className="m-0 text-xs font-medium text-[var(--workbench-muted)]">
        {t('documents.versionReview.pinRequired')}
      </p>
    )
  }

  /**
   * Pins the version with the entered name.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || isSaving) return
    setIsSaving(true)
    setHasError(false)
    try {
      await onPin(trimmed)
    } catch {
      setHasError(true)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form className="grid gap-2 rounded-lg border border-[var(--workbench-border)] p-3" onSubmit={(event) => void submit(event)}>
      <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]" htmlFor={inputId}>
        {t('documents.versionReview.pinName')}
        <input
          className="workbench-input h-9 px-3 text-sm"
          id={inputId}
          maxLength={DOCUMENT_VERSION_NAME_MAX_LENGTH}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('documents.versionReview.pinPlaceholder')}
          value={name}
        />
      </label>
      <p className="m-0 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
        {t('documents.versionReview.pinDescription')}
      </p>
      {hasError ? (
        <p className="m-0 text-xs font-semibold text-fg-red-700" role="alert">{t('documents.versionReview.pinError')}</p>
      ) : null}
      <div className="flex justify-end">
        <button className="workbench-button-primary h-8 px-3 text-xs disabled:opacity-50" disabled={isSaving || !name.trim()} type="submit">
          {isSaving ? t('documents.versionReview.saving') : t('documents.versionReview.pin')}
        </button>
      </div>
    </form>
  )
}

/**
 * Form that requests approval of a pinned version on a Work Item.
 *
 * @param props - Current Document, members, and the request action.
 * @returns The form.
 */
function RequestApprovalForm({
  accessToken,
  document,
  locale,
  members,
  onRequestApproval,
  t,
}: {
  /** Documents API token used to label and search Work Items. */
  accessToken: string
  /** Current Document whose linked Work Items are offered first. */
  document: DocumentRecord
  /** Locale used for labels. */
  locale: Locale
  /** Members offered as reviewers. */
  members?: readonly MentionableMember[]
  /** Requests approval of the pinned version. */
  onRequestApproval: (input: CreateDocumentVersionApprovalInput) => Promise<void>
  /** Translator. */
  t: (key: MessageKey) => string
}) {
  const dueId = useId()
  const linkedWorkItemIds = document.relations
    .map((relation) => relation.target)
    .filter((target) => target.kind === 'work-item')
    .map((target) => target.workItemId)
  const [workItemIds, setWorkItemIds] = useState<string[]>(() => [...new Set(linkedWorkItemIds)])
  const [workItemId, setWorkItemId] = useState<string | undefined>(linkedWorkItemIds[0])
  const [isPickingWorkItem, setIsPickingWorkItem] = useState(false)
  const [reviewerQuery, setReviewerQuery] = useState('')
  const [reviewerKeys, setReviewerKeys] = useState<string[]>([])
  const [dueDate, setDueDate] = useState(() => createDefaultDueDate())
  const [isSaving, setIsSaving] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [isDone, setIsDone] = useState(false)
  const activeMembers = (members ?? []).filter((member) => member.status === 'active')
  const normalizedQuery = reviewerQuery.trim().toLowerCase()
  const visibleMembers = activeMembers.filter((member) =>
    reviewerKeys.includes(member.memberKey) ||
    !normalizedQuery ||
    [member.name, member.email, member.memberKey].some((value) => value?.toLowerCase().includes(normalizedQuery))
  ).slice(0, 30)
  const workItem = workItemId === undefined ? undefined : parseCanonicalWorkItemId(workItemId)
  const canSubmit = workItem !== undefined && reviewerKeys.length > 0 && dueDate !== '' && !isSaving

  /**
   * Adds a Work Item chosen in the picker and selects it.
   *
   * @param target - Picked relation target.
   */
  const pickWorkItem = async (target: DocumentRelationTarget) => {
    if (target.kind !== 'work-item') return
    setWorkItemIds((current) => current.includes(target.workItemId) ? current : [...current, target.workItemId])
    setWorkItemId(target.workItemId)
    setIsPickingWorkItem(false)
  }

  /**
   * Toggles a reviewer.
   *
   * @param memberKey - Member to add or remove.
   */
  const toggleReviewer = (memberKey: string) => {
    setReviewerKeys((current) =>
      current.includes(memberKey)
        ? current.filter((candidate) => candidate !== memberKey)
        : [...current, memberKey]
    )
  }

  /**
   * Sends the approval request.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || workItem === undefined) return
    setIsSaving(true)
    setHasError(false)
    setIsDone(false)
    try {
      await onRequestApproval({
        teamId: workItem.teamId,
        issueId: workItem.issueId,
        reviewerMemberKeys: reviewerKeys,
        dueAt: new Date(`${dueDate}T23:59:59`).toISOString(),
      })
      setReviewerKeys([])
      setIsDone(true)
    } catch {
      setHasError(true)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form className="grid gap-4 rounded-lg border border-[var(--workbench-border)] p-4" onSubmit={(event) => void submit(event)}>
      <div>
        <h3 className="m-0 text-sm font-semibold text-[var(--workbench-text)]">{t('documents.versionReview.requestTitle')}</h3>
        <p className="m-0 mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('documents.versionReview.requestDescription')}
        </p>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-semibold text-[var(--workbench-text)]">
          {t('documents.versionReview.workItem')}
        </legend>
        {workItemIds.length === 0 ? (
          <p className="m-0 text-xs font-medium text-[var(--workbench-muted)]">{t('documents.versionReview.noLinkedWorkItems')}</p>
        ) : (
          workItemIds.map((candidate) => (
            <label className="flex items-center gap-2 text-sm" key={candidate}>
              <input
                checked={workItemId === candidate}
                name="approval-work-item"
                onChange={() => setWorkItemId(candidate)}
                type="radio"
              />
              <DocumentRelationTargetLabel
                accessToken={accessToken}
                locale={locale}
                t={t}
                target={{ kind: 'work-item', workItemId: candidate }}
              />
            </label>
          ))
        )}
        {isPickingWorkItem ? (
          <DocumentRelationTargetPicker
            accessToken={accessToken}
            kinds={['work-item']}
            linkedTargetKeys={new Set(workItemIds.map((candidate) =>
              createDocumentRelationTargetKey({ kind: 'work-item', workItemId: candidate })
            ))}
            onSelect={pickWorkItem}
            t={t}
          />
        ) : (
          <button className="workbench-button-secondary h-8 w-fit px-3 text-xs" onClick={() => setIsPickingWorkItem(true)} type="button">
            {t('documents.versionReview.chooseWorkItem')}
          </button>
        )}
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-semibold text-[var(--workbench-text)]">
          {t('documents.versionReview.reviewers')}
        </legend>
        <input
          aria-label={t('documents.versionReview.reviewerSearch')}
          className="workbench-input h-9 px-3 text-sm"
          onChange={(event) => setReviewerQuery(event.target.value)}
          placeholder={t('documents.versionReview.reviewerSearch')}
          value={reviewerQuery}
        />
        <div className="grid max-h-48 gap-1 overflow-y-auto">
          {visibleMembers.map((member) => (
            <label className="flex items-center gap-2 text-sm" key={member.memberKey}>
              <input
                checked={reviewerKeys.includes(member.memberKey)}
                onChange={() => toggleReviewer(member.memberKey)}
                type="checkbox"
              />
              <span className="font-medium text-[var(--workbench-text)]">{member.name ?? member.email ?? member.memberKey}</span>
              {member.name && member.email ? (
                <span className="text-xs text-[var(--workbench-muted)]">{member.email}</span>
              ) : null}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="grid w-fit gap-1.5 text-xs font-semibold text-[var(--workbench-text)]" htmlFor={dueId}>
        {t('documents.versionReview.dueDate')}
        <input
          className="workbench-input h-9 px-3 text-sm"
          id={dueId}
          min={createDefaultDueDate(0)}
          onChange={(event) => setDueDate(event.target.value)}
          type="date"
          value={dueDate}
        />
      </label>
      {hasError ? (
        <p className="m-0 text-xs font-semibold text-fg-red-700" role="alert">{t('documents.versionReview.requestError')}</p>
      ) : null}
      {isDone ? (
        <p className="m-0 text-xs font-semibold text-fg-emerald-700" role="status">{t('documents.versionReview.requested')}</p>
      ) : null}
      <div className="flex justify-end">
        <button className="workbench-button-primary h-8 px-3 text-xs disabled:opacity-50" disabled={!canSubmit} type="submit">
          {isSaving ? t('documents.versionReview.saving') : t('documents.versionReview.request')}
        </button>
      </div>
    </form>
  )
}

/**
 * Props of {@link DocumentApprovalSummary}.
 */
type DocumentApprovalSummaryProps = {
  /** Documents API token used to label the Work Item. */
  accessToken: string
  /** Approval to summarize. */
  approval: ApprovalRequest
  /** Locale used for labels. */
  locale: Locale
  /** Members used to show reviewer names. */
  members?: readonly MentionableMember[]
  /** Opens the Work Item. */
  onNavigate?: (path: string) => void
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Status, reviewers, and Work Item of one Document version approval.
 *
 * @param props - Approval and display helpers.
 * @returns The approval summary card.
 */
function DocumentApprovalSummary({
  accessToken,
  approval,
  locale,
  members,
  onNavigate,
  t,
}: DocumentApprovalSummaryProps) {
  const workItemId = approval.teamId && approval.issueId
    ? createCanonicalWorkItemId(approval.teamId, approval.issueId)
    : undefined
  return (
    <article className="grid gap-2 rounded-lg border border-[var(--workbench-border)] px-3 py-2" data-testid={`document-approval-${approval.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={resolveApprovalStatusClassName(approval.status)}>{t(`approval.status.${approval.status}`)}</span>
        <span className="text-xs font-medium text-[var(--workbench-muted)]">
          {t('documents.versionReview.dueValue').replace('{date}', formatDateTime(approval.dueAt, locale))}
        </span>
      </div>
      {workItemId ? (
        <button
          className="w-fit text-left text-sm font-semibold text-[var(--workbench-accent)] hover:underline disabled:no-underline"
          disabled={!onNavigate}
          onClick={() => onNavigate?.(createWorkItemSearchPath(workItemId))}
          type="button"
        >
          <DocumentRelationTargetLabel
            accessToken={accessToken}
            locale={locale}
            t={t}
            target={{ kind: 'work-item', workItemId }}
          />
        </button>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {approval.reviewers.map((reviewer) => (
          <span className="workbench-badge" key={reviewer.memberKey}>
            {resolveMemberLabel(reviewer.memberKey, members)} · {t(`approval.reviewer.${reviewer.status}`)}
          </span>
        ))}
      </div>
    </article>
  )
}

/**
 * Shows a member by name when known.
 *
 * @param memberKey - Member key.
 * @param members - Known members.
 * @returns Display label.
 */
function resolveMemberLabel(memberKey: string, members?: readonly MentionableMember[]) {
  const member = members?.find((candidate) => candidate.memberKey === memberKey)
  return member?.name ?? member?.email ?? memberKey
}

/**
 * A centered status line.
 *
 * @param props - Text and optional live-region role.
 * @returns The notice.
 */
function StatusNotice({
  role,
  text,
}: {
  /** Live-region role for errors. */
  role?: 'alert'
  /** Text to show. */
  text: string
}) {
  return (
    <p className="m-0 px-6 py-10 text-center text-sm font-medium text-[var(--workbench-muted)]" role={role}>
      {text}
    </p>
  )
}

/**
 * Formats a timestamp for the version review.
 *
 * @param value - ISO timestamp.
 * @param locale - Display locale.
 * @returns Localized date and time.
 */
function formatDateTime(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

/**
 * Builds a local `YYYY-MM-DD` date some days from today.
 *
 * @param days - Days to add.
 * @returns The date input value.
 */
function createDefaultDueDate(days = DEFAULT_APPROVAL_DUE_DAYS) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
