import { useMemo, useState } from 'react'
import { useSWRConfig } from 'swr'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'
import {
  createDeveloperApiKey,
  revokeDeveloperApiKey,
  rotateDeveloperApiKey,
  updatePersonalCredentialPolicy,
} from '../api/apiKeys'
import {
  connectDeveloperConnector,
  disconnectDeveloperConnector,
  reauthorizeDeveloperConnector,
} from '../api/connectors'
import { shouldRetainDeveloperPlatformMutationContext } from '../api/errors'
import { getDeveloperPlatformResources } from '../api/overview'
import {
  createDeveloperOAuthApp,
  revokeDeveloperOAuthApp,
  rotateDeveloperOAuthApp,
} from '../api/oauthApps'
import { resolveDeveloperSyncConflict } from '../api/syncConflicts'
import {
  createDeveloperImport,
  dryRunDeveloperImport,
  exportDeveloperWorkItems,
} from '../api/transfers'
import {
  createDeveloperWebhook,
  replayDeveloperWebhookDelivery,
  revokeDeveloperWebhook,
  rotateDeveloperWebhook,
} from '../api/webhooks'
import {
  flattenDeveloperSyncConflicts,
  replaceResolvedSyncConflictPages,
} from '../model/connectors'
import {
  applySavedPersonalCredentialPolicy,
  type SavedPersonalCredentialPolicy,
} from '../model/credentials'
import type { DeveloperExportFormat } from '../model/transfers'
import { buildConnectorAuthorizationReturnUrl } from '../mutations/connectorAuthorization'
import { runDeveloperPlatformMutation } from '../mutations/runDeveloperPlatformMutation'
import {
  useDeveloperPlatformResources,
  useDeveloperSyncConflicts,
  usePersonalCredentialAdministration,
} from '../queries/useDeveloperPlatform'
import { DeveloperPlatformPanel } from './DeveloperPlatformPanelView'
import type {
  DeveloperImportProjectOption,
  DeveloperPlatformLabels,
  DeveloperPlatformOption,
  DeveloperPlatformSection,
} from './DeveloperPlatformView'
import { triggerDeveloperExportDownload } from './developerExportDownload'

/**
 * Props used to connect the Developer Platform panel to authenticated data.
 */
export type DeveloperPlatformPanelContainerProps = {
  /** Access token used by Developer Platform API requests. */
  accessToken: string
  /** Localized labels and display options used by the panel. */
  labels: DeveloperPlatformLabels
  /** Section selected when the panel first mounts. */
  initialSection?: DeveloperPlatformSection
  /** Team options available as import destinations. */
  importTeamOptions?: DeveloperPlatformOption[]
  /** Project options available as import destinations. */
  importProjectOptions?: DeveloperImportProjectOption[]
  /** Optional timestamp formatting callback. */
  formatDateTime?: (value: string) => string
  /** Callback that performs the connector authorization redirect. */
  onAuthorizationRedirect?: (authorizationUrl: string) => void
}

/**
 * Connects Developer Platform queries, mutations, and cache refreshes to the pure panel.
 *
 * @param props - Authentication, localized view data, and redirect integration.
 * @returns The Developer Platform panel backed by SWR and API actions.
 */
