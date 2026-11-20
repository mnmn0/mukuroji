import { useId, useState, type ChangeEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  MARKDOWN_IMPORT_MAX_BYTES,
  titleFromMarkdownFileName,
  type MarkdownImportErrorCode,
} from '../model/markdownImport'
import type { MarkdownDocumentImportRequest } from '../mutations/useMarkdownDocumentImport'

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
  const fieldId = useId()

  /**
   * Reads the chosen file into the text area so it can be checked before import.
   *
   * @param event - File input change event.
   */
  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setErrorCode(undefined)
    if (file.size > MARKDOWN_IMPORT_MAX_BYTES) {
      setErrorCode('too-large')
      return
    }
    try {
      setSource(await file.text())
      setFileTitle(titleFromMarkdownFileName(file.name))
    } catch {
      setErrorCode('unreadable')
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
            disabled={isImporting || (!source && !fileTitle)}
            onClick={handleClear}
            type="button"
          >
            {t('documents.import.clear')}
          </button>
          <button
            className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isImporting || source.trim() === ''}
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
      </div>
    </section>
  )
}
