import { useMemo, useRef, useState } from 'react'
import type { ApprovalRequest, FileAttachment } from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../i18n'
import type { WorkspaceMember } from '../workspace/api'
import { FilePreviewDialog } from './FilePreviewDialog'
import type { ApprovalDecision } from './api'
import type { FileArtifactsController } from './useFileArtifacts'

const maximumApprovalReviewerCount = 20
const maximumApprovalCommentLength = 2_000

/**
 * IssueArtifactsPanel の props です。
 */
export type IssueArtifactsPanelProps = {
  /**
   * File/approval state と mutation を提供する controller です。
   */
  controller: FileArtifactsController
  /**
   * reviewer/actor 表示と reviewer picker に使う Workspace member 一覧です。
   */
  members: WorkspaceMember[]
  /**
   * 現在の Workspace member key です。
   */
  currentMemberKey?: string
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * Project file tab 用の広い layout にするかどうかです。
   */
  expanded?: boolean
  /**
   * 外側 layout が追加する class name です。
   */
  className?: string
}

/**
 * Dialog で最初に開く file version です。
 */
type FilePreviewTarget = {
  /**
   * Preview 対象 file です。
   */
  file: FileAttachment
  /**
   * Preview 対象として選ばれた利用可能な version です。
   */
  version: FileAttachment['currentVersion']
}

/**
 * Work Item/Project の添付、version、proofing、approval をひとつにまとめた panel です。
 */
export function IssueArtifactsPanel({
  ...props
}: IssueArtifactsPanelProps) {
  const scope = props.controller.scope
  const stateKey = scope?.kind === 'work-item'
    ? `work-item:${scope.teamId}:${scope.issueId}`
    : scope?.kind === 'project'
      ? `project:${scope.teamId}:${scope.projectId}`
      : 'unconfigured'

  return <IssueArtifactsPanelContent {...props} key={stateKey} />
}