export function DeveloperPlatformPanelContainer({
  accessToken,
  formatDateTime,
  initialSection,
  importProjectOptions,
  importTeamOptions,
  labels,
  onAuthorizationRedirect = (authorizationUrl) => {
    window.location.assign(authorizationUrl)
  },
}: DeveloperPlatformPanelContainerProps) {
  const { mutate: mutateCache } = useSWRConfig()
  const mutationSession = useMemo(
    () => ({
      accessToken,
      requestRunner: createMutationRequestRunner(),
    }),
    [accessToken],
  )
  const mutationRequestRunner = mutationSession.requestRunner
  const {
    data: resources,
    error,
    isLoading,
    isValidating: isResourcesValidating,
    key: resourceKey,
  } = useDeveloperPlatformResources(mutationSession.accessToken)
  const {
    data: personalCredentials,
    error: personalCredentialsError,
    isValidating: isPersonalCredentialsValidating,
    mutate: mutatePersonalCredentials,
  } = usePersonalCredentialAdministration(mutationSession.accessToken)
  const [savedPersonalCredentialPolicy, setSavedPersonalCredentialPolicy] =
    useState<SavedPersonalCredentialPolicy>()
  const displayedPersonalCredentials = applySavedPersonalCredentialPolicy(
    personalCredentials,
    savedPersonalCredentialPolicy,
  )
  // The key list and the personal-key classification load separately. While either reloads, or after the
  // classification failed to reload, a newly listed personal key may be missing from it, so rotation stays hidden.
  const personalCredentialsPending =
    !personalCredentials ||
    Boolean(personalCredentialsError) ||
    isPersonalCredentialsValidating ||
    isResourcesValidating
  const {
    data: syncConflictPages,
    error: syncConflictError,
    isLoading: isSyncConflictsLoading,
    isValidating: isSyncConflictsValidating,
    mutate: mutateSyncConflicts,
    setSize: setSyncConflictPageCount,
    size: syncConflictPageCount,
  } = useDeveloperSyncConflicts(mutationSession.accessToken)
  const syncConflicts = useMemo(
    () => flattenDeveloperSyncConflicts(syncConflictPages),
    [syncConflictPages],
  )
  const syncConflictsHasMore = Boolean(
    syncConflictPages?.at(-1)?.nextCursor,
  )
  const hasLoadedSyncConflictPage = syncConflictPages !== undefined
  const isLoadingMoreSyncConflicts = Boolean(
    isSyncConflictsValidating &&
      syncConflictPages &&
      syncConflictPages.length < syncConflictPageCount,
  )

  /** Refreshes the aggregate resource and the personal-key classification together. */
  const refresh = async () => {
    if (!resourceKey) {
      return
    }

    await Promise.all([
      mutateCache(
        resourceKey,
        () => getDeveloperPlatformResources(mutationSession.accessToken),
        { revalidate: false },
      ),
      // Reload the classification with the key list so a key another member issued meanwhile is marked personal.
      mutatePersonalCredentials().catch(() => {
        // The classification error stays visible with its retry action.
      }),
    ])
    mutationRequestRunner.discardRetainedContexts()
  }

  /** Retries aggregate loading without leaking a rejected click-handler Promise. */
  const retryLoad = async () => {
    try {
      await refresh()
    } catch {
      // Keep the SWR load error visible while preventing an unhandled rejection.
    }
  }

  /** Resets conflict pagination and refreshes the first page. */
  const resetSyncConflicts = async () => {
    await setSyncConflictPageCount(1)
    await mutateSyncConflicts()
  }

  /** Retries the currently loaded conflict pages. */
  const retrySyncConflicts = async () => {
    await mutateSyncConflicts()
  }

  /**
   * Runs an idempotent mutation and refreshes the aggregate resource.
   *
   * @param operationKey - Stable key used to retain mutation request context.
   * @param fingerprint - Fingerprint used to distinguish operation payloads.
   * @param request - API request invoked by the mutation request runner.
   * @returns The successful mutation result.
   */
  const runMutation = async <TResult,>(
    operationKey: string,
    fingerprint: string,
    request: Parameters<
      typeof mutationSession.requestRunner.run<TResult>
    >[2],
  ) => {
    return runDeveloperPlatformMutation(
      () =>
        mutationRequestRunner.run(
          operationKey,
          fingerprint,
          request,
          shouldRetainDeveloperPlatformMutationContext,
        ),
      refresh,
    )
  }

  /** Downloads an exported Work Item file through a temporary object URL. */
  const downloadExport = async (format: DeveloperExportFormat) => {
    const exportedFile = await exportDeveloperWorkItems(
      mutationSession.accessToken,
      format,
    )
    triggerDeveloperExportDownload(
      exportedFile.blob,
      exportedFile.fileName,
    )
  }

  return (
    <DeveloperPlatformPanel
      formatDateTime={formatDateTime}
      initialSection={initialSection}
      importProjectOptions={importProjectOptions}
      importTeamOptions={importTeamOptions}
      isLoading={isLoading}
      isLoadingMoreSyncConflicts={isLoadingMoreSyncConflicts}
      isSyncConflictsLoading={isSyncConflictsLoading}
      key={mutationSession.accessToken}
      labels={labels}
      loadErrorMessage={error ? labels.loadError : undefined}
      resources={resources}
      personalCredentials={displayedPersonalCredentials}
      personalCredentialsPending={personalCredentialsPending}
      personalCredentialsLoadError={Boolean(personalCredentialsError)}
      onRetryPersonalCredentials={() => {
        void mutatePersonalCredentials().catch(() => {
          // The query error stays visible with its retry action.
        })
      }}
      syncConflicts={syncConflicts}
      syncConflictsErrorMessage={
        !hasLoadedSyncConflictPage && syncConflictError
          ? labels.helpText.syncConflictsError
          : undefined
      }
      syncConflictsHasMore={syncConflictsHasMore}
      syncConflictsLoadMoreErrorMessage={
        hasLoadedSyncConflictPage && syncConflictError
          ? labels.helpText.syncConflictsLoadMoreError
          : undefined
      }
      onCommitImport={async (input) => {
        const fingerprint = await createMutationFingerprint(
          input.source.fileName,
          input.source.content,
          JSON.stringify(input.mapping),
          input.teamId,
          input.assignedProjectId ?? '',
        )

        return runMutation(
          'developer-import:create',
          fingerprint,
          (context) =>
            createDeveloperImport(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }}
      onConnectConnector={async (provider, input) => {
        const returnUrl = buildConnectorAuthorizationReturnUrl(
          window.location.href,
        )
        const authorization = await runMutation(
          `developer-connector:connect:${provider}`,
          JSON.stringify({ ...input, returnUrl }),
          (context) =>
            connectDeveloperConnector(
              mutationSession.accessToken,
              provider,
              { ...input, returnUrl },
              context,
            ),
        )

        onAuthorizationRedirect(authorization.authorizationUrl)
      }}
      onCreateApiKey={(input) =>
        runMutation(
          'developer-api-key:create',
          JSON.stringify(input),
          (context) =>
            createDeveloperApiKey(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }
      onCreateOAuthApp={(input) =>
        runMutation(
          'developer-oauth-app:create',
          JSON.stringify(input),
          (context) =>
            createDeveloperOAuthApp(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }
      onCreateWebhook={(input) =>
        runMutation(
          'developer-webhook:create',
          JSON.stringify(input),
          (context) =>
            createDeveloperWebhook(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }
      onDisconnectConnector={(installationId) =>
        runMutation(
          `developer-connector:disconnect:${installationId}`,
          installationId,
          async (context) => {
            await disconnectDeveloperConnector(
              mutationSession.accessToken,
              installationId,
              context,
            )
          },
        )
      }
      onDryRunImport={async (input) => {
        const fingerprint = await createMutationFingerprint(
          input.source.fileName,
          input.source.content,
          JSON.stringify(input.mapping),
          input.teamId,
          input.assignedProjectId ?? '',
        )

        return runMutation(
          'developer-import:dry-run',
          fingerprint,
          (context) =>
            dryRunDeveloperImport(
              mutationSession.accessToken,
              input,
              context,
            ),
        )
      }}
      onExport={downloadExport}
      onReauthorizeConnector={async (installationId) => {
        const authorization = await runMutation(
          `developer-connector:reauth:${installationId}`,
          installationId,
          (context) =>
            reauthorizeDeveloperConnector(
              mutationSession.accessToken,
              installationId,
              context,
            ),
        )

        onAuthorizationRedirect(authorization.authorizationUrl)
      }}
      onReplayDelivery={(deliveryId) =>
        runMutation(
          `developer-webhook-delivery:replay:${deliveryId}`,
          deliveryId,
          async (context) => {
            await replayDeveloperWebhookDelivery(
              mutationSession.accessToken,
              deliveryId,
              context,
            )
          },
        )
      }
      onResolveSyncConflict={async (input) => {
        const resolvedConflict = await runMutation(
          `developer-sync-conflict:resolve:${input.conflictId}`,
          JSON.stringify(input),
          (context) =>
            resolveDeveloperSyncConflict(
              mutationSession.accessToken,
              input,
              context,
            ),
        )

        await mutateSyncConflicts(
          (current) =>
            replaceResolvedSyncConflictPages(current, resolvedConflict),
          { revalidate: false },
        )

        try {
          await resetSyncConflicts()
        } catch {
          // The mutation response already updated the cached conflict.
        }
      }}
      onRetry={retryLoad}
      onLoadMoreSyncConflicts={
        syncConflictsHasMore
          ? async () => {
              await setSyncConflictPageCount(syncConflictPageCount + 1)
            }
          : undefined
      }
      onRetrySyncConflicts={retrySyncConflicts}
      onRevokeApiKey={(apiKeyId) =>
        runMutation(
          `developer-api-key:revoke:${apiKeyId}`,
          apiKeyId,
          async (context) => {
            await revokeDeveloperApiKey(
              mutationSession.accessToken,
              apiKeyId,
              context,
            )
          },
        )
      }
      onRevokeOAuthApp={(oauthAppId) =>
        runMutation(
          `developer-oauth-app:revoke:${oauthAppId}`,
          oauthAppId,
          async (context) => {
            await revokeDeveloperOAuthApp(
              mutationSession.accessToken,
              oauthAppId,
              context,
            )
          },
        )
      }
      onRevokeWebhook={(subscriptionId) =>
        runMutation(
          `developer-webhook:revoke:${subscriptionId}`,
          subscriptionId,
          async (context) => {
            await revokeDeveloperWebhook(
              mutationSession.accessToken,
              subscriptionId,
              context,
            )
          },
        )
      }
      onChangePersonalCredentialPolicy={async (selfIssuanceEnabled) => {
        const policy = await runMutation(
          `developer-credential-policy:${selfIssuanceEnabled}`,
          String(selfIssuanceEnabled),
          (context) =>
            updatePersonalCredentialPolicy(
              mutationSession.accessToken,
              { selfIssuanceEnabled },
              context,
            ),
        )
        // Writing to the SWR cache would clear a reload error and show Rotate again, so the saved policy is
        // kept beside the classification it was saved over until a newer classification loads.
        setSavedPersonalCredentialPolicy({ policy, basis: personalCredentials })
      }}
      onRotateApiKey={(apiKeyId) =>
        runMutation(
          `developer-api-key:rotate:${apiKeyId}`,
          apiKeyId,
          (context) =>
            rotateDeveloperApiKey(
              mutationSession.accessToken,
              apiKeyId,
              context,
            ),
        )
      }
      onRotateOAuthApp={(oauthAppId) =>
        runMutation(
          `developer-oauth-app:rotate:${oauthAppId}`,
          oauthAppId,
          (context) =>
            rotateDeveloperOAuthApp(
              mutationSession.accessToken,
              oauthAppId,
              context,
            ),
        )
      }
      onRotateWebhook={(subscriptionId) =>
        runMutation(
          `developer-webhook:rotate:${subscriptionId}`,
          subscriptionId,
          (context) =>
            rotateDeveloperWebhook(
              mutationSession.accessToken,
              subscriptionId,
              context,
            ),
        )
      }
    />
  )
}
