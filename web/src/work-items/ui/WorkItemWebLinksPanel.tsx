import { parseWorkItemWebLinkTitle, parseWorkItemWebLinkUrl, type PublicWorkItemWebLink } from '@mukuroji/contracts'
import { useMemo, useState, type FormEvent } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { WorkItemConfigurationApiError } from '../api/errors'
import { createWorkItemWebLink, deleteWorkItemWebLink } from '../api/webLinks'
import { useWorkItemWebLinks } from '../queries/useWorkItemWebLinks'

/** Translator of the Work Item messages. */
type Translate = ReturnType<typeof createTranslator>

/** Props of the pure web link panel. */
export type WorkItemWebLinksPanelProps = {
  /** Links of the Work Item, oldest first. */
  links: readonly PublicWorkItemWebLink[]
  /** Whether the person may add and remove links. */
  canManage: boolean
  /** Translator of the displayed text. */
  t: Translate
  /** Whether the first read is still running. */
  isLoading?: boolean
  /** Whether the first read failed. */
  hasLoadError?: boolean
  /** Reads the links again. */
  onRetry?: () => void
  /** Adds a link. */
  onAdd?: (input: { url: string, title?: string }) => Promise<void>
  /** Removes a link. */
  onRemove?: (link: PublicWorkItemWebLink) => Promise<void>
}

/** Props of the web link panel bound to the Web API. */
export type WorkItemWebLinksPanelContainerProps = {
  /** Access token of the person. */
  accessToken: string
  /** Whether the person may add and remove links. */
  canManage: boolean
  /** Display locale. */
  locale: Locale
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item whose links are shown. */
  workItemId: string
}

/**
 * Shows the web links of a Work Item and adds or removes them through the Web API.
 *
 * @param props - Container props.
 * @returns The panel.
 */
export function WorkItemWebLinksPanelContainer({ accessToken, canManage, locale, teamId, workItemId }: WorkItemWebLinksPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const runner = useMemo(() => createMutationRequestRunner(), [])
  const { data, error, isLoading, mutate } = useWorkItemWebLinks(accessToken, teamId, workItemId)
  return (
    <WorkItemWebLinksPanel
      canManage={canManage}
      hasLoadError={data === undefined && error !== undefined}
      isLoading={isLoading}
      links={data ?? []}
      onAdd={canManage ? async (input) => {
        await runner.run(`web-link:create:${teamId}:${workItemId}`, JSON.stringify(input), (context) =>
          createWorkItemWebLink(accessToken, teamId, workItemId, input, context))
        await mutate()
      } : undefined}
      onRemove={canManage ? async (link) => {
        await runner.run(`web-link:delete:${teamId}:${workItemId}:${link.id}`, link.id, (context) =>
          deleteWorkItemWebLink(accessToken, teamId, workItemId, link.id, context))
        await mutate()
      } : undefined}
      onRetry={() => void mutate()}
      t={t}
    />
  )
}

/**
 * Picks the message for a failed link change.
 *
 * @param error - Raised error.
 * @param t - Translator.
 * @returns The message.
 */
function describeWebLinkError(error: unknown, t: Translate) {
  if (error instanceof WorkItemConfigurationApiError) {
    if (error.code === 'WorkItemWebLinkDuplicate') return t('workItems.webLinks.duplicate')
    if (error.code === 'WorkItemWebLinkLimitExceeded') return t('workItems.webLinks.limit')
    if (error.code === 'InvalidWorkItemWebLink') return t('workItems.webLinks.invalidUrl')
  }
  return t('workItems.webLinks.operationError')
}

/**
 * Lists the web links of a Work Item with a form to add one and a button to remove each.
 *
 * @param props - View props.
 * @returns The panel.
 */
