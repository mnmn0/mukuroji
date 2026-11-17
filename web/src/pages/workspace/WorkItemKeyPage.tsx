import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { getWorkItemByKey, TeamIssuesApiError } from '../../issues/api'
import { readWorkItemKeyInput } from '../../issues/model/workItemKeys'
import { createTranslator } from '../../shared/i18n/i18n'
import { createTeamIssuesPath } from '../../shared/routing/paths'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/** What the page shows while it resolves a key, or why it could not. */
type KeyLookupState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'failed'; error: unknown }

/**
 * Opens the Work Item named by a key URL such as `/browse/PT-12`.
 * The key never changes, so the URL keeps working after the Work Item moves to another Project.
 *
 * @returns A short status page that redirects to the Work Item when the key resolves.
 */
export function WorkItemKeyPage() {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const { workItemKey: rawKey = '' } = useParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const key = readWorkItemKeyInput(rawKey)
  const { accessToken, canLoadWorkspaceData } = workspace
  const [lookup, setLookup] = useState<{ key: string; state: KeyLookupState }>()
  const state: KeyLookupState = lookup?.key === key && lookup ? lookup.state : { kind: 'loading' }

  useEffect(() => {
    if (!key || !canLoadWorkspaceData) return
    let cancelled = false
    getWorkItemByKey(key, accessToken)
      .then((location) => {
        if (!cancelled) navigate(createTeamIssuesPath(location.teamId, location.workItemId), { replace: true })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLookup({
          key,
          state: error instanceof TeamIssuesApiError && error.status === 404
            ? { kind: 'not-found' }
            : { kind: 'failed', error },
        })
      })
    return () => {
      cancelled = true
    }
  }, [accessToken, canLoadWorkspaceData, key, navigate])

  const shownKey = key ?? rawKey
  const message = !key
    ? t('issues.keyPage.invalid')
    : state.kind === 'not-found'
      ? t('issues.keyPage.notFound')
      : state.kind === 'failed'
        ? t('issues.keyPage.error')
        : t('issues.keyPage.loading')

  return (
    <WorkspaceRouteContent
      isLoading={false}
      sessionErrors={state.kind === 'failed' ? [state.error] : []}
    >
      <section
        className="mx-auto grid w-full max-w-xl gap-3 px-5 py-10"
        data-testid="work-item-key-page"
      >
        <p className="workbench-eyebrow">{t('issues.keyPage.title')}</p>
        <p
          aria-live="polite"
          className="text-base font-semibold text-[var(--workbench-text)]"
          role={key && state.kind === 'loading' ? 'status' : 'alert'}
        >
          {message.replace('{key}', shownKey)}
        </p>
        {!key || state.kind !== 'loading' ? (
          <Link
            className="workbench-button-secondary min-h-9 w-fit px-3"
            to={`/search?${new URLSearchParams({ q: shownKey, type: 'work-item' }).toString()}`}
          >
            {t('issues.keyPage.openSearch')}
          </Link>
        ) : null}
      </section>
    </WorkspaceRouteContent>
  )
}