function IssueArtifactsPanelContent({
  className = '',
  controller,
  currentMemberKey,
  expanded = false,
  locale,
  members,
}: IssueArtifactsPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const [replaceFile, setReplaceFile] = useState<FileAttachment>()
  const [previewTarget, setPreviewTarget] = useState<FilePreviewTarget>()
  const [isApprovalFormOpen, setIsApprovalFormOpen] = useState(false)
  const [approvalError, setApprovalError] = useState(false)
  const [guestAccess, setGuestAccess] = useState(false)
  const visibleFiles = controller.files.filter((file) => !file.deletedAt)

  return (
    <section
      className={`border-t border-[var(--workbench-border)] bg-white ${className}`}
      data-testid={expanded ? 'project-files-panel' : 'issue-artifacts-panel'}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="workbench-eyebrow text-[var(--workbench-muted)]">{t('files.title')}</h2>
            <span className="workbench-badge">{visibleFiles.length}</span>
          </div>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">{t('files.description')}</p>
        </div>
        {controller.capabilities.canUpload ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {controller.capabilities.canGrantGuestAccess ? (
              <label className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-white px-2.5 text-[0.68rem] font-semibold text-[var(--workbench-muted)]">
                <input
                  checked={guestAccess}
                  className="h-4 w-4 accent-[var(--workbench-primary)]"
                  onChange={(event) => setGuestAccess(event.target.checked)}
                  type="checkbox"
                />
                {t('files.guestAccess')}
              </label>
            ) : null}
            <button
              aria-controls="file-upload-input"
              className="workbench-button-primary h-9 px-3 text-xs disabled:opacity-55"
              disabled={controller.isMutating}
              onClick={() => uploadInputRef.current?.click()}
              type="button"
            >
              {t(controller.isMutating ? 'files.action.uploading' : 'files.action.upload')}
            </button>
          </div>
        ) : null}
        {controller.capabilities.canUpload ? (
          <input
            aria-label={t('files.action.upload')}
            data-testid="file-upload-input"
            disabled={controller.isMutating}
            hidden
            id="file-upload-input"
            multiple
            onChange={(event) => {
              const selectedFiles = Array.from(event.target.files ?? [])
              event.target.value = ''
              void controller.uploadFiles(selectedFiles, {
                guestAccess: controller.capabilities.canGrantGuestAccess ? guestAccess : false,
              })
            }}
            ref={uploadInputRef}
            type="file"
          />
        ) : null}
        {visibleFiles.some((file) => file.capabilities.canUploadVersion) ? (
          <input
            aria-label={t('files.action.newVersion')}
            data-testid="file-version-upload-input"
            disabled={controller.isMutating}
            hidden
            id="file-version-upload-input"
            onChange={(event) => {
              const selectedFile = event.target.files?.[0]
              event.target.value = ''

              if (selectedFile && replaceFile?.capabilities.canUploadVersion) {
                void controller.uploadFiles([selectedFile], { replaceFile })
              }
            }}
            ref={replaceInputRef}
            type="file"
          />
        ) : null}
      </div>

      {controller.hasLoadError ? (
        <div className="mx-5 mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5">
          <p className="text-sm font-semibold text-red-700">{t('files.error.load')}</p>
          <button className="text-xs font-semibold text-red-700 underline" onClick={() => void controller.refresh()} type="button">
            {t('collaboration.retry')}
          </button>
        </div>
      ) : null}
      {controller.mutationErrorStatus ? (
        <p className="mx-5 mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700" role="alert">
          {resolveFileErrorMessage(controller.mutationErrorStatus, controller.mutationErrorCode, t)}
        </p>
      ) : null}

      <div className={expanded ? 'px-5 pb-5' : 'border-t border-[var(--workbench-border)]'}>
        {controller.isLoading ? (
          <div className="grid gap-2 p-5" aria-label={t('files.loading')}>
            <span className="h-14 animate-pulse rounded-lg bg-[var(--workbench-surface-muted)]" />
            <span className="h-14 animate-pulse rounded-lg bg-[var(--workbench-surface-muted)]" />
          </div>
        ) : visibleFiles.length > 0 ? (
          <div className={expanded
            ? 'overflow-x-auto rounded-lg border border-[var(--workbench-border)]'
            : 'divide-y divide-[var(--workbench-border)]'}
          >
            {expanded ? (
              <div className="grid min-w-[760px] grid-cols-[minmax(220px,1fr)_110px_120px_150px] gap-4 bg-[var(--workbench-surface-muted)] px-4 py-2.5 text-xs font-semibold text-[var(--workbench-muted)]">
                <span>{t('tasks.file.column.name')}</span>
                <span>{t('files.version.heading')}</span>
                <span>{t('tasks.file.column.status')}</span>
                <span className="text-right">{t('files.action.heading')}</span>
              </div>
            ) : null}
            {visibleFiles.map((file) => (
              <FileRow
                controller={controller}
                expanded={expanded}
                file={file}
                key={file.id}
                onPreview={(version) => setPreviewTarget({ file, version })}
                onReplace={() => {
                  setReplaceFile(file)
                  replaceInputRef.current?.click()
                }}
                t={t}
              />
            ))}
          </div>
        ) : (
          <div className="p-5 text-center">
            <p className="text-sm font-semibold text-[var(--workbench-text)]">{t('files.empty.title')}</p>
            <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">{t('files.empty.description')}</p>
          </div>
        )}
      </div>

      {controller.scope?.kind === 'work-item' ? (
        <ApprovalSection
          approvals={controller.approvals}
          controller={controller}
          currentMemberKey={currentMemberKey}
          error={approvalError}
          files={visibleFiles}
          isFormOpen={isApprovalFormOpen}
          members={members}
          onErrorChange={setApprovalError}
          onFormOpenChange={setIsApprovalFormOpen}
          t={t}
        />
      ) : null}

      {previewTarget ? (
        <FilePreviewDialog
          controller={controller}
          file={previewTarget.file}
          initialVersion={previewTarget.version}
          locale={locale}
          members={members}
          onClose={() => setPreviewTarget(undefined)}
        />
      ) : null}
    </section>
  )
}

