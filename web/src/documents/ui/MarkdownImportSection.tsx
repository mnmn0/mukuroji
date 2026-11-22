import { useId, useRef, useState, type ChangeEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  isImportableMarkdownPath,
  MARKDOWN_FOLDER_IMPORT_MAX_FILES,
  type MarkdownFolderFile,
  type MarkdownFolderImportFailure,
  type MarkdownFolderImportRequest,
} from '../model/markdownFolderImport'
import {
  MARKDOWN_IMPORT_MAX_BYTES,
  titleFromMarkdownFileName,
  type MarkdownDocumentImportRequest,
  type MarkdownImportErrorCode,
} from '../model/markdownImport'

/**
 * Props of the Documents home section that creates a page from Markdown.
 */
export type MarkdownImportSectionProps = {
  /** Whether an import is pending, which disables the create button. */
  isImporting: boolean
  /** Projects the new page can belong to. */
  projects: { id: string; name: string }[]
  /** Resolves display text. */
  t: (key: MessageKey) => string
  /**
   * Creates a page from the Markdown. Resolves with why the Markdown cannot
   * become a page, or undefined when the page was created or the request failed
   * elsewhere.
   */
  onImport: (
    request: MarkdownDocumentImportRequest,
  ) => Promise<MarkdownImportErrorCode | undefined>
  /**
   * Creates folders and pages from the Markdown files of a folder. Resolves
   * with why the folder cannot be imported, or undefined when it was imported
   * or the request failed elsewhere. Omission hides the folder import.
   */
  onImportFolder?: (
    request: MarkdownFolderImportRequest,
  ) => Promise<MarkdownFolderImportFailure | undefined>
}

/**
 * Markdown files read from a chosen folder, waiting to be imported.
 */
type ChosenFolder = {
  /** Name of the chosen folder. */
  name: string
  /** Markdown files with their paths inside the folder. */
  files: MarkdownFolderFile[]
}

/**
 * Formats a folder import failure for display.
 *
 * @param failure - Why the import failed and which file caused it.
 * @param t - Translator.
 * @returns The error message.
 */
function describeFolderFailure(
  failure: MarkdownFolderImportFailure | { code: 'unreadable'; path?: string },
  t: (key: MessageKey) => string,
): string {
  const message = t(`documents.import.error.${failure.code}`).replace(
    '{max}',
    String(MARKDOWN_FOLDER_IMPORT_MAX_FILES),
  )
  return failure.path ? `${failure.path}: ${message}` : message
}

/**
 * Creates a page from pasted Markdown or one Markdown file.
 *
 * @param props - Projects, translator, pending state, and import callback.
 * @returns The Markdown import section.
 */
