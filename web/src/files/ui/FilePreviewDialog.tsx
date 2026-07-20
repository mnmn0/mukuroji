import { useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type {
  AnnotationAnchor,
  FileAnnotation,
  FileAttachment,
  FileVersion,
} from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { SafeCommentBody } from '../../issues/ui/SafeCommentBody'
import type { WorkspaceMember } from '../../workspace/api'
import type { FileArtifactsController } from '../mutations/useFileArtifacts'

/**
 * FilePreviewDialog の props です。
 */
export type FilePreviewDialogProps = {
  /**
   * preview する file です。
   */
  file: FileAttachment
  /**
   * 初期表示する version です。
   */
  initialVersion?: FileVersion
  /**
   * preview access と annotation mutation を提供する controller です。
   */
  controller: FileArtifactsController
  /**
   * annotation author の表示名を解決する Workspace member 一覧です。
   */
  members: WorkspaceMember[]
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * dialog を閉じる callback です。
   */
  onClose: () => void
}

/**
 * image/PDF/video preview と正規化座標 annotation を表示する fullscreen dialog です。
 */
export function FilePreviewDialog({
  controller,
  file,
  initialVersion,
  locale,
  members,
  onClose,
}: FilePreviewDialogProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const dialogRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [selectedVersionId, setSelectedVersionId] = useState(
    initialVersion?.id ?? file.currentVersion.id,
  )
  const selectedVersion = file.versions.find((version) => version.id === selectedVersionId) ??
    file.currentVersion
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [annotations, setAnnotations] = useState<FileAnnotation[]>([])
  const [pendingAnchor, setPendingAnchor] = useState<AnnotationAnchor>()
  const [annotationBody, setAnnotationBody] = useState('')
  const [isPinning, setIsPinning] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const annotationSaveOperationRef = useRef(0)
  const selectedVersionKey = `${file.id}:${selectedVersion.id}`
  const selectedVersionKeyRef = useRef(selectedVersionKey)
  const getAnnotations = controller.getAnnotations
  const getVersionAccess = controller.getVersionAccess

  useEffect(() => () => {
    annotationSaveOperationRef.current += 1
  }, [])

  useEffect(() => {
    if (selectedVersionKeyRef.current === selectedVersionKey) {
      return
    }

    annotationSaveOperationRef.current += 1
    selectedVersionKeyRef.current = selectedVersionKey
    setIsSaving(false)
    setSaveFailed(false)
  }, [selectedVersionKey])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined
    const dialog = dialogRef.current

    dialog?.focus()

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab' || !dialog) {
        return
      }

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ))

      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]
      const last = focusable.at(-1)

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [onClose])

  useEffect(() => {
    let cancelled = false

    void Promise.resolve().then(async () => {
      if (cancelled) {
        return
      }

      setPreviewUrl(undefined)
      setAnnotations([])
      setPendingAnchor(undefined)
      setIsPinning(false)
      setIsLoading(false)
      setLoadFailed(false)

      if (selectedVersion.scanStatus !== 'available') {
        return
      }

      setIsLoading(true)

      try {
        const [access, nextAnnotations] = await Promise.all([
          getVersionAccess(file, selectedVersion, 'inline'),
          getAnnotations(file, selectedVersion),
        ])

        if (!cancelled) {
          setPreviewUrl(access?.url)
          setAnnotations(nextAnnotations)
          setLoadFailed(!access)
        }
      } catch {
        if (!cancelled) {
          setLoadFailed(true)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    })

    return () => {
      cancelled = true
    }
  }, [file, getAnnotations, getVersionAccess, selectedVersion])

  const createAnchorAt = (x: number, y: number, pageNumber?: number) => {
    if (
      !file.capabilities.canAnnotate ||
      isSaving ||
      selectedVersion.previewKind === 'none' ||
      selectedVersion.scanStatus !== 'available'
    ) {
      return
    }

    const baseAnchor = {
      kind: selectedVersion.previewKind,
      x: clampCoordinate(x),
      y: clampCoordinate(y),
    } satisfies AnnotationAnchor

    setSaveFailed(false)
    setPendingAnchor(selectedVersion.previewKind === 'pdf'
      ? { ...baseAnchor, pageNumber: pageNumber ?? 1 }
      : selectedVersion.previewKind === 'video'
        ? {
            ...baseAnchor,
            timecodeMs: Math.round((videoRef.current?.currentTime ?? 0) * 1_000),
          }
        : baseAnchor)
  }

  const saveAnnotation = async () => {
    const bodyMarkdown = annotationBody.trim()

    if (
      !pendingAnchor ||
      !bodyMarkdown ||
      isSaving ||
      selectedVersion.scanStatus !== 'available'
    ) {
      return
    }

    const operationId = annotationSaveOperationRef.current + 1
    const operationFile = file
    const operationVersion = selectedVersion
    const operationAnchor = pendingAnchor
    const operationVersionKey = selectedVersionKey

    annotationSaveOperationRef.current = operationId
    setIsSaving(true)
    setSaveFailed(false)

    try {
      const annotation = await controller.createAnnotation(operationFile, operationVersion, {
        anchor: operationAnchor,
        bodyMarkdown,
      })

      if (
        annotationSaveOperationRef.current !== operationId ||
        selectedVersionKeyRef.current !== operationVersionKey
      ) {
        return
      }

      if (!annotation) {
        setSaveFailed(true)
        return
      }

      setAnnotations((current) => [...current, annotation])
      setPendingAnchor(undefined)
      setAnnotationBody('')
      setIsPinning(false)
    } catch (saveError) {
      console.error('File annotation save failed:', saveError)
      if (
        annotationSaveOperationRef.current === operationId &&
        selectedVersionKeyRef.current === operationVersionKey
      ) {
        setSaveFailed(true)
      }
    } finally {
      if (
        annotationSaveOperationRef.current === operationId &&
        selectedVersionKeyRef.current === operationVersionKey
      ) {
        setIsSaving(false)
      }
    }
  }

  const download = async () => {
    const access = await controller.getVersionAccess(file, selectedVersion, 'attachment')

    if (!access) {
      return
    }

    const link = document.createElement('a')
    link.href = access.url
    link.download = selectedVersion.fileName
    link.rel = 'noopener noreferrer'
    link.click()
  }

  return (
    <div
      aria-label={t('files.preview.dialogLabel')}
      aria-modal="true"
      className="fixed inset-0 z-[70] grid bg-slate-950/80 p-3 backdrop-blur-sm sm:p-5"
      data-testid="file-preview-dialog"
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="grid min-h-0 w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-white/15 bg-[#101615] shadow-2xl">
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-white">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{file.name}</p>
            <p className="mt-0.5 text-xs text-slate-300">
              {t('files.version.label').replace('{number}', String(selectedVersion.number))}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="file-preview-version">{t('files.version.select')}</label>
            <select
              className="h-9 rounded-md border border-white/20 bg-white/10 px-3 text-xs font-semibold text-white"
              disabled={isSaving}
              id="file-preview-version"
              onChange={(event) => {
                const nextVersionId = event.target.value

                annotationSaveOperationRef.current += 1
                selectedVersionKeyRef.current = `${file.id}:${nextVersionId}`
                setIsSaving(false)
                setSaveFailed(false)
                setSelectedVersionId(nextVersionId)
              }}
              value={selectedVersion.id}
            >
              {file.versions.map((version) => (
                <option className="text-slate-950" key={version.id} value={version.id}>
                  {t('files.version.label').replace('{number}', String(version.number))} · {version.fileName}
                </option>
              ))}
            </select>
            <button
              className="h-9 rounded-md border border-white/20 px-3 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-50"
              disabled={!file.capabilities.canDownload || selectedVersion.scanStatus !== 'available'}
              onClick={() => void download()}
              type="button"
            >
              {t('files.action.download')}
            </button>
            {file.capabilities.canAnnotate &&
            selectedVersion.previewKind !== 'none' &&
            selectedVersion.scanStatus === 'available' ? (
              <button
                aria-pressed={isPinning}
                className={`h-9 rounded-md border px-3 text-xs font-semibold text-white disabled:opacity-50 ${
                  isPinning ? 'border-amber-300 bg-amber-500/30' : 'border-white/20 hover:bg-white/10'
                }`}
                disabled={isSaving}
                onClick={() => {
                  setIsPinning((current) => !current)
                  setPendingAnchor(undefined)
                }}
                type="button"
              >
                {t(isPinning ? 'files.annotation.modeActive' : 'files.annotation.mode')}
              </button>
            ) : null}
            <button
              aria-label={t('files.preview.close')}
              className="grid h-9 w-9 place-items-center rounded-md border border-white/20 text-lg text-white hover:bg-white/10"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>
        </header>

        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_340px] max-[880px]:grid-cols-1 max-[880px]:grid-rows-[minmax(360px,1fr)_minmax(260px,0.7fr)]">
          <div className="relative grid min-h-0 place-items-center overflow-hidden bg-[#080c0b] p-3">
            {isLoading ? (
              <p className="text-sm font-semibold text-slate-300">{t('files.preview.loading')}</p>
            ) : selectedVersion.scanStatus !== 'available' ? (
              <PreviewUnavailable status={selectedVersion.scanStatus} t={t} />
            ) : loadFailed || !previewUrl ? (
              <p className="text-sm font-semibold text-red-300">{t('files.preview.error')}</p>
            ) : (
              <PreviewMedia
                annotations={annotations}
                canAnnotate={file.capabilities.canAnnotate && !isSaving}
                fileName={selectedVersion.fileName}
                isPinning={isPinning}
                kind={selectedVersion.previewKind}
                onCreateAnchor={createAnchorAt}
                pendingAnchor={pendingAnchor}
                t={t}
                url={previewUrl}
                videoRef={videoRef}
              />
            )}
          </div>

          <aside className="min-h-0 overflow-y-auto border-l border-white/10 bg-white p-4 max-[880px]:border-l-0 max-[880px]:border-t">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-[var(--workbench-text)]">{t('files.annotation.title')}</h2>
              <span className="workbench-badge">{annotations.length}</span>
            </div>
            {pendingAnchor ? (
              <div className="mt-4 grid gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
                  {t('files.annotation.body')}
                  <textarea
                    autoFocus
                    className="workbench-input min-h-20 px-3 py-2 text-sm"
                    disabled={isSaving}
                    onChange={(event) => setAnnotationBody(event.target.value)}
                    value={annotationBody}
                  />
                </label>
                {pendingAnchor.kind === 'pdf' ? (
                  <p className="text-xs font-semibold text-[var(--workbench-muted)]">
                    {formatAnnotationPosition(pendingAnchor, t)}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button
                    className="workbench-button-secondary h-8 px-3 text-xs disabled:opacity-50"
                    disabled={isSaving}
                    onClick={() => {
                      setPendingAnchor(undefined)
                      setAnnotationBody('')
                      setIsPinning(false)
                      setSaveFailed(false)
                    }}
                    type="button"
                  >
                    {t('collaboration.cancel')}
                  </button>
                  <button
                    className="workbench-button-primary h-8 px-3 text-xs disabled:opacity-50"
                    disabled={!annotationBody.trim() || isSaving}
                    onClick={() => void saveAnnotation()}
                    type="button"
                  >
                    {t(isSaving ? 'files.annotation.saving' : 'files.annotation.submit')}
                  </button>
                </div>
                {saveFailed ? (
                  <p className="text-xs font-semibold text-red-700" role="alert">
                    {t('files.error.request')}
                  </p>
                ) : null}
              </div>
            ) : file.capabilities.canAnnotate ? (
              <div className="mt-3 rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] p-3 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                <p>{t('files.annotation.hint')}</p>
                {selectedVersion.previewKind !== 'pdf' &&
                selectedVersion.scanStatus === 'available' ? (
                  <button
                    className="mt-2 text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2"
                    onClick={() => createAnchorAt(0.5, 0.5)}
                    type="button"
                  >
                    {t('files.annotation.keyboardAction')}
                  </button>
                ) : null}
              </div>
            ) : null}
            <ol className="mt-4 grid gap-3">
              {annotations.map((annotation, index) => (
                <li className="rounded-lg border border-[var(--workbench-border)] bg-white p-3" key={annotation.id}>
                  <div className="flex items-start gap-2">
                    <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-[#0f766e] text-[0.65rem] font-bold text-white">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-[var(--workbench-text)]">
                        {resolveMemberName(annotation.authorMemberKey, members)}
                      </p>
                      <p className="mt-0.5 text-[0.68rem] text-[var(--workbench-muted)]">
                        {formatAnnotationPosition(annotation.anchor, t)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 text-sm">
                    <SafeCommentBody bodyMarkdown={annotation.bodyMarkdown} />
                  </div>
                </li>
              ))}
            </ol>
            {annotations.length === 0 && !pendingAnchor ? (
              <p className="mt-4 text-sm font-medium text-[var(--workbench-muted)]">{t('files.annotation.empty')}</p>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  )
}

function PreviewMedia({
  annotations,
  canAnnotate,
  fileName,
  isPinning,
  kind,
  onCreateAnchor,
  pendingAnchor,
  t,
  url,
  videoRef,
}: {
  annotations: FileAnnotation[]
  canAnnotate: boolean
  fileName: string
  isPinning: boolean
  kind: FileVersion['previewKind']
  onCreateAnchor: (x: number, y: number, pageNumber?: number) => void
  pendingAnchor?: AnnotationAnchor
  t: ReturnType<typeof createTranslator>
  url: string
  videoRef: React.RefObject<HTMLVideoElement | null>
}) {
  if (kind === 'pdf') {
    return (
      <PdfPreview
        annotations={annotations}
        canAnnotate={canAnnotate}
        isPinning={isPinning}
        onCreateAnchor={onCreateAnchor}
        pendingAnchor={pendingAnchor}
        t={t}
        url={url}
      />
    )
  }

  if (kind === 'image' || kind === 'video') {
    return (
      <ContainedMediaPreview
        annotations={annotations}
        fileName={fileName}
        isPinning={isPinning}
        kind={kind}
        onCreateAnchor={onCreateAnchor}
        pendingAnchor={pendingAnchor}
        t={t}
        url={url}
        videoRef={videoRef}
      />
    )
  }

  return <p className="text-sm font-semibold text-slate-300">{fileName}</p>
}

function ContainedMediaPreview({
  annotations,
  fileName,
  isPinning,
  kind,
  onCreateAnchor,
  pendingAnchor,
  t,
  url,
  videoRef,
}: {
  annotations: FileAnnotation[]
  fileName: string
  isPinning: boolean
  kind: 'image' | 'video'
  onCreateAnchor: (x: number, y: number) => void
  pendingAnchor?: AnnotationAnchor
  t: ReturnType<typeof createTranslator>
  url: string
  videoRef: React.RefObject<HTMLVideoElement | null>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [intrinsicSize, setIntrinsicSize] = useState<{ height: number; width: number }>()
  const [surfaceRect, setSurfaceRect] = useState({ height: 0, left: 0, top: 0, width: 0 })

  useEffect(() => {
    const container = containerRef.current

    if (!container || !intrinsicSize) {
      return
    }

    const updateSurfaceRect = () => {
      setSurfaceRect(calculateContainedRect(
        container.clientWidth,
        container.clientHeight,
        intrinsicSize.width,
        intrinsicSize.height,
      ))
    }

    updateSurfaceRect()
    const resizeObserver = new ResizeObserver(updateSurfaceRect)
    resizeObserver.observe(container)

    return () => resizeObserver.disconnect()
  }, [intrinsicSize])

  const surface = surfaceRect.width > 0 && surfaceRect.height > 0 ? (
    <div
      aria-label={t('files.annotation.canvas')}
      className={`absolute ${isPinning ? 'cursor-crosshair' : 'pointer-events-none'}`}
      data-testid="file-preview-canvas"
      onPointerDown={(event) => {
        if (!isPinning) {
          return
        }

        const bounds = event.currentTarget.getBoundingClientRect()
        onCreateAnchor(
          (event.clientX - bounds.left) / bounds.width,
          (event.clientY - bounds.top) / bounds.height,
        )
      }}
      role="group"
      style={surfaceRect}
    >
      <AnnotationPins
        annotations={annotations}
        kind={kind}
        pendingAnchor={pendingAnchor}
        t={t}
      />
    </div>
  ) : null

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg bg-slate-900" ref={containerRef}>
      {kind === 'image' ? (
        <img
          alt={fileName}
          className="h-full w-full object-contain"
          draggable={false}
          onLoad={(event) => setIntrinsicSize({
            height: event.currentTarget.naturalHeight,
            width: event.currentTarget.naturalWidth,
          })}
          src={url}
        />
      ) : (
        <video
          aria-label={fileName}
          className="h-full w-full object-contain"
          controls
          onLoadedMetadata={(event) => setIntrinsicSize({
            height: event.currentTarget.videoHeight,
            width: event.currentTarget.videoWidth,
          })}
          ref={videoRef}
          src={url}
        />
      )}
      {surface}
    </div>
  )
}

function PdfPreview({
  annotations,
  canAnnotate,
  isPinning,
  onCreateAnchor,
  pendingAnchor,
  t,
  url,
}: {
  annotations: FileAnnotation[]
  canAnnotate: boolean
  isPinning: boolean
  onCreateAnchor: (x: number, y: number, pageNumber: number) => void
  pendingAnchor?: AnnotationAnchor
  t: ReturnType<typeof createTranslator>
  url: string
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [loadState, setLoadState] = useState<'error' | 'loading' | 'ready'>('loading')

  useEffect(() => {
    let cancelled = false
    let destroyLoadingTask: (() => void) | undefined

    void Promise.resolve().then(async () => {
      if (cancelled) {
        return
      }

      setDocument(undefined)
      setLoadState('loading')

      try {
        const { createPdfLoadingTask } = await import('../pdfRuntime')

        if (cancelled) {
          return
        }

        const loadingTask = createPdfLoadingTask(url)
        destroyLoadingTask = () => void loadingTask.destroy()
        const nextDocument = await loadingTask.promise

        if (cancelled) {
          return
        }

        setDocument(nextDocument)
        setLoadState('ready')
      } catch {
        if (!cancelled) {
          setLoadState('error')
        }
      }
    })

    return () => {
      cancelled = true
      destroyLoadingTask?.()
    }
  }, [url])

  if (loadState === 'loading') {
    return <p className="text-sm font-semibold text-slate-300">{t('files.preview.loading')}</p>
  }

  if (loadState === 'error' || !document) {
    return <p className="text-sm font-semibold text-red-300">{t('files.preview.error')}</p>
  }

  return (
    <div
      aria-label={t('files.annotation.canvas')}
      className="h-full w-full overflow-y-auto rounded-lg bg-slate-700 p-4"
      data-testid="file-preview-canvas"
      ref={scrollContainerRef}
      role="group"
    >
      <div className="mx-auto grid max-w-[960px] gap-4">
        {Array.from({ length: document.numPages }, (_, index) => (
          <PdfPage
            annotations={annotations}
            canAnnotate={canAnnotate}
            document={document}
            isPinning={isPinning}
            key={index + 1}
            onCreateAnchor={onCreateAnchor}
            pageNumber={index + 1}
            pendingAnchor={pendingAnchor}
            scrollRootRef={scrollContainerRef}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

function PdfPage({
  annotations,
  canAnnotate,
  document,
  isPinning,
  onCreateAnchor,
  pageNumber,
  pendingAnchor,
  scrollRootRef,
  t,
}: {
  annotations: FileAnnotation[]
  canAnnotate: boolean
  document: PDFDocumentProxy
  isPinning: boolean
  onCreateAnchor: (x: number, y: number, pageNumber: number) => void
  pageNumber: number
  pendingAnchor?: AnnotationAnchor
  scrollRootRef: React.RefObject<HTMLDivElement | null>
  t: ReturnType<typeof createTranslator>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [isNearViewport, setIsNearViewport] = useState(pageNumber <= 2)
  const [page, setPage] = useState<PDFPageProxy>()
  const [renderFailed, setRenderFailed] = useState(false)
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 })

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    if (typeof IntersectionObserver === 'undefined') {
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled) {
          setIsNearViewport(true)
        }
      })
      return () => {
        cancelled = true
      }
    }

    const observer = new IntersectionObserver((entries) => {
      const isNear = entries[0]?.isIntersecting ?? false
      setIsNearViewport(isNear)

      if (!isNear) {
        setPage(undefined)
      }
    }, {
      root: scrollRootRef.current,
      rootMargin: '800px 0px',
      threshold: 0,
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [scrollRootRef])

  useEffect(() => {
    if (!isNearViewport) {
      return
    }

    let cancelled = false

    void document.getPage(pageNumber).then((nextPage) => {
      if (!cancelled) {
        setRenderFailed(false)
        setPage(nextPage)
      }
    }).catch(() => {
      if (!cancelled) {
        setRenderFailed(true)
      }
    })

    return () => {
      cancelled = true
    }
  }, [document, isNearViewport, pageNumber])

  useEffect(() => {
    const container = containerRef.current

    if (!container) {
      return
    }

    const updateWidth = () => setContainerWidth(container.clientWidth)
    updateWidth()
    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(container)

    return () => resizeObserver.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas || !page || !isNearViewport || containerWidth <= 0) {
      return
    }

    const baseViewport = page.getViewport({ scale: 1 })
    const cssWidth = Math.min(containerWidth, 960)
    const cssScale = cssWidth / baseViewport.width
    const outputScale = Math.min(window.devicePixelRatio || 1, 2)
    const renderViewport = page.getViewport({ scale: cssScale * outputScale })
    const cssHeight = renderViewport.height / outputScale

    canvas.width = Math.floor(renderViewport.width)
    canvas.height = Math.floor(renderViewport.height)
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
    setViewportSize({ height: cssHeight, width: cssWidth })
    setRenderFailed(false)

    let cancelled = false
    const renderTask = page.render({ canvas, viewport: renderViewport })
    void renderTask.promise.catch((error: unknown) => {
      if (!cancelled && (!(error instanceof Error) || error.name !== 'RenderingCancelledException')) {
        setRenderFailed(true)
      }
    })

    return () => {
      cancelled = true
      renderTask.cancel()
    }
  }, [containerWidth, isNearViewport, page])

  useEffect(() => () => {
    page?.cleanup()
  }, [page])

  const pageStyle = viewportSize.width > 0
    ? { height: viewportSize.height, width: viewportSize.width }
    : { aspectRatio: '1 / 1.414', width: '100%' }
  const pageLabel = t('files.annotation.page').replace('{page}', String(pageNumber))

  return (
    <div className="w-full" ref={containerRef}>
      <div
        className="group relative mx-auto overflow-hidden bg-white shadow-xl"
        style={pageStyle}
      >
        {renderFailed ? (
          <p className="grid h-full place-items-center bg-slate-900 px-4 py-8 text-center text-sm font-semibold text-red-300">
            {t('files.preview.error')}
          </p>
        ) : page && isNearViewport ? (
          <canvas aria-label={pageLabel} className="h-full w-full" ref={canvasRef} />
        ) : (
          <div
            aria-label={pageLabel}
            className="grid h-full place-items-center bg-slate-100 text-xs font-semibold text-slate-500"
            role="status"
          >
            {pageLabel}
          </div>
        )}
        {canAnnotate && isNearViewport ? (
          <button
            aria-label={t('files.annotation.keyboardPageAction').replace('{page}', String(pageNumber))}
            className="absolute right-2 top-2 z-20 grid h-8 w-8 place-items-center rounded-full border border-slate-300 bg-white text-sm font-bold text-[var(--workbench-primary)] opacity-0 shadow transition hover:opacity-100 focus:opacity-100 group-hover:opacity-100"
            onClick={() => onCreateAnchor(0.5, 0.5, pageNumber)}
            type="button"
          >
            +
          </button>
        ) : null}
        {page && isNearViewport && viewportSize.width > 0 ? (
            <div
              className={`absolute inset-0 ${isPinning ? 'cursor-crosshair' : 'pointer-events-none'}`}
              data-testid={`file-preview-page-${pageNumber}`}
              onPointerDown={(event) => {
                if (!isPinning) {
                  return
                }

                const bounds = event.currentTarget.getBoundingClientRect()
                onCreateAnchor(
                  (event.clientX - bounds.left) / bounds.width,
                  (event.clientY - bounds.top) / bounds.height,
                  pageNumber,
                )
              }}
            >
              <AnnotationPins
                annotations={annotations}
                kind="pdf"
                pageNumber={pageNumber}
                pendingAnchor={pendingAnchor}
                t={t}
              />
            </div>
        ) : null}
      </div>
    </div>
  )
}

function AnnotationPins({
  annotations,
  kind,
  pageNumber,
  pendingAnchor,
  t,
}: {
  annotations: FileAnnotation[]
  kind: AnnotationAnchor['kind']
  pageNumber?: number
  pendingAnchor?: AnnotationAnchor
  t: ReturnType<typeof createTranslator>
}) {
  const visibleAnnotations = annotations.filter((annotation) =>
    isAnchorOnSurface(annotation.anchor, kind, pageNumber)
  )
  const isPendingVisible = pendingAnchor
    ? isAnchorOnSurface(pendingAnchor, kind, pageNumber)
    : false

  return (
    <>
      {visibleAnnotations.map((annotation) => {
        const number = annotations.findIndex((candidate) => candidate.id === annotation.id) + 1

        return (
          <span
            aria-label={t('files.annotation.pinLabel').replace('{number}', String(number))}
            className="absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-[#0f766e] text-[0.68rem] font-bold text-white shadow-lg"
            key={annotation.id}
            role="img"
            style={{
              left: `${(annotation.anchor.x ?? 0.5) * 100}%`,
              top: `${(annotation.anchor.y ?? 0.5) * 100}%`,
            }}
          >
            {number}
          </span>
        )
      })}
      {pendingAnchor && isPendingVisible ? (
        <span
          aria-hidden="true"
          className="absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-white bg-amber-500/80"
          style={{
            left: `${(pendingAnchor.x ?? 0.5) * 100}%`,
            top: `${(pendingAnchor.y ?? 0.5) * 100}%`,
          }}
        />
      ) : null}
    </>
  )
}

function isAnchorOnSurface(
  anchor: AnnotationAnchor,
  kind: AnnotationAnchor['kind'],
  pageNumber?: number,
) {
  return anchor.kind === kind && (kind !== 'pdf' || (anchor.pageNumber ?? 1) === pageNumber)
}

function calculateContainedRect(
  containerWidth: number,
  containerHeight: number,
  intrinsicWidth: number,
  intrinsicHeight: number,
) {
  if (containerWidth <= 0 || containerHeight <= 0 || intrinsicWidth <= 0 || intrinsicHeight <= 0) {
    return { height: 0, left: 0, top: 0, width: 0 }
  }

  const scale = Math.min(containerWidth / intrinsicWidth, containerHeight / intrinsicHeight)
  const width = intrinsicWidth * scale
  const height = intrinsicHeight * scale

  return {
    height,
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
  }
}

function PreviewUnavailable({
  status,
  t,
}: {
  status: FileVersion['scanStatus']
  t: ReturnType<typeof createTranslator>
}) {
  const key = status === 'blocked'
    ? 'files.scan.blocked'
    : status === 'failed'
      ? 'files.scan.failed'
      : 'files.scan.processing'

  return (
    <div className="max-w-sm rounded-lg border border-white/15 bg-white/5 px-5 py-6 text-center">
      <p className="text-sm font-semibold text-white">{t(key)}</p>
      <p className="mt-2 text-xs leading-5 text-slate-300">{t('files.scan.description')}</p>
    </div>
  )
}

function resolveMemberName(memberKey: string, members: WorkspaceMember[]) {
  const member = members.find((candidate) => candidate.memberKey === memberKey)

  return member?.name ?? member?.email ?? memberKey
}

function formatAnnotationPosition(
  anchor: AnnotationAnchor,
  t: ReturnType<typeof createTranslator>,
) {
  if (anchor.kind === 'pdf') {
    return t('files.annotation.page').replace('{page}', String(anchor.pageNumber ?? 1))
  }

  if (anchor.kind === 'video') {
    return t('files.annotation.time').replace('{time}', formatTimecode(anchor.timecodeMs ?? 0))
  }

  return t('files.annotation.imagePosition')
}

function formatTimecode(timecodeMs: number) {
  const totalSeconds = Math.max(0, Math.floor(timecodeMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function clampCoordinate(value: number) {
  return Math.min(1, Math.max(0, value))
}
