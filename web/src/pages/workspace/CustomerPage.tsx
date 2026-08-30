import { useCallback, useEffect, useMemo } from 'react'
import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import type { CustomerListInput, CustomerSavedView } from '@mukuroji/contracts'
import { createCustomerSavedView } from '../../customers/api'
import { useCustomer, useCustomerSavedViews, useCustomers } from '../../customers/queries/useCustomers'
import { CustomerDirectoryView } from '../../customers/ui/CustomerDirectoryView'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  createProjectIssuesPath,
  createProjectSearchPath,
  createTeamIssuesPath,
} from '../../shared/routing/paths'
import { MobileSidebarButton, useWorkspaceSidebarController } from '../../shared/ui/sidebar'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/** Renders the Workspace Customer directory and selected Customer graph. */
export function CustomerPage() {
  const workspace = useWorkspaceRouteContext()
  const navigate = useNavigate()
  const { customerId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const [saveViewError, setSaveViewError] = useState(false)
  const [isSavingView, setIsSavingView] = useState(false)
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const filters = useMemo(() => readCustomerFilters(searchParams), [searchParams])
  const search = filters.search ?? ''
  const groupBy = readCustomerGroupBy(searchParams.get('groupBy'))
  const customers = useCustomers(
    workspace.accessToken,
    filters,
    workspace.canLoadWorkspaceData,
  )
  const savedViews = useCustomerSavedViews(
    workspace.accessToken,
    workspace.canLoadWorkspaceData,
  )
  const detail = useCustomer(
    workspace.accessToken,
    customerId,
    workspace.canLoadWorkspaceData,
  )

  const replaceSearch = useCallback((value: string) => {
    updateDirectorySearchParams(setSearchParams, { ...filters, search: value }, groupBy)
  }, [filters, groupBy, setSearchParams])

  const replaceFilters = useCallback((nextFilters: CustomerListInput) => {
    updateDirectorySearchParams(setSearchParams, nextFilters, groupBy)
  }, [groupBy, setSearchParams])

  const replaceGroupBy = useCallback((nextGroupBy: CustomerSavedView['groupBy']) => {
    updateDirectorySearchParams(setSearchParams, filters, nextGroupBy)
  }, [filters, setSearchParams])

  const applySavedView = useCallback((view: CustomerSavedView) => {
    updateDirectorySearchParams(setSearchParams, view.filters, view.groupBy)
  }, [setSearchParams])

  const saveView = useCallback(async (name: string) => {
    if (!workspace.accessToken) return
    setIsSavingView(true)
    setSaveViewError(false)
    try {
      await createCustomerSavedView(workspace.accessToken, {
        name,
        filters,
        ...(groupBy === undefined ? {} : { groupBy }),
      })
      await savedViews.mutate()
    } catch {
      setSaveViewError(true)
    } finally {
      setIsSavingView(false)
    }
  }, [filters, groupBy, savedViews, workspace.accessToken])

  useEffect(() => {
    document.title = `${t('customers.title')} | ${t('app.title')}`
  }, [t])

  const error = customers.error ?? detail.error ?? savedViews.error
  const errorMessage = error ? t('customers.loadError') : undefined
  const isLoading = Boolean(customers.isLoading || detail.isLoading || savedViews.isLoading)

  return (
    <>
      <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
        <div className="flex min-w-0 items-start gap-3">
          <MobileSidebarButton label={t('sidebar.mobileOpen')} onClick={openMobileSidebar} />
          <div className="min-w-0">
            <p className="workbench-eyebrow">{t('customers.eyebrow')}</p>
            <h1 className="workbench-title mt-2 text-page-title">{t('customers.title')}</h1>
            <p className="workbench-description mt-2 max-w-[760px]">{t('customers.description')}</p>
          </div>
        </div>
      </header>
      <WorkspaceRouteContent
        isLoading={Boolean(workspace.canLoadWorkspaceData && !customers.data && customers.isLoading)}
        sessionErrors={[customers.error, detail.error, savedViews.error]}
      >
        <CustomerDirectoryView
          customers={customers.data?.customers ?? []}
          detail={detail.data}
          errorMessage={errorMessage}
          filters={filters}
          groupBy={groupBy}
          isLoading={isLoading}
          locale={workspace.locale}
          onOpenWorkItem={(workItem) => navigate(
            workItem.projectId
              ? createProjectIssuesPath(workItem.projectId, workItem.teamId, workItem.workItemId)
              : createTeamIssuesPath(workItem.teamId, workItem.workItemId),
          )}
          onOpenProject={(project) => navigate(createProjectSearchPath(project.projectId))}
          onApplySavedView={applySavedView}
          onFiltersChange={replaceFilters}
          onGroupByChange={replaceGroupBy}
          onRetry={() => {
            void customers.mutate()
            if (customerId) void detail.mutate()
            void savedViews.mutate()
          }}
          onSaveView={saveView}
          onSearchChange={replaceSearch}
          onSelectCustomer={(selectedCustomerId) => navigate(
            `/customers/${encodeURIComponent(selectedCustomerId)}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`,
          )}
          search={search}
          savedViews={savedViews.data ?? []}
          isSavingView={isSavingView}
          saveViewError={saveViewError ? t('customers.filters.saveError') : undefined}
          t={t}
        />
      </WorkspaceRouteContent>
    </>
  )
}

/** Reads the supported Customer directory filters from URL state. */
function readCustomerFilters(searchParams: URLSearchParams): CustomerListInput {
  return {
    ...(readSearchValue(searchParams.get('q')) ? { search: readSearchValue(searchParams.get('q')) } : {}),
    ...(readSearchEnum(searchParams.get('tier'), customerTiers) ? { tier: readSearchEnum(searchParams.get('tier'), customerTiers) } : {}),
    ...(readSearchEnum(searchParams.get('size'), customerSizes) ? { size: readSearchEnum(searchParams.get('size'), customerSizes) } : {}),
    ...(readSearchEnum(searchParams.get('status'), customerStatuses) ? { status: readSearchEnum(searchParams.get('status'), customerStatuses) } : {}),
    ...(readSearchEnum(searchParams.get('health'), customerHealthes) ? { health: readSearchEnum(searchParams.get('health'), customerHealthes) } : {}),
    ...(readSearchNumber(searchParams.get('minBusinessValue')) === undefined ? {} : { minBusinessValue: readSearchNumber(searchParams.get('minBusinessValue')) }),
    ...(readSearchInteger(searchParams.get('minRequestCount')) === undefined ? {} : { minRequestCount: readSearchInteger(searchParams.get('minRequestCount')) }),
    ...(readSearchEnum(searchParams.get('sortBy'), customerSortFields) ? { sortBy: readSearchEnum(searchParams.get('sortBy'), customerSortFields) } : {}),
    ...(readSearchEnum(searchParams.get('sortDirection'), customerSortDirections) ? { sortDirection: readSearchEnum(searchParams.get('sortDirection'), customerSortDirections) } : {}),
  }
}

/** Writes the supported Customer directory state back to URL parameters. */
function updateDirectorySearchParams(
  setSearchParams: ReturnType<typeof useSearchParams>[1],
  filters: CustomerListInput,
  groupBy: CustomerSavedView['groupBy'],
): void {
  setSearchParams((current) => {
    const next = new URLSearchParams(current)
    const values: Record<string, string | undefined> = {
      q: filters.search?.trim() || undefined,
      tier: filters.tier,
      size: filters.size,
      status: filters.status,
      health: filters.health,
      minBusinessValue: filters.minBusinessValue === undefined ? undefined : String(filters.minBusinessValue),
      minRequestCount: filters.minRequestCount === undefined ? undefined : String(filters.minRequestCount),
      sortBy: filters.sortBy,
      sortDirection: filters.sortDirection,
      groupBy,
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) next.delete(key)
      else next.set(key, value)
    }
    next.delete('cursor')
    return next
  }, { replace: true })
}