export function MarkdownImportSection({
  isImporting,
  onImport,
  onImportFolder,
  projects,
  t,
}: MarkdownImportSectionProps) {
  const [projectId, setProjectId] = useState('')
  const [source, setSource] = useState('')
  const [fileTitle, setFileTitle] = useState('')
  const [errorCode, setErrorCode] = useState<
    MarkdownImportErrorCode | 'unreadable' | undefined
  >(undefined)
  const [fileInputKey, setFileInputKey] = useState(0)
  const [isReadingFile, setIsReadingFile] = useState(false)
  const readGenerationRef = useRef(0)
  const fieldId = useId()
  const [folder, setFolder] = useState<ChosenFolder | undefined>(undefined)
  const [folderError, setFolderError] = useState<string | undefined>(undefined)
  const [folderInputKey, setFolderInputKey] = useState(0)
  const [isReadingFolder, setIsReadingFolder] = useState(false)
  const folderGenerationRef = useRef(0)

  /**
   * Reads the Markdown files of the chosen folder. Files other than Markdown,
   * hidden directories, and `node_modules` are skipped.
   *
   * @param event - Folder input change event.
   */
  const handleFolderChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])]
    folderGenerationRef.current += 1
    const generation = folderGenerationRef.current
    setFolder(undefined)
    setFolderError(undefined)
    setIsReadingFolder(false)
    if (chosen.length === 0) return
    const markdown = chosen
      .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
      .filter(({ path }) => isImportableMarkdownPath(path))
    const name = (chosen[0]?.webkitRelativePath || '').split('/')[0] ?? ''
    if (markdown.length === 0) {
      setFolderError(describeFolderFailure({ code: 'no-markdown-files' }, t))
      return
    }
    if (markdown.length > MARKDOWN_FOLDER_IMPORT_MAX_FILES) {
      setFolderError(describeFolderFailure({ code: 'too-many-files' }, t))
      return
    }
    const oversized = markdown.find(({ file }) => file.size > MARKDOWN_IMPORT_MAX_BYTES)
    if (oversized) {
      setFolderError(describeFolderFailure({ code: 'too-large', path: oversized.path }, t))
      return
    }
    setIsReadingFolder(true)
    const files: MarkdownFolderFile[] = []
    try {
      for (const { file, path } of markdown) {
        let source: string
        try {
          source = await file.text()
        } catch {
          if (generation === folderGenerationRef.current) {
            setFolderError(describeFolderFailure({ code: 'unreadable', path }, t))
          }
          return
        }
        if (generation !== folderGenerationRef.current) return
        files.push({ path, source })
      }
      setFolder({ files, name: name || (files[0]?.path ?? '') })
    } finally {
      if (generation === folderGenerationRef.current) setIsReadingFolder(false)
    }
  }

  /**
   * Imports the chosen folder and clears it once the pages are created.
   */
  const handleFolderImport = async () => {
    if (!folder || !onImportFolder) return
    setFolderError(undefined)
    const failure = await onImportFolder({
      files: folder.files,
      ...(projectId ? { projectId } : {}),
    })
    if (failure) setFolderError(describeFolderFailure(failure, t))
  }

  /**
   * Forgets the chosen folder.
   */
  const handleFolderClear = () => {
    folderGenerationRef.current += 1
    setIsReadingFolder(false)
    setFolder(undefined)
    setFolderError(undefined)
    setFolderInputKey((key) => key + 1)
  }

  /**
   * Abandons a file read still in progress so its result cannot replace
   * newer text.
   */
  const cancelFileRead = () => {
    readGenerationRef.current += 1
    setIsReadingFile(false)
  }

  /**
   * Reads the chosen file into the text area so it can be checked before import.
   *
   * @param event - File input change event.
   */
  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    cancelFileRead()
    const generation = readGenerationRef.current
    setErrorCode(undefined)
    setSource('')
    setFileTitle('')
    if (file.size > MARKDOWN_IMPORT_MAX_BYTES) {
      setErrorCode('too-large')
      return
    }
    setIsReadingFile(true)
    try {
      const text = await file.text()
      if (generation !== readGenerationRef.current) return
      setSource(text)
      setFileTitle(titleFromMarkdownFileName(file.name))
    } catch {
      if (generation === readGenerationRef.current) setErrorCode('unreadable')
    } finally {
      if (generation === readGenerationRef.current) setIsReadingFile(false)
    }
  }

  /**
   * Sends the Markdown and clears the form once the page is created.
   */
  const handleImport = async () => {
    setErrorCode(undefined)
    const code = await onImport({
      fallbackTitle: fileTitle || t('documents.import.defaultTitle'),
      source,
      ...(projectId ? { projectId } : {}),
    })
    if (code) setErrorCode(code)
  }

  /**
   * Clears the pasted text and the chosen file.
   */
  const handleClear = () => {
    cancelFileRead()
    setSource('')
    setFileTitle('')
    setErrorCode(undefined)
    setFileInputKey((key) => key + 1)
  }

  return (
    <section aria-labelledby={`${fieldId}-title`}>
      <div className="mb-4">
        <h2
          className="m-0 text-base font-semibold text-[var(--workbench-text)]"
          id={`${fieldId}-title`}
        >
          {t('documents.import.title')}
        </h2>
        <p className="m-0 mt-1 text-xs font-medium text-[var(--workbench-muted)]">
          {t('documents.import.description')}
        </p>
      </div>
      <div className="workbench-panel grid gap-3 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('documents.import.project')}
            <select
              className="workbench-input min-h-10 px-3"
              onChange={(event) => setProjectId(event.target.value)}
              value={projectId}
            >
              <option value="">{t('documents.home.builtInTemplateNoProject')}</option>
              {projects.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('documents.import.file')}
            <input
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              className="workbench-input min-h-10 px-3 py-2"
              key={fileInputKey}
              onChange={(event) => {
                void handleFileChange(event)
              }}
              type="file"
            />
          </label>
        </div>
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('documents.import.source')}
          <textarea
            className="workbench-input min-h-40 px-3 py-2 font-mono text-sm"
            onChange={(event) => {
              cancelFileRead()
              setSource(event.target.value)
              setErrorCode(undefined)
            }}
            placeholder={t('documents.import.sourcePlaceholder')}
            value={source}
          />
        </label>
        {errorCode ? (
          <p className="m-0 text-xs font-semibold text-fg-red-700" role="alert">
            {t(`documents.import.error.${errorCode}`)}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            className="workbench-button-secondary min-h-10 px-4"
            disabled={isImporting || (!source && !fileTitle && !isReadingFile)}
            onClick={handleClear}
            type="button"
          >
            {t('documents.import.clear')}
          </button>
          <button
            className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isImporting || isReadingFile || source.trim() === ''}
            onClick={() => {
              void handleImport()
            }}
            type="button"
          >
            {isImporting
              ? t('documents.import.submitting')
              : t('documents.import.submit')}
          </button>
        </div>
        {onImportFolder ? (
          <div className="grid gap-3 border-t border-[var(--workbench-border)] pt-3">
            <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('documents.import.folder')}
              <input
                className="workbench-input min-h-10 px-3 py-2"
                key={folderInputKey}
                multiple
                onChange={(event) => {
                  void handleFolderChange(event)
                }}
                ref={(element) => {
                  element?.setAttribute('webkitdirectory', '')
                }}
                type="file"
              />
            </label>
            <p className="m-0 text-xs font-medium text-[var(--workbench-muted)]">
              {t('documents.import.folderHint').replace(
                '{max}',
                String(MARKDOWN_FOLDER_IMPORT_MAX_FILES),
              )}
            </p>
            {folder ? (
              <p className="m-0 text-sm font-medium text-[var(--workbench-text)]">
                {t('documents.import.folderSummary')
                  .replace('{name}', folder.name)
                  .replace('{count}', String(folder.files.length))}
              </p>
            ) : null}
            {folderError ? (
              <p className="m-0 text-xs font-semibold text-fg-red-700" role="alert">
                {folderError}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                className="workbench-button-secondary min-h-10 px-4"
                disabled={isImporting || (!folder && !folderError && !isReadingFolder)}
                onClick={handleFolderClear}
                type="button"
              >
                {t('documents.import.folderClear')}
              </button>
              <button
                className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isImporting || isReadingFolder || !folder}
                onClick={() => {
                  void handleFolderImport()
                }}
                type="button"
              >
                {isImporting
                  ? t('documents.import.submitting')
                  : t('documents.import.folderSubmit')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
