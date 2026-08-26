import type {
  RequestForm,
  RequestSubmissionActionInput,
} from '@mukuroji/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { aiAssistanceUiEnabled } from '../features/ai-assistance/model/aiAssistanceRollout'
import { createMutationRequestRunner } from '../shared/api/mutationHeaders'
import {
  canManageWorkspaceStructure,
} from '../auth/api'
import { useCurrentUser } from '../auth/queries/useCurrentUser'
import { resolveEnterpriseSessionErrorsAction } from '../auth/enterpriseSessionErrors'
import { clearAuthSession, getAuthSession } from '../auth/session'
import {
  MobileSidebarButton,
  useWorkspaceSidebarController,
} from '../shared/ui/sidebar'
import {
  createTranslator,
  getInitialLocale,
  type Locale,
} from '../shared/i18n/i18n'
import {
  type ProjectDirectoryTeam,
} from '../projects/api'
import { useProjectDirectory } from '../projects/queries/useProjectDirectory'
import {
  type RequestsView,
} from '../shared/routing/paths'
import {
  useWorkItemConfiguration,
} from '../work-items/queries/useWorkItemConfigurations'
import {
  applyRequestSubmissionAction,
  createRequestAttachmentAccess,
  createRequestForm,
  publishRequestForm,
  updateRequestForm,
} from './api'
import {
  useRequestForm,
  useRequestForms,
  useRequestQueue,
  useRequestSubmission,
} from './queries/useRequestIntakeQueries'
import { getRequestFormEditorInstanceKey } from './model/editorState'
import { RequestFormBuilder } from './ui/RequestFormBuilder'
import {
  createEmptyRequestFormDraft,
  createRequestFormInput,
  normalizeRequestForm,
  normalizeRequestSubmission,
  persistAndPublishRequestForm,
  updateRequestFormInput,
  type RequestFormDraftModel,
} from './model/requestForm'
import { RequestQueue } from './ui/RequestQueue'
import { useOptionalWorkspaceRouteContext } from '../workspace/ui/WorkspaceRouteProvider'

const emptyTeams: ProjectDirectoryTeam[] = []
const emptyForms: RequestForm[] = []
const apiSWRConfig = {
  dedupingInterval: 5_000,
  shouldRetryOnError: false,
} as const

/**
 * Request intake queue と form builder を認証済み Workspace shell 内に描画します。
 */