/** Supported Customer tier values read from URL state. */
const customerTiers = ['strategic', 'enterprise', 'growth', 'standard', 'trial'] as const
/** Supported Customer size values read from URL state. */
const customerSizes = ['startup', 'small', 'mid-market', 'enterprise'] as const
/** Supported Customer status values read from URL state. */
const customerStatuses = ['prospect', 'active', 'inactive', 'churned'] as const
/** Supported Customer health values read from URL state. */
const customerHealthes = ['healthy', 'watch', 'at-risk', 'critical', 'unknown'] as const
/** Supported Customer sort fields read from URL state. */
const customerSortFields = ['name', 'tier', 'size', 'status', 'health', 'businessValue', 'requestCount', 'openRequestCount', 'updatedAt'] as const
/** Supported Customer sort directions read from URL state. */
const customerSortDirections = ['ascending', 'descending'] as const
/** Supported Customer grouping values read from URL state. */
const customerGroupings = ['tier', 'size', 'status', 'health', 'owner'] as const

/** Reads a non-empty URL string. */
function readSearchValue(value: string | null): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

/** Reads one URL enum without asserting at the transport boundary. */
function readSearchEnum<Value extends string>(value: string | null, values: readonly Value[]): Value | undefined {
  const normalized = readSearchValue(value)
  return normalized === undefined ? undefined : values.find((candidate) => candidate === normalized)
}

/** Reads a finite URL number. */
function readSearchNumber(value: string | null): number | undefined {
  if (!value?.trim()) return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

/** Reads a nonnegative safe integer from URL state. */
function readSearchInteger(value: string | null): number | undefined {
  const number = readSearchNumber(value)
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined
}

/** Reads the optional Customer grouping value from URL state. */
function readCustomerGroupBy(value: string | null): CustomerSavedView['groupBy'] {
  return readSearchEnum(value, customerGroupings)
}
