import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  clearAuthSession,
  getAuthSession,
} from '../../auth/session'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'
import {
  MobileSidebarButton,
  useWorkspaceSidebarController,
} from '../../shared/ui/sidebar'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../../shared/i18n/i18n'
import { workspaceNavPaths } from '../../shared/routing/paths'

/**
 * Goal から関連 Documents へ戻る軽量 context page です。
 */
export function GoalDocumentsPage() {
  const navigate = useNavigate()
  const { goalId } = useParams()
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() =>
    getInitialLocale(),
  )
  const t = useMemo(
    () => createTranslator(locale),
    [locale],
  )
  const { openMobileSidebar } = useWorkspaceSidebarController()

  useEffect(() => {
    if (!session) {
      clearAuthSession()
      navigate('/', { replace: true })
    }
  }, [navigate, session])

  return (
    <>
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-[var(--workbench-border)] bg-white px-5">
        <div className="flex min-w-0 items-center gap-3">
          <MobileSidebarButton
            label={t('sidebar.mobileOpen')}
            onClick={openMobileSidebar}
          />
          <div className="min-w-0">
            <p className="workbench-eyebrow">
              {t('documents.backlinks.goal')}
            </p>
            <h1 className="truncate text-lg font-semibold text-[var(--workbench-text)]">
              {goalId}
            </h1>
          </div>
        </div>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          onClick={() => navigate(workspaceNavPaths.documents)}
          type="button"
        >
          {t('documents.related.openDocuments')}
        </button>
      </header>
      <div className="mx-auto w-full max-w-3xl py-8">
        <section className="workbench-panel overflow-hidden">
          <RelatedDocuments
            accessToken={session?.accessToken}
            t={t}
            targetId={goalId}
            targetKind="goal"
          />
        </section>
      </div>
    </>
  )
}