function FileRow({
  controller,
  expanded,
  file,
  onPreview,
  onReplace,
  t,
}: {
  controller: FileArtifactsController
  expanded: boolean
  file: FileAttachment
  onPreview: (version: FileAttachment['currentVersion']) => void
  onReplace: () => void
  t: ReturnType<typeof createTranslator>
}) {
  const version = file.currentVersion
  const availableVersion = file.versions.find((candidate) => candidate.scanStatus === 'available')
  const previewVersion = file.versions.find((candidate) =>
    candidate.scanStatus === 'available' && candidate.previewKind !== 'none'
  )
  const hasPreview = file.versions.some((candidate) => candidate.previewKind !== 'none')
  const download = async () => {
    if (!availableVersion) {
      return
    }

    const access = await controller.getVersionAccess(file, availableVersion, 'attachment')

    if (!access) {
      return
    }

    const link = document.createElement('a')
    link.href = access.url
    link.download = availableVersion.fileName
    link.rel = 'noopener noreferrer'
    link.click()
  }

  return (
    <article
      className={expanded
        ? 'grid min-w-[760px] grid-cols-[minmax(220px,1fr)_110px_120px_150px] items-center gap-4 border-t border-[var(--workbench-border)] px-4 py-3 first:border-t-0'
        : 'grid gap-3 px-5 py-4'}
      data-testid={`file-row-${file.id}`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">{file.name}</p>
        <p className="mt-1 truncate text-xs font-medium text-[var(--workbench-muted)]">
          {formatFileSize(version.sizeBytes)} · {version.contentType}
          {file.targetType === 'comment' ? ` · ${t('files.target.comment')}` : ''}
          {file.guestAccess ? ` · ${t('files.guestAccess')}` : ''}
        </p>
      </div>
      <span className="text-xs font-semibold text-[var(--workbench-muted)]">
        {t('files.version.label').replace('{number}', String(version.number))}
        {file.versionCount > 1 ? ` / ${file.versionCount}` : ''}
      </span>
      <span className={resolveScanBadgeClassName(version.scanStatus)}>
        {t(`files.scan.${version.scanStatus}`)}
      </span>
      <div className={`flex flex-wrap gap-2 ${expanded ? 'justify-end' : ''}`}>
        {hasPreview ? (
          <button
            className="workbench-button-secondary h-8 px-2.5 text-xs disabled:opacity-50"
            disabled={!previewVersion}
            onClick={() => previewVersion && onPreview(previewVersion)}
            type="button"
          >
            {t('files.action.preview')}
            {previewVersion && previewVersion.id !== version.id
              ? ` · ${t('files.version.label').replace('{number}', String(previewVersion.number))}`
              : ''}
          </button>
        ) : null}
        <button
          className="workbench-button-secondary h-8 px-2.5 text-xs disabled:opacity-50"
          disabled={!file.capabilities.canDownload || !availableVersion}
          onClick={() => void download()}
          type="button"
        >
          {t('files.action.download')}
          {availableVersion && availableVersion.id !== version.id
            ? ` · ${t('files.version.label').replace('{number}', String(availableVersion.number))}`
            : ''}
        </button>
        {file.capabilities.canUploadVersion ? (
          <button
            aria-controls="file-version-upload-input"
            className="workbench-button-secondary h-8 px-2.5 text-xs disabled:opacity-50"
            disabled={controller.isMutating}
            onClick={onReplace}
            type="button"
          >
            {t('files.action.newVersion')}
          </button>
        ) : null}
        {file.capabilities.canDelete ? (
          <button
            aria-label={t('files.action.deleteNamed').replace('{name}', file.name)}
            className="h-8 rounded-md px-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
            disabled={controller.isMutating}
            onClick={() => {
              if (window.confirm(t('files.delete.confirm').replace('{name}', file.name))) {
                void controller.deleteFile(file)
              }
            }}
            type="button"
          >
            {t('files.action.delete')}
          </button>
        ) : null}
      </div>
    </article>
  )
}

function ApprovalSection({
  approvals,
  controller,
  currentMemberKey,
  error,
  files,
  isFormOpen,
  members,
  onErrorChange,
  onFormOpenChange,
  t,
}: {
  approvals: ApprovalRequest[]
  controller: FileArtifactsController
  currentMemberKey?: string
  error: boolean
  files: FileAttachment[]
  isFormOpen: boolean
  members: WorkspaceMember[]
  onErrorChange: (error: boolean) => void
  onFormOpenChange: (open: boolean) => void
  t: ReturnType<typeof createTranslator>
}) {
  const activeMembers = members.filter((member) => member.status === 'active')

  return (
    <div className="border-t border-[var(--workbench-border)] px-5 py-4" data-testid="approval-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="workbench-eyebrow text-[var(--workbench-muted)]">{t('approval.title')}</h2>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">{t('approval.description')}</p>
        </div>
        {controller.capabilities.canRequestApproval && files.some((file) =>
          file.currentVersion.scanStatus === 'available' && file.capabilities.canRequestApproval
        ) ? (
          <button
            aria-expanded={isFormOpen}
            className="workbench-button-secondary h-9 px-3 text-xs"
            onClick={() => onFormOpenChange(!isFormOpen)}
            type="button"
          >
            {t('approval.action.request')}
          </button>
        ) : null}
      </div>

      {isFormOpen ? (
        <ApprovalRequestForm
          controller={controller}
          files={files}
          members={activeMembers}
          onCancel={() => onFormOpenChange(false)}
          onErrorChange={onErrorChange}
          onSuccess={() => onFormOpenChange(false)}
          t={t}
        />
      ) : null}
      {error ? <p className="mt-3 text-sm font-semibold text-red-700" role="alert">{t('approval.error')}</p> : null}

      <div className="mt-4 grid gap-3">
        {approvals.map((approval) => (
          <ApprovalCard
            approval={approval}
            controller={controller}
            currentMemberKey={currentMemberKey}
            file={files.find((candidate) => candidate.id === approval.fileId)}
            key={approval.id}
            members={members}
            onErrorChange={onErrorChange}
            t={t}
          />
        ))}
        {approvals.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] px-4 py-5 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('approval.empty')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function ApprovalRequestForm({
  controller,
  files,
  members,
  onCancel,
  onErrorChange,
  onSuccess,
  t,
}: {
  controller: FileArtifactsController
  files: FileAttachment[]
  members: WorkspaceMember[]
  onCancel: () => void
  onErrorChange: (error: boolean) => void
  onSuccess: () => void
  t: ReturnType<typeof createTranslator>
}) {
  const [selectedMemberKeys, setSelectedMemberKeys] = useState<string[]>([])

  return (
    <form
      className="mt-4 grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3"
      data-testid="approval-request-form"
      onSubmit={(event) => {
        event.preventDefault()
        const formData = new FormData(event.currentTarget)
        const file = files.find((candidate) => candidate.id === formData.get('fileId'))
        const dueDate = String(formData.get('dueAt') ?? '')
        const completionTransition = String(formData.get('completionTransition') ?? '')

        if (
          !file ||
          selectedMemberKeys.length === 0 ||
          selectedMemberKeys.length > maximumApprovalReviewerCount ||
          !dueDate
        ) {
          onErrorChange(true)
          return
        }

        onErrorChange(false)
        void controller.requestApproval({
          dueAt: new Date(`${dueDate}T23:59:59`).toISOString(),
          completionTransition: completionTransition === 'review' || completionTransition === 'done'
            ? completionTransition
            : undefined,
          fileId: file.id,
          reviewerMemberKeys: selectedMemberKeys,
          versionId: file.currentVersion.id,
        }).then((succeeded) => {
          onErrorChange(!succeeded)
          if (succeeded) {
            onSuccess()
          }
        })
      }}
    >
      <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
        {t('approval.file')}
        <select className="workbench-input h-9 px-3" name="fileId" required>
          {files.filter((file) =>
            file.currentVersion.scanStatus === 'available' && file.capabilities.canRequestApproval
          ).map((file) => (
            <option key={file.id} value={file.id}>{file.name} · v{file.currentVersion.number}</option>
          ))}
        </select>
      </label>
      <fieldset className="grid gap-2">
        <legend className="text-xs font-semibold text-[var(--workbench-text)]">{t('approval.reviewers')}</legend>
        <div className="grid max-h-32 gap-1 overflow-y-auto rounded-md border border-[var(--workbench-border)] bg-white p-2">
          {members.map((member) => (
            <label className="flex items-center gap-2 text-xs font-medium text-[var(--workbench-text)]" key={member.memberKey}>
              <input
                checked={selectedMemberKeys.includes(member.memberKey)}
                className="h-4 w-4 accent-[var(--workbench-primary)]"
                disabled={
                  !selectedMemberKeys.includes(member.memberKey) &&
                  selectedMemberKeys.length >= maximumApprovalReviewerCount
                }
                onChange={(event) => setSelectedMemberKeys((current) => {
                  if (!event.target.checked) {
                    return current.filter((key) => key !== member.memberKey)
                  }

                  return current.length < maximumApprovalReviewerCount &&
                    !current.includes(member.memberKey)
                    ? [...current, member.memberKey]
                    : current
                })}
                type="checkbox"
              />
              {member.name ?? member.email ?? member.memberKey}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
        {t('approval.dueAt')}
        <input className="workbench-input h-9 px-3" min={formatDateInput()} name="dueAt" required type="date" />
      </label>
      <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
        {t('approval.completionTransition')}
        <select className="workbench-input h-9 px-3" defaultValue="done" name="completionTransition">
          <option value="review">{t('tasks.status.review')}</option>
          <option value="done">{t('tasks.status.done')}</option>
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <button className="workbench-button-secondary h-9 px-3 text-xs" onClick={onCancel} type="button">
          {t('collaboration.cancel')}
        </button>
        <button className="workbench-button-primary h-9 px-3 text-xs disabled:opacity-50" disabled={controller.isMutating} type="submit">
          {t('approval.action.submit')}
        </button>
      </div>
    </form>
  )
}

function ApprovalCard({
  approval,
  controller,
  currentMemberKey,
  file,
  members,
  onErrorChange,
  t,
}: {
  approval: ApprovalRequest
  controller: FileArtifactsController
  currentMemberKey?: string
  file?: FileAttachment
  members: WorkspaceMember[]
  onErrorChange: (error: boolean) => void
  t: ReturnType<typeof createTranslator>
}) {
  const [comment, setComment] = useState('')
  const canCurrentUserDecide = approval.capabilities.canDecide && approval.reviewers.some((reviewer) =>
    reviewer.memberKey === currentMemberKey && reviewer.status === 'pending'
  )
  const canCurrentUserCancel = approval.status === 'pending' && (
    approval.capabilities.canCancel || approval.requestedByMemberKey === currentMemberKey
  )
  const decide = async (decision: ApprovalDecision) => {
    const succeeded = await controller.decideApproval(approval, {
      comment: comment.trim() || undefined,
      decision,
      expectedRevision: approval.revision,
    })
    onErrorChange(!succeeded)
    if (succeeded) {
      setComment('')
    }
  }
  const cancel = async () => {
    const succeeded = await controller.cancelApproval(approval)
    onErrorChange(!succeeded)
  }

  return (
    <article className="rounded-lg border border-[var(--workbench-border)] bg-white p-3" data-testid={`approval-${approval.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[var(--workbench-text)]">{file?.name ?? approval.fileId}</p>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
            {t('approval.dueValue').replace('{date}', formatApprovalDate(approval.dueAt))}
          </p>
        </div>
        <span className={resolveApprovalBadgeClassName(approval.status)}>{t(`approval.status.${approval.status}`)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {approval.reviewers.map((reviewer) => (
          <span className="workbench-badge" key={reviewer.memberKey}>
            {resolveMemberName(reviewer.memberKey, members)} · {t(`approval.reviewer.${reviewer.status}`)}
          </span>
        ))}
      </div>
      {canCurrentUserCancel ? (
        <div className="mt-3 flex justify-end border-t border-[var(--workbench-border)] pt-3">
          <button
            className="h-8 rounded-md border border-red-200 px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
            disabled={controller.isMutating}
            onClick={() => void cancel()}
            type="button"
          >
            {t('approval.action.cancelRequest')}
          </button>
        </div>
      ) : null}
      {canCurrentUserDecide ? (
        <div className="mt-3 grid gap-2 border-t border-[var(--workbench-border)] pt-3">
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
            {t('approval.comment')}
            <textarea
              className="workbench-input min-h-16 px-3 py-2 text-sm"
              maxLength={maximumApprovalCommentLength}
              onChange={(event) => setComment(event.target.value)}
              value={comment}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="workbench-button-primary h-8 px-3 text-xs" disabled={controller.isMutating} onClick={() => void decide('approve')} type="button">
              {t('approval.action.approve')}
            </button>
            <button className="workbench-button-secondary h-8 px-3 text-xs" disabled={controller.isMutating} onClick={() => void decide('request-changes')} type="button">
              {t('approval.action.requestChanges')}
            </button>
            <button className="h-8 rounded-md border border-red-200 px-3 text-xs font-semibold text-red-700 hover:bg-red-50" disabled={controller.isMutating} onClick={() => void decide('reject')} type="button">
              {t('approval.action.reject')}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  )
}

function resolveMemberName(memberKey: string, members: WorkspaceMember[]) {
  const member = members.find((candidate) => candidate.memberKey === memberKey)

  return member?.name ?? member?.email ?? memberKey
}

function formatFileSize(sizeBytes: number) {
  if (sizeBytes < 1_024) {
    return `${sizeBytes} B`
  }

  if (sizeBytes < 1_048_576) {
    return `${Math.round(sizeBytes / 1_024)} KB`
  }

  return `${(sizeBytes / 1_048_576).toFixed(1)} MB`
}

function resolveScanBadgeClassName(status: FileAttachment['currentVersion']['scanStatus']) {
  if (status === 'available') {
    return 'workbench-badge-success'
  }

  if (status === 'blocked' || status === 'failed') {
    return 'workbench-badge-danger'
  }

  return 'workbench-badge-warning'
}

function resolveApprovalBadgeClassName(status: ApprovalRequest['status']) {
  if (status === 'approved') {
    return 'workbench-badge-success'
  }

  if (status === 'rejected' || status === 'changes-requested') {
    return 'workbench-badge-danger'
  }

  return status === 'pending' ? 'workbench-badge-warning' : 'workbench-badge'
}

function resolveFileErrorMessage(
  status: number,
  code: string | undefined,
  t: ReturnType<typeof createTranslator>,
) {
  if (status === 413 || code === 'FileTooLarge') {
    return t('files.error.tooLarge')
  }

  if (status === 415) {
    return t('files.error.unsupportedType')
  }

  if (status === 403) {
    return t('files.error.forbidden')
  }

  if (status === 409) {
    return t('files.error.conflict')
  }

  if (status === 423) {
    return code === 'FileThreatDetected'
      ? t('files.scan.blocked')
      : t('files.scan.processing')
  }

  return t('files.error.upload')
}

function formatApprovalDate(value: string) {
  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

function formatDateInput(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}
