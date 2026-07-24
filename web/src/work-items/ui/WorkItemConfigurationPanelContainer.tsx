import type { WorkItemConfiguration } from '@mukuroji/contracts'
import { useMemo, useRef, useState } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import {
  createTranslator,
  type Locale,
} from '../../shared/i18n/i18n'
import {
  putWorkItemConfiguration,
  type WorkItemConfigurationScope,
} from '../api'
import { useScopedWorkItemConfiguration } from '../queries/useWorkItemConfigurations'
import {
  WorkItemConfigurationPanel,
  type WorkItemConfigurationScopeOption,
} from './WorkItemConfigurationPanel'
import type { ProjectDirectoryTeam } from '../../projects/api'

/**
 * Inputs for the settings-scoped Work Item configuration container.
 */
export type WorkItemConfigurationPanelContainerProps = {
  /** Access token used by the configuration API. */
  accessToken: string
  /** Whether the current user may edit the Workspace default. */
  canManageWorkspaceConfiguration: boolean
  /** Whether Team-scoped mutations may be attempted. */
  canMutateTeamConfiguration: boolean
  /** Locale used by the configuration editor. */
  locale: Locale
  /** Teams available in the scope selector. */
  teams: readonly ProjectDirectoryTeam[]
}

/**
 * Connects the settings configuration editor to its scoped query and mutation.
 *
 * @param props - Authentication, permission, locale, and Team inputs.
 * @returns A configuration panel with scope selection and persistence wired in.
 */
export function WorkItemConfigurationPanelContainer({
  accessToken,
  canManageWorkspaceConfiguration,
  canMutateTeamConfiguration,
  locale,
  teams,
}: WorkItemConfigurationPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const mutationRequestRunner = useRef(createMutationRequestRunner()).current
  const [selectedScopeValue, setSelectedScopeValue] = useState('workspace')
  const selectedTeamId = selectedScopeValue.startsWith('team:')
    ? selectedScopeValue.slice('team:'.length)
    : undefined
  const selectedScope: WorkItemConfigurationScope = selectedTeamId
    ? { kind: 'team', teamId: selectedTeamId }
    : { kind: 'workspace' }
  const scopeOptions = useMemo<WorkItemConfigurationScopeOption[]>(() => [
    {
      description: t('workItems.configuration.scopeWorkspaceDescription'),
      label: t('workItems.configuration.scopeWorkspace'),
      value: 'workspace',
    },
    ...teams.map((team) => ({
      description: t('workItems.configuration.scopeTeamDescription').replace('{team}', team.name),
      label: t('workItems.configuration.scopeTeam').replace('{team}', team.name),
      value: `team:${team.id}`,
    })),
  ], [t, teams])
  const {
    data: resolvedConfiguration,
    error,
    isLoading,
    mutate,
  } = useScopedWorkItemConfiguration(accessToken, selectedScope)
  const readOnly = selectedScope.kind === 'workspace'
    ? !canManageWorkspaceConfiguration
    : !canMutateTeamConfiguration

  /**
   * Persists the selected scope while preserving inherited Team semantics.
   *
   * @param configuration - Configuration draft emitted by the editor.
   * @returns A promise that resolves after the SWR cache contains the saved value.
   */
  const handleSave = async (configuration: WorkItemConfiguration) => {
    const isCreatingTeamOverride =
      selectedScope.kind === 'team' && Boolean(resolvedConfiguration?.inheritedFrom)
    const payload: WorkItemConfiguration = {
      ...configuration,
      revision: isCreatingTeamOverride ? 0 : configuration.revision,
      scopeId: selectedScope.kind === 'team'
        ? selectedScope.teamId
        : configuration.scopeId,
      scopeType: selectedScope.kind,
      ...(isCreatingTeamOverride ? { updatedAt: undefined } : {}),
    }
    const saved = await mutationRequestRunner.run(
      `work-item-configuration:${selectedScopeValue}`,
      JSON.stringify(payload),
      (context) => putWorkItemConfiguration(
        accessToken,
        selectedScope,
        payload,
        context,
      ),
    )

    await mutate(saved, { revalidate: false })
  }

  return (
    <WorkItemConfigurationPanel
      configuration={resolvedConfiguration?.configuration}
      errorMessage={error instanceof Error ? error.message : undefined}
      inheritedFrom={resolvedConfiguration?.inheritedFrom}
      isLoading={isLoading}
      locale={locale}
      readOnly={readOnly}
      scopeOptions={scopeOptions}
      selectedScopeValue={selectedScopeValue}
      onSave={readOnly ? undefined : handleSave}
      onScopeChange={setSelectedScopeValue}
    />
  )
}