export function WorkItemWebLinksPanel({ canManage, hasLoadError, isLoading, links, onAdd, onRemove, onRetry, t }: WorkItemWebLinksPanelProps) {
  const [isAdding, setIsAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()

  /**
   * Runs one change and shows its failure.
   *
   * @param action - Change to run.
   * @returns Whether it succeeded.
   */
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setErrorMessage(undefined)
    try {
      await action()
      return true
    } catch (error) {
      setErrorMessage(describeWebLinkError(error, t))
      return false
    } finally {
      setBusy(false)
    }
  }

  /**
   * Validates and submits the add form.
   *
   * @param event - Form submit event.
   */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedUrl = parseWorkItemWebLinkUrl(url)
    const normalizedTitle = parseWorkItemWebLinkTitle(title)
    if (!onAdd || normalizedUrl === undefined || normalizedTitle === undefined) {
      setErrorMessage(t('workItems.webLinks.invalidUrl'))
      return
    }
    const succeeded = await run(() => onAdd({ url: normalizedUrl, ...(normalizedTitle === null ? {} : { title: normalizedTitle }) }))
    if (succeeded) {
      setUrl('')
      setTitle('')
      setIsAdding(false)
    }
  }

  return (
    <section className="border-t border-[var(--workbench-border)] bg-surface px-6 py-6" data-testid="work-item-web-links-panel">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="workbench-eyebrow text-[var(--workbench-muted)]">{t('workItems.webLinks.title')}</h2>
            {!canManage ? <span className="workbench-badge">{t('workItems.webLinks.readOnly')}</span> : null}
          </div>
          <p className="mt-2 text-sm font-medium leading-5 text-[var(--workbench-muted)]">{t('workItems.webLinks.description')}</p>
        </div>
        {canManage && onAdd ? (
          <button
            aria-expanded={isAdding}
            className="workbench-button-secondary min-h-9 px-3"
            onClick={() => {
              setErrorMessage(undefined)
              setIsAdding((current) => !current)
            }}
            type="button"
          >
            {t('workItems.webLinks.add')}
          </button>
        ) : null}
      </div>

      {errorMessage ? (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {isAdding && canManage && onAdd ? (
        <form className="mt-4 grid gap-3 rounded-lg border border-[var(--workbench-border)] p-4" onSubmit={(event) => void handleSubmit(event)}>
          <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            <span>{t('workItems.webLinks.url')}</span>
            <input
              className="workbench-input h-9 px-3"
              maxLength={2048}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('workItems.webLinks.urlPlaceholder')}
              required
              type="url"
              value={url}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            <span>{t('workItems.webLinks.linkTitle')}</span>
            <input className="workbench-input h-9 px-3" maxLength={256} onChange={(event) => setTitle(event.target.value)} value={title} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="workbench-button-primary min-h-9 px-3" disabled={busy} type="submit">{t('workItems.webLinks.save')}</button>
            <button className="workbench-button-secondary min-h-9 px-3" disabled={busy} onClick={() => setIsAdding(false)} type="button">
              {t('workItems.webLinks.cancel')}
            </button>
          </div>
        </form>
      ) : null}

      {isLoading ? (
        <p className="mt-4 text-sm text-[var(--workbench-muted)]" role="status">{t('workItems.webLinks.loading')}</p>
      ) : hasLoadError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-[var(--workbench-muted)]" role="alert">
          <span>{t('workItems.webLinks.loadError')}</span>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-9 px-3" onClick={onRetry} type="button">{t('workItems.webLinks.retry')}</button>
          ) : null}
        </div>
      ) : links.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--workbench-muted)]">{t('workItems.webLinks.empty')}</p>
      ) : (
        <ul className="mt-4 grid gap-2">
          {links.map((link) => {
            const label = link.title ?? link.url
            return (
              <li className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-[var(--workbench-border)] px-3 py-2" key={link.id}>
                <div className="min-w-0">
                  <a
                    className="block truncate text-sm font-semibold text-[var(--workbench-primary-text)] underline-offset-2 hover:underline"
                    href={link.url}
                    referrerPolicy="no-referrer"
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                  >
                    {label}
                  </a>
                  {link.title ? <p className="truncate text-xs text-[var(--workbench-muted)]">{link.url}</p> : null}
                </div>
                {canManage && onRemove ? (
                  <button
                    aria-label={t('workItems.webLinks.removeLabel').replace('{title}', label)}
                    className="workbench-button-secondary min-h-8 shrink-0 px-2 text-xs"
                    disabled={busy}
                    onClick={() => void run(() => onRemove(link))}
                    type="button"
                  >
                    {t('workItems.webLinks.remove')}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