export function RequestIntakePage() {
  const workspaceContext = useOptionalWorkspaceRouteContext()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const [session] = useState(() => getAuthSession())
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [actionErrorMessage, setActionErrorMessage] = useState<string>()
  const [authenticatedApiError, setAuthenticatedApiError] = useState<unknown>()
  const handleAuthenticatedApiError = useCallback((error: unknown) => {
    setAuthenticatedApiError(() => error)
  }, [])
  const t = useMemo(() => createTranslator(locale), [locale])
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const accessToken = session?.accessToken
  const requestedView = searchParams.get('view') === 'forms' ? 'forms' : 'queue'
  const {
    data: user,
    error: currentUserError,
    isLoading: isCurrentUserLoading,
  } = useCurrentUser(accessToken)
  const {
    data: teams = emptyTeams,
    error: projectDirectoryError,
    isLoading: isProjectDirectoryLoading,
  } = useProjectDirectory({
    accessToken,
    dedupingInterval: apiSWRConfig.dedupingInterval,
    enabled: Boolean(user && !currentUserError),
    locale,
  })
  const canManageForms = canManageWorkspaceStructure(user)
  // Request-level conversion capability is the source-of-truth gate for this assistant.
  // Policy-management permission must not hide it from operators who can convert a request.
  const canUseAiAssistance = Boolean(
    (workspaceContext?.isAiAssistanceTaskEnabled?.('triage') ?? aiAssistanceUiEnabled) &&
      accessToken && user && !currentUserError,
  )
  const activeView: RequestsView = requestedView === 'forms' && canManageForms
    ? 'forms'
    : 'queue'
  const {
    data: queuePages,
    error: queueError,
    isLoading: isQueueLoading,
    mutate: mutateQueue,
    setSize: setQueuePageCount,
    size: queuePageCount,
  } = useRequestQueue(
    accessToken,
    Boolean(user && !currentUserError && activeView === 'queue'),
  )
  const {
    data: forms = emptyForms,
    error: formsError,
    isLoading: isFormsLoading,
    mutate: mutateForms,
  } = useRequestForms(
    accessToken,
    Boolean(user && !currentUserError && activeView === 'forms'),
  )
  const submissions = useMemo(
    () => {
      const normalized = (queuePages ?? []).flatMap((page) =>
        page.submissions.map(normalizeRequestSubmission)
      )
      return Array.from(new Map(normalized.map((submission) => [submission.id, submission])).values())
    },
    [queuePages],
  )
  const nextQueueCursor = queuePages?.at(-1)?.nextCursor
  const isLoadingMore = isQueueLoading || (
    queuePageCount > 0 && Boolean(queuePages) && queuePages?.[queuePageCount - 1] === undefined
  )
  const selectedSubmissionId = searchParams.get('submissionId') ?? submissions[0]?.id
  const {
    data: selectedSubmission,
    error: detailError,
    mutate: mutateSelectedSubmission,
  } = useRequestSubmission(
    accessToken,
    selectedSubmissionId,
    activeView === 'queue',
  )
  const selectedFormId = searchParams.get('formId') ?? forms[0]?.id
  const {
    data: selectedForm,
    error: selectedFormError,
    mutate: mutateSelectedForm,
  } = useRequestForm(
    accessToken,
    selectedFormId,
    activeView === 'forms',
  )
  const userLabel = user?.attributes.email ?? user?.attributes.name ?? user?.username ?? t('workspace.user.fallback')
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || 'M'
  const currentUserErrorAction = resolveEnterpriseSessionErrorsAction(
    currentUserError,
    [
      projectDirectoryError,
      queueError,
      formsError,
      detailError,
      selectedFormError,
      authenticatedApiError,
    ],
    `${location.pathname}${location.search}${location.hash}`,
  )
  const isLoading =
    !session ||
    isCurrentUserLoading ||
    Boolean(user && isProjectDirectoryLoading) ||
    Boolean(currentUserError && currentUserErrorAction?.kind !== 'stay')

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = `${t('requests.title')} | ${t('app.title')}`
  }, [locale, t])

  useEffect(() => {
    if (!session) navigate('/', { replace: true })
  }, [navigate, session])

  useEffect(() => {
    if (currentUserErrorAction?.redirectTo) {
      if (currentUserErrorAction.clearSession) {
        clearAuthSession()
      }
      navigate(currentUserErrorAction.redirectTo, { replace: true })
    }
  }, [
    currentUserErrorAction?.clearSession,
    currentUserErrorAction?.redirectTo,
    navigate,
  ])

  const selectView = (view: RequestsView) => {
    setSearchParams(view === 'forms' ? { view: 'forms' } : {}, { replace: true })
  }
  const selectSubmission = (submissionId: string) =>
    setSearchParams({ submissionId }, { replace: true })
  const selectForm = (formId: string) =>
    setSearchParams({ formId, view: 'forms' }, { replace: true })

  const handleAction = async (
    submissionId: string,
    input: RequestSubmissionActionInput,
  ) => {
    if (!accessToken) return

    setActionErrorMessage(undefined)
    setAuthenticatedApiError(undefined)
    try {
      const updated = await mutationRunner.run(
        `request-submission:${submissionId}:${input.action}`,
        JSON.stringify(input),
        (context) => applyRequestSubmissionAction(
          submissionId,
          input,
          accessToken,
          context,
        ),
      )
      await mutateSelectedSubmission(updated, { revalidate: false })
      await mutateQueue()
    } catch (error) {
      setAuthenticatedApiError(() => error)
      setActionErrorMessage(error instanceof Error ? error.message : t('requests.action.error'))
      throw error
    }
  }

  const handleOpenAttachment = async (submissionId: string, attachmentId: string) => {
    if (!accessToken) return

    setAuthenticatedApiError(undefined)
    try {
      const access = await mutationRunner.run(
        `request-attachment-access:${submissionId}:${attachmentId}`,
        `${submissionId}:${attachmentId}`,
        (context) => createRequestAttachmentAccess(
          submissionId,
          attachmentId,
          accessToken,
          context,
        ),
      )
      openDownloadUrl(access.url)
    } catch (error) {
      setAuthenticatedApiError(() => error)
      throw error
    }
  }

  return (
    <>
        <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton label={t('sidebar.mobileOpen')} onClick={openMobileSidebar} />
              <div className="min-w-0">
                <p className="workbench-eyebrow">{t('requests.eyebrow')}</p>
                <h1 className="workbench-title mt-2 text-page-title">{t('requests.title')}</h1>
                <p className="workbench-description mt-2 max-w-[760px]">{t('requests.description')}</p>
              </div>
            </div>
            <div className="flex flex-none items-center gap-3">
              <div className="hidden text-right min-[721px]:block">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{t('workspace.user.label')}</p>
                <p className="mt-1 max-w-[220px] truncate text-sm font-semibold text-[var(--workbench-text)]">{userLabel}</p>
              </div>
              <div className="grid h-10 w-10 place-items-center rounded-full border border-[#99d7cf] bg-[#e5f7f4] text-sm font-semibold text-[var(--workbench-primary)]">{userInitial}</div>
              <button className="workbench-button-secondary min-h-10 px-4" onClick={() => {
                clearAuthSession()
                navigate('/', { replace: true })
              }} type="button">{t('dashboard.logout')}</button>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center text-sm font-semibold text-[var(--workbench-muted)]">{t('requests.loading')}</div>
        ) : currentUserErrorAction?.kind === 'stay' ? (
          <div className="min-h-0 flex-1 px-[clamp(20px,3vw,34px)] py-5">
            <p
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
              role="alert"
            >
              {t('requests.loadError')}
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 px-[clamp(20px,3vw,34px)] py-5">
            <div className="mb-5 flex flex-wrap gap-2 border-b border-[var(--workbench-border)] pb-3" role="tablist">
              <TabButton active={activeView === 'queue'} label={t('requests.tab.queue')} onClick={() => selectView('queue')} />
              {canManageForms ? <TabButton active={activeView === 'forms'} label={t('requests.tab.forms')} onClick={() => selectView('forms')} /> : null}
            </div>

            {activeView === 'queue' ? (
              <RequestQueue
                accessToken={accessToken}
                canUseAiAssistance={canUseAiAssistance}
                errorMessage={actionErrorMessage ?? (queueError instanceof Error ? queueError.message : detailError instanceof Error ? detailError.message : undefined)}
                isLoading={isQueueLoading}
                hasMore={Boolean(nextQueueCursor)}
                isLoadingMore={isLoadingMore}
                locale={locale}
                onAuthenticatedApiError={handleAuthenticatedApiError}
                selectedSubmission={selectedSubmission
                  ? normalizeRequestSubmission(selectedSubmission)
                  : submissions.find((submission) => submission.id === selectedSubmissionId)}
                submissions={submissions}
                onAction={handleAction}
                onLoadMore={() => void setQueuePageCount(queuePageCount + 1)}
                onOpenAttachment={handleOpenAttachment}
                onSelectSubmission={selectSubmission}
              />
            ) : (
              <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-5 max-[920px]:grid-cols-1">
                <section className="workbench-panel h-fit overflow-hidden">
                  <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
                    <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{t('requests.forms.title')}</h2>
                    <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">{t('requests.forms.description')}</p>
                    <button className="workbench-button-primary mt-4 min-h-10 w-full px-4" onClick={() => selectForm('new')} type="button">+ {t('requests.forms.new')}</button>
                  </div>
                  <div className="grid divide-y divide-[var(--workbench-border)]">
                    {isFormsLoading ? <p className="p-4 text-sm text-[var(--workbench-muted)]">{t('requests.loading')}</p> : null}
                    {forms.map((form) => (
                      <button
                        aria-pressed={selectedFormId === form.id}
                        className={`px-4 py-3 text-left ${selectedFormId === form.id ? 'bg-teal-50' : 'hover:bg-[var(--workbench-surface-muted)]'}`}
                        key={form.id}
                        onClick={() => selectForm(form.id)}
                        type="button"
                      >
                        <strong className="block truncate text-sm text-[var(--workbench-text)]">{form.name}</strong>
                        <span className="mt-1 block text-xs font-semibold uppercase text-[var(--workbench-muted)]">{t(`requests.formStatus.${form.status}`)} · v{form.currentPublishedVersion ?? 0}</span>
                      </button>
                    ))}
                  </div>
                  {formsError instanceof Error ? <p className="m-3 text-sm font-semibold text-red-700" role="alert">{formsError.message}</p> : null}
                </section>

                {selectedFormId === 'new' || selectedForm ? (
                  <RequestFormEditorContainer
                    accessToken={accessToken ?? ''}
                    initialForm={selectedFormId === 'new' ? undefined : selectedForm}
                    key={getRequestFormEditorInstanceKey(
                      selectedFormId === 'new' ? undefined : selectedForm,
                    )}
                    locale={locale}
                    onAuthenticatedApiError={handleAuthenticatedApiError}
                    teams={teams}
                    onCreated={(form) => {
                      void mutateForms()
                      selectForm(form.id)
                    }}
                    onUpdated={(form) => {
                      void mutateForms()
                      void mutateSelectedForm(form, { revalidate: false })
                    }}
                  />
                ) : (
                  <div className="workbench-panel grid min-h-64 place-items-center p-8 text-sm font-semibold text-[var(--workbench-muted)]">
                    {selectedFormError instanceof Error ? selectedFormError.message : t('requests.forms.empty')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
    </>
  )
}

function RequestFormEditorContainer({
  accessToken,
  initialForm,
  locale,
  onAuthenticatedApiError,
  onCreated,
  onUpdated,
  teams,
}: {
  accessToken: string
  initialForm?: RequestForm
  locale: Locale
  onAuthenticatedApiError: (error: unknown) => void
  onCreated: (form: RequestForm) => void
  onUpdated: (form: RequestForm) => void
  teams: ProjectDirectoryTeam[]
}) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const [model, setModel] = useState<RequestFormDraftModel>(() =>
    initialForm ? normalizeRequestForm(initialForm) : createEmptyRequestFormDraft(),
  )
  const [isSaving, setIsSaving] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()
  const canEdit = initialForm?.capabilities.canEdit ?? true
  const canPublish = initialForm?.capabilities.canPublish ?? false
  const { data: resolvedConfiguration, error: configurationError } = useWorkItemConfiguration(
    accessToken,
    model.routing.teamId,
  )

  useEffect(() => {
    if (configurationError) {
      onAuthenticatedApiError(configurationError)
    }
  }, [configurationError, onAuthenticatedApiError])

  const save = async () => {
    setIsSaving(true)
    setErrorMessage(undefined)
    try {
      if (initialForm) {
        const updated = await mutationRunner.run(
          `request-form:update:${initialForm.id}`,
          JSON.stringify(updateRequestFormInput(model)),
          (context) => updateRequestForm(
            initialForm.id,
            updateRequestFormInput(model),
            accessToken,
            context,
          ),
        )
        setModel(normalizeRequestForm(updated))
        onUpdated(updated)
      } else {
        const created = await mutationRunner.run(
          'request-form:create',
          JSON.stringify(createRequestFormInput(model)),
          (context) => createRequestForm(
            createRequestFormInput(model),
            accessToken,
            context,
          ),
        )
        setModel(normalizeRequestForm(created))
        onCreated(created)
      }
    } catch (error) {
      onAuthenticatedApiError(error)
      setErrorMessage(error instanceof Error ? error.message : t('requests.builder.saveError'))
      throw error
    } finally {
      setIsSaving(false)
    }
  }

  const publish = async () => {
    if (!initialForm && !model.id) return
    const formId = initialForm?.id ?? model.id
    setIsPublishing(true)
    setErrorMessage(undefined)
    try {
      const published = await persistAndPublishRequestForm(
        model,
        canEdit,
        (input) => mutationRunner.run(
          `request-form:update:${formId}`,
          JSON.stringify(input),
          (context) => updateRequestForm(formId, input, accessToken, context),
        ),
        (expectedRevision) => mutationRunner.run(
          `request-form:publish:${formId}`,
          String(expectedRevision),
          (context) => publishRequestForm(
            formId,
            { expectedRevision },
            accessToken,
            context,
          ),
        ),
        (persisted) => {
          setModel(normalizeRequestForm(persisted))
          onUpdated(persisted)
        },
      )
      setModel(normalizeRequestForm(published))
      onUpdated(published)
    } catch (error) {
      onAuthenticatedApiError(error)
      setErrorMessage(error instanceof Error ? error.message : t('requests.builder.publishError'))
      throw error
    } finally {
      setIsPublishing(false)
    }
  }

  return (
    <RequestFormBuilder
      canEdit={canEdit}
      canPublish={canPublish}
      errorMessage={errorMessage}
      isPublishing={isPublishing}
      isSaving={isSaving}
      locale={locale}
      model={model}
      teams={teams}
      workflowStatuses={resolvedConfiguration?.configuration.workflow.statuses}
      onChange={setModel}
      onPublish={publish}
      onSave={save}
    />
  )
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-selected={active}
      className={`min-h-10 rounded-lg px-4 text-sm font-semibold ${active ? 'bg-[var(--workbench-primary)] text-white' : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'}`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {label}
    </button>
  )
}

function openDownloadUrl(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.rel = 'noreferrer noopener'
  link.target = '_blank'
  link.click()
}
