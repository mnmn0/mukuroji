import { useMemo } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { TeamIssuesApiError } from '../../issues/api'
import { readWorkItemKeyInput } from '../../issues/model/workItemKeys'
import { useWorkItemKeyLocation } from '../../issues/queries/useWorkItemKeyLocation'
import { createTranslator } from '../../shared/i18n/i18n'
import { createTeamIssuesPath } from '../../shared/routing/paths'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Opens the Work Item named by a key URL such as `/browse/PT-12`.
 * The key never changes, so the URL keeps working after the Work Item moves to another Project.
 *
 * @returns A short status page that redirects to the Work Item when the key resolves.
 */
export function WorkItemKeyPage() {
  const workspace = useWorkspaceRouteContext()
  const { workItemKey: rawKey = '' } = useParams()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const key = readWorkItemKeyInput(rawKey)
  const lookup = useWorkItemKeyLocation(workspace.accessToken, key, workspace.canLoadWorkspaceData)

  if (lookup.data) {
    return <Navigate replace to={createTeamIssuesPath(lookup.data.teamId, lookup.data.workItemId)} />
  }

  const notFound = lookup.error instanceof TeamIssuesApiError && lookup.error.status === 404
  const failed = Boolean(lookup.error) && !notFound
  const loading = Boolean(key) && !lookup.error
  const shownKey = key ?? rawKey
  const message = !key
    ? t('issues.keyPage.invalid')
    : notFound
      ? t('issues.keyPage.notFound')
      : failed
        ? t('issues.keyPage.error')
        : t('issues.keyPage.loading')

  return (
    <WorkspaceRouteContent
      isLoading={false}
      sessionErrors={failed ? [lookup.error] : []}
    >
      <section
        className="mx-auto grid w-full max-w-xl gap-3 px-5 py-10"
        data-testid="work-item-key-page"
      >
        <p className="workbench-eyebrow">{t('issues.keyPage.title')}</p>
        <p
          aria-live="polite"
          className="text-base font-semibold text-[var(--workbench-text)]"
          role={loading ? 'status' : 'alert'}
        >
          {message.replace('{key}', shownKey)}
        </p>
        {loading ? null : (
          <div className="flex flex-wrap gap-2">
            {failed ? (
              <button
                className="workbench-button-primary min-h-9 px-3"
                disabled={lookup.isValidating}
                onClick={() => void lookup.mutate()}
                type="button"
              >
                {t('issues.keyPage.retry')}
              </button>
            ) : null}
            <Link
              className="workbench-button-secondary min-h-9 w-fit px-3"
              to={`/search?${new URLSearchParams({ q: shownKey, type: 'work-item' }).toString()}`}
            >
              {t('issues.keyPage.openSearch')}
            </Link>
          </div>
        )}
      </section>
    </WorkspaceRouteContent>
  )
}
