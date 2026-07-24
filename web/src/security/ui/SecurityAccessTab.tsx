import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  CreateEnterpriseGroupRoleMappingInput,
  CreateEnterpriseRoleInput,
  EnterpriseGroupRoleMapping,
  EnterpriseRoleDefinition,
  EnterpriseRoleImpact,
  EnterpriseSecuritySnapshot,
  PreviewEnterpriseRoleImpactInput,
  UpdateEnterpriseGroupRoleMappingInput,
  UpdateEnterpriseRoleInput,
} from '../api'
import {
  createEnterpriseSecurityTestId,
  formatEnterpriseRoleImpactBlockedMessage,
  formatEnterpriseSecurityPermissionDescription,
  formatEnterpriseSecurityPermissionName,
  formatEnterpriseSecurityRoleName,
} from '../model/enterpriseSecurityDisplay'
import {
  createEnterpriseSecurityScopeValue,
  createMappingDrafts,
  createRoleGuestAssignableDrafts,
  createRolePermissionDrafts,
  resolveAssignableMappingRoles,
  resolveMappingScopeValue,
  type EnterpriseSecurityScopeOption,
} from '../model/enterpriseSecurityForms'
import {
  EnterpriseSecurityEmptyState,
  EnterpriseSecurityReadOnlyNotice,
  EnterpriseSecuritySectionHeader,
} from './EnterpriseSecurityFields'

/**
 * Renders directory-group mappings and custom-role permission editors.
 *
 * @param props - Access snapshot, scope options, mutations, and localized copy.
 * @returns The independently renderable access tab.
 */
export function SecurityAccessTab({
  busyOperation,
  scopeOptions,
  snapshot,
  t,
  onCreateMapping,
  onCreateRole,
  onDeleteMapping,
  onPreviewRoleImpact,
  onRequestDeleteRole,
  onRequestUpdateRole,
  onUpdateMapping,
  onUpdateRole,
}: {
  busyOperation?: string
  scopeOptions: EnterpriseSecurityScopeOption[]
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onCreateMapping?: (
    input: CreateEnterpriseGroupRoleMappingInput,
  ) => Promise<unknown>
  onCreateRole?: (input: CreateEnterpriseRoleInput) => Promise<unknown>
  onDeleteMapping?: (
    mapping: EnterpriseGroupRoleMapping,
  ) => Promise<unknown>
  onPreviewRoleImpact?: (
    role: EnterpriseRoleDefinition,
    input: PreviewEnterpriseRoleImpactInput,
  ) => Promise<EnterpriseRoleImpact>
  onRequestDeleteRole: (
    role: EnterpriseRoleDefinition,
    impact: EnterpriseRoleImpact,
  ) => void
  onRequestUpdateRole: (
    role: EnterpriseRoleDefinition,
    input: UpdateEnterpriseRoleInput,
    impact: EnterpriseRoleImpact,
  ) => void
  onUpdateMapping?: (
    mappingId: string,
    input: UpdateEnterpriseGroupRoleMappingInput,
  ) => Promise<unknown>
  onUpdateRole?: (
    roleId: string,
    input: UpdateEnterpriseRoleInput,
  ) => Promise<unknown>
}) {
  const canManageMappings = snapshot.capabilities.canManageMappings
  const canManageRoles = snapshot.capabilities.canManageRoles
  const assignablePermissionIds = new Set(snapshot.assignablePermissionIds)
  const isBusy = Boolean(busyOperation)
  const defaultScope = scopeOptions[0]
  const [directoryGroupId, setDirectoryGroupId] = useState('')
  const [directoryGroupName, setDirectoryGroupName] = useState('')
  const [scopeValue, setScopeValue] = useState(
    defaultScope ? createEnterpriseSecurityScopeValue(defaultScope) : '',
  )
  const [mappingRoleId, setMappingRoleId] = useState('')
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleDescription, setNewRoleDescription] = useState('')
  const [newRolePermissionIds, setNewRolePermissionIds] = useState<string[]>([])
  const [newRoleGuestAssignable, setNewRoleGuestAssignable] = useState(false)
  const [mappingDrafts, setMappingDrafts] = useState(() =>
    createMappingDrafts(snapshot.mappings, scopeOptions),
  )
  const [roleDrafts, setRoleDrafts] = useState<
    Record<string, readonly string[]>
  >(() => createRolePermissionDrafts(snapshot.roles))
  const [roleGuestAssignableDrafts, setRoleGuestAssignableDrafts] = useState<
    Record<string, boolean>
  >(() => createRoleGuestAssignableDrafts(snapshot.roles))
  const [roleImpactMessage, setRoleImpactMessage] = useState<string>()
  const selectedScopeValue = scopeOptions.some(
    (scope) => createEnterpriseSecurityScopeValue(scope) === scopeValue,
  )
    ? scopeValue
    : defaultScope
      ? createEnterpriseSecurityScopeValue(defaultScope)
      : ''
  const selectedScope = scopeOptions.find(
    (scope) =>
      createEnterpriseSecurityScopeValue(scope) === selectedScopeValue,
  )
  const availableMappingRoles = selectedScope
    ? resolveAssignableMappingRoles(snapshot, selectedScope.type)
    : []
  const selectedMappingRoleId = availableMappingRoles.some(
    (role) => role.id === mappingRoleId,
  )
    ? mappingRoleId
    : ''

  /** Creates a directory-group mapping from the nearest form state. */
  const handleMappingSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      !canManageMappings ||
      !selectedScope ||
      !selectedMappingRoleId ||
      !snapshot.scim.identityProviderId ||
      !directoryGroupId.trim() ||
      !directoryGroupName.trim() ||
      !onCreateMapping
    ) {
      return
    }

    try {
      await onCreateMapping({
        directoryGroupId: directoryGroupId.trim(),
        directoryGroupName: directoryGroupName.trim(),
        identityProviderId: snapshot.scim.identityProviderId,
        roleId: selectedMappingRoleId,
        scopeId: selectedScope.id,
        scopeName: selectedScope.name,
        scopeType: selectedScope.type,
      })
      setDirectoryGroupId('')
      setDirectoryGroupName('')
      setMappingRoleId('')
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  /** Creates a custom role after enforcing the caller's grant ceiling. */
  const handleCreateRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      !canManageRoles ||
      !newRoleName.trim() ||
      newRolePermissionIds.length === 0 ||
      newRolePermissionIds.some(
        (permissionId) => !assignablePermissionIds.has(permissionId),
      ) ||
      !onCreateRole ||
      isBusy
    ) {
      return
    }

    try {
      await onCreateRole({
        description: newRoleDescription.trim(),
        guestAssignable: newRoleGuestAssignable,
        name: newRoleName.trim(),
        permissionIds: newRolePermissionIds,
      })
      setNewRoleName('')
      setNewRoleDescription('')
      setNewRolePermissionIds([])
      setNewRoleGuestAssignable(false)
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  /** Sends the selected scope and role through the confirmation boundary. */
  const handleUpdateMapping = async (mapping: EnterpriseGroupRoleMapping) => {
    const draft = mappingDrafts[mapping.id]
    const selectedMappingScope = scopeOptions.find(
      (scope) =>
        createEnterpriseSecurityScopeValue(scope) === draft?.scopeValue,
    )

    if (!draft || !selectedMappingScope || !draft.roleId || !onUpdateMapping) {
      return
    }

    try {
      await onUpdateMapping(mapping.id, {
        directoryGroupId: mapping.directoryGroupId,
        directoryGroupName: mapping.directoryGroupName,
        expectedVersion: mapping.version,
        identityProviderId: mapping.identityProviderId,
        roleId: draft.roleId,
        scopeId: selectedMappingScope.id,
        scopeName: selectedMappingScope.name,
        scopeType: selectedMappingScope.type,
      })
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  /** Previews custom-role impact and requests confirmation when needed. */
  const handleUpdateRole = async (role: EnterpriseRoleDefinition) => {
    const permissionIds = [...(roleDrafts[role.id] ?? [])]
    const guestAssignable =
      roleGuestAssignableDrafts[role.id] ?? role.guestAssignable
    if (
      permissionIds.length === 0 ||
      permissionIds.some(
        (permissionId) => !assignablePermissionIds.has(permissionId),
      ) ||
      !onPreviewRoleImpact ||
      !onUpdateRole
    ) {
      return
    }

    const input = {
      description: role.description,
      expectedVersion: role.version,
      guestAssignable,
      name: role.name,
      permissionIds,
    } satisfies UpdateEnterpriseRoleInput

    try {
      const impact = await onPreviewRoleImpact(role, {
        expectedVersion: role.version,
        guestAssignable,
        permissionIds,
      })
      if (impact.blocking) {
        setRoleImpactMessage(
          formatEnterpriseRoleImpactBlockedMessage(impact, t),
        )
        return
      }

      setRoleImpactMessage(undefined)
      if (
        guestAssignable !== role.guestAssignable ||
        (impact.removedPermissionIds.length > 0 &&
          (impact.assignmentCount > 0 ||
            impact.mappingCount > 0 ||
            impact.serviceAccountCount > 0))
      ) {
        onRequestUpdateRole(role, input, impact)
        return
      }

      await onUpdateRole(role.id, {
        ...input,
        impactConfirmationToken: impact.confirmationToken,
      })
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  /** Previews custom-role deletion before opening the destructive dialog. */
  const handleDeleteRole = async (role: EnterpriseRoleDefinition) => {
    if (!onPreviewRoleImpact) {
      return
    }

    try {
      const impact = await onPreviewRoleImpact(role, {
        delete: true,
        expectedVersion: role.version,
      })
      if (impact.blocking) {
        setRoleImpactMessage(
          formatEnterpriseRoleImpactBlockedMessage(impact, t),
        )
        return
      }

      setRoleImpactMessage(undefined)
      onRequestDeleteRole(role, impact)
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  return (
    <div className="grid gap-5" data-testid="security-access">
      {!canManageMappings && !canManageRoles ? (
        <EnterpriseSecurityReadOnlyNotice t={t} />
      ) : null}

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          description={t('security.access.mappingsDescription')}
          title={t('security.access.mappingsTitle')}
        />
        {canManageMappings ? (
          <form
            className="grid grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_minmax(200px,1fr)_minmax(180px,0.8fr)_auto] items-end gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4 max-[1240px]:grid-cols-2 max-[640px]:grid-cols-1"
            data-testid="security-mapping-form"
            onSubmit={(event) => void handleMappingSubmit(event)}
          >
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.directoryGroupName')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                required
                value={directoryGroupName}
                onChange={(event) => setDirectoryGroupName(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.directoryGroupId')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                required
                value={directoryGroupId}
                onChange={(event) => setDirectoryGroupId(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.scope')}
              <select
                className="workbench-input min-h-10 px-3"
                disabled={isBusy || scopeOptions.length === 0}
                required
                value={selectedScopeValue}
                onChange={(event) => {
                  setScopeValue(event.target.value)
                  setMappingRoleId('')
                }}
              >
                {scopeOptions.map((scope) => (
                  <option
                    key={createEnterpriseSecurityScopeValue(scope)}
                    value={createEnterpriseSecurityScopeValue(scope)}
                  >
                    {t(`security.scope.${scope.type}`)} · {scope.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.role')}
              <select
                className="workbench-input min-h-10 px-3"
                disabled={isBusy || availableMappingRoles.length === 0}
                required
                value={selectedMappingRoleId}
                onChange={(event) => setMappingRoleId(event.target.value)}
              >
                <option disabled value="">
                  {t('security.access.selectRole')}
                </option>
                {availableMappingRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {formatEnterpriseSecurityRoleName(role, t)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55"
              disabled={
                isBusy ||
                scopeOptions.length === 0 ||
                !directoryGroupId.trim() ||
                !directoryGroupName.trim() ||
                !snapshot.scim.identityProviderId ||
                !selectedMappingRoleId
              }
              type="submit"
            >
              {t('security.access.addMapping')}
            </button>
          </form>
        ) : null}
        <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
          <table
            className="w-full min-w-[820px] border-collapse text-left"
            data-testid="security-mapping-table"
          >
            <thead>
              <tr className="workbench-table-head">
                <th className="px-4 py-3" scope="col">
                  {t('security.access.column.group')}
                </th>
                <th className="px-4 py-3" scope="col">
                  {t('security.access.column.scope')}
                </th>
                <th className="px-4 py-3" scope="col">
                  {t('security.access.column.role')}
                </th>
                <th className="px-4 py-3 text-right" scope="col">
                  {t('security.access.column.action')}
                </th>
              </tr>
            </thead>
            <tbody>
              {snapshot.mappings.map((mapping) => {
                const role = snapshot.roles.find(
                  (candidate) => candidate.id === mapping.roleId,
                )
                const mappingDraft = mappingDrafts[mapping.id]
                const selectedMappingScope = scopeOptions.find(
                  (scope) =>
                    createEnterpriseSecurityScopeValue(scope) ===
                    mappingDraft?.scopeValue,
                )
                const availableRolesForMapping = selectedMappingScope
                  ? resolveAssignableMappingRoles(
                      snapshot,
                      selectedMappingScope.type,
                    )
                  : []
                const selectedRole = availableRolesForMapping.find(
                  (candidate) => candidate.id === mappingDraft?.roleId,
                )
                const currentDraftRole = snapshot.roles.find(
                  (candidate) => candidate.id === mappingDraft?.roleId,
                )

                return (
                  <tr
                    className="border-t border-[var(--workbench-border)]"
                    data-testid={`security-mapping-${createEnterpriseSecurityTestId(mapping.id)}`}
                    key={mapping.id}
                  >
                    <th className="px-4 py-4 text-left" scope="row">
                      <p className="font-semibold text-[var(--workbench-text)]">
                        {mapping.directoryGroupName}
                      </p>
                      <code className="mt-1 block text-xs text-[var(--workbench-muted)]">
                        {mapping.directoryGroupId}
                      </code>
                    </th>
                    <td className="px-4 py-4">
                      {canManageMappings ? (
                        <select
                          aria-label={`${mapping.directoryGroupName}: ${t('security.access.scope')}`}
                          className="workbench-input min-h-9 w-full px-2 text-sm"
                          disabled={isBusy || scopeOptions.length === 0}
                          value={mappingDraft?.scopeValue ?? ''}
                          onChange={(event) =>
                            setMappingDrafts((current) => ({
                              ...current,
                              [mapping.id]: {
                                roleId: '',
                                scopeValue: event.target.value,
                              },
                            }))
                          }
                        >
                          {scopeOptions.map((scope) => (
                            <option
                              key={createEnterpriseSecurityScopeValue(scope)}
                              value={createEnterpriseSecurityScopeValue(scope)}
                            >
                              {t(`security.scope.${scope.type}`)} · {scope.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <p className="text-sm font-semibold text-[var(--workbench-text)]">
                            {mapping.scopeName}
                          </p>
                          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                            {t(`security.scope.${mapping.scopeType}`)}
                          </p>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {canManageMappings ? (
                        <select
                          aria-label={`${mapping.directoryGroupName}: ${t('security.access.role')}`}
                          className="workbench-input min-h-9 w-full px-2 text-sm"
                          disabled={
                            isBusy || availableRolesForMapping.length === 0
                          }
                          value={mappingDraft?.roleId ?? mapping.roleId}
                          onChange={(event) =>
                            setMappingDrafts((current) => ({
                              ...current,
                              [mapping.id]: {
                                roleId: event.target.value,
                                scopeValue:
                                  current[mapping.id]?.scopeValue ??
                                  resolveMappingScopeValue(
                                    mapping,
                                    scopeOptions,
                                  ),
                              },
                            }))
                          }
                        >
                          <option disabled value="">
                            {t('security.access.selectRole')}
                          </option>
                          {currentDraftRole &&
                          !availableRolesForMapping.some(
                            (candidate) => candidate.id === currentDraftRole.id,
                          ) ? (
                            <option disabled value={currentDraftRole.id}>
                              {formatEnterpriseSecurityRoleName(
                                currentDraftRole,
                                t,
                              )}
                            </option>
                          ) : null}
                          {availableRolesForMapping.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {formatEnterpriseSecurityRoleName(candidate, t)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="workbench-badge-primary">
                          {role
                            ? formatEnterpriseSecurityRoleName(role, t)
                            : mapping.roleId}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      {canManageMappings ? (
                        <div className="flex justify-end gap-2">
                          <button
                            aria-label={`${t('security.action.save')}: ${mapping.directoryGroupName}`}
                            className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                            disabled={
                              isBusy || !selectedMappingScope || !selectedRole
                            }
                            type="button"
                            onClick={() => void handleUpdateMapping(mapping)}
                          >
                            {t(
                              busyOperation === `mapping:update:${mapping.id}`
                                ? 'security.action.saving'
                                : 'security.action.save',
                            )}
                          </button>
                          <button
                            aria-label={`${t('security.action.remove')}: ${mapping.directoryGroupName}`}
                            className="workbench-button-secondary min-h-9 px-3 text-red-700 disabled:cursor-not-allowed disabled:opacity-55"
                            disabled={isBusy}
                            type="button"
                            onClick={() =>
                              void onDeleteMapping?.(mapping).catch(
                                () => undefined,
                              )
                            }
                          >
                            {t('security.action.remove')}
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {snapshot.mappings.length === 0 ? (
            <EnterpriseSecurityEmptyState
              text={t('security.access.mappingsEmpty')}
            />
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          description={t('security.access.rolesDescription')}
          title={t('security.access.rolesTitle')}
        />
        {canManageRoles ? (
          <form
            className="grid grid-cols-2 gap-4 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4 max-[760px]:grid-cols-1"
            data-testid="security-role-create-form"
            onSubmit={(event) => void handleCreateRole(event)}
          >
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.roleName')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                maxLength={100}
                required
                value={newRoleName}
                onChange={(event) => setNewRoleName(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.roleDescription')}
              <input
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                maxLength={240}
                value={newRoleDescription}
                onChange={(event) => setNewRoleDescription(event.target.value)}
              />
            </label>
            <fieldset
              className="col-span-2 grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-white p-4 max-[760px]:col-span-1"
              disabled={isBusy}
            >
              <legend className="px-1 text-xs font-semibold text-[var(--workbench-text)]">
                {t('security.access.rolePermissions')}
              </legend>
              <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {t('security.access.permissionGrantCeilingHelp')}
              </p>
              <div className="grid grid-cols-2 gap-2 max-[760px]:grid-cols-1">
                {snapshot.permissions.map((permission) => {
                  const assignable = assignablePermissionIds.has(permission.id)

                  return (
                    <label
                      className={`flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 ${
                        assignable
                          ? 'border-[var(--workbench-border)]'
                          : 'cursor-not-allowed border-slate-200 bg-slate-50 text-[var(--workbench-muted)]'
                      }`}
                      key={permission.id}
                      title={
                        assignable
                          ? undefined
                          : t('security.access.permissionOutsideGrantCeiling')
                      }
                    >
                      <input
                        checked={newRolePermissionIds.includes(permission.id)}
                        className="mt-0.5 h-4 w-4 flex-none accent-[var(--workbench-primary)]"
                        disabled={!assignable}
                        type="checkbox"
                        onChange={(event) =>
                          setNewRolePermissionIds((current) =>
                            event.target.checked
                              ? Array.from(new Set([...current, permission.id]))
                              : current.filter((id) => id !== permission.id),
                          )
                        }
                      />
                      <span className="min-w-0 text-xs font-semibold leading-5">
                        {formatEnterpriseSecurityPermissionName(permission, t)}
                      </span>
                    </label>
                  )
                })}
              </div>
            </fieldset>
            <label className="col-span-2 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 max-[760px]:col-span-1">
              <input
                checked={newRoleGuestAssignable}
                className="mt-0.5 h-4 w-4 flex-none accent-[var(--workbench-primary)]"
                disabled={isBusy}
                type="checkbox"
                onChange={(event) =>
                  setNewRoleGuestAssignable(event.target.checked)
                }
              />
              <span className="min-w-0">
                <strong className="block text-sm font-semibold text-amber-950">
                  {t('security.access.guestAssignable')}
                </strong>
                <span className="mt-1 block text-xs font-medium leading-5 text-amber-900">
                  {t('security.access.guestAssignableWarning')}
                </span>
              </span>
            </label>
            <div className="col-span-2 flex items-center justify-between gap-3 max-[760px]:col-span-1">
              {newRolePermissionIds.length === 0 ? (
                <p className="text-xs font-semibold text-amber-800" role="status">
                  {t('security.access.permissionRequired')}
                </p>
              ) : (
                <span />
              )}
              <button
                className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-55"
                disabled={
                  isBusy ||
                  !newRoleName.trim() ||
                  newRolePermissionIds.length === 0
                }
                type="submit"
              >
                {t('security.access.createRole')}
              </button>
            </div>
          </form>
        ) : null}

        {roleImpactMessage ? (
          <p
            className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900"
            role="alert"
          >
            {roleImpactMessage}
          </p>
        ) : null}

        <RolePermissionMatrix
          assignablePermissionIds={snapshot.assignablePermissionIds}
          busyOperation={busyOperation}
          canManage={canManageRoles}
          canPreviewImpact={Boolean(onPreviewRoleImpact)}
          permissions={snapshot.permissions}
          roleGuestAssignableDrafts={roleGuestAssignableDrafts}
          roleDrafts={roleDrafts}
          roles={snapshot.roles}
          t={t}
          onChange={(roleId, permissionId, checked) =>
            setRoleDrafts((current) => {
              const existing = current[roleId] ?? []
              const next = checked
                ? Array.from(new Set([...existing, permissionId]))
                : existing.filter((id) => id !== permissionId)

              return { ...current, [roleId]: next }
            })
          }
          onDelete={handleDeleteRole}
          onGuestAssignableChange={(roleId, checked) =>
            setRoleGuestAssignableDrafts((current) => ({
              ...current,
              [roleId]: checked,
            }))
          }
          onSave={handleUpdateRole}
        />
      </section>
    </div>
  )
}

/**
 * Renders the grouped permission and guest-assignment matrix for all roles.
 *
 * @param props - Role drafts, grant ceiling, localized copy, and edit actions.
 * @returns The horizontally scrollable role permission matrix.
 */
function RolePermissionMatrix({
  assignablePermissionIds,
  busyOperation,
  canManage,
  canPreviewImpact,
  permissions,
  roleGuestAssignableDrafts,
  roleDrafts,
  roles,
  t,
  onChange,
  onDelete,
  onGuestAssignableChange,
  onSave,
}: {
  assignablePermissionIds: readonly string[]
  busyOperation?: string
  canManage: boolean
  canPreviewImpact: boolean
  permissions: EnterpriseSecuritySnapshot['permissions']
  roleGuestAssignableDrafts: Readonly<Record<string, boolean>>
  roleDrafts: Readonly<Record<string, readonly string[]>>
  roles: EnterpriseRoleDefinition[]
  t: (key: MessageKey) => string
  onChange: (roleId: string, permissionId: string, checked: boolean) => void
  onDelete: (role: EnterpriseRoleDefinition) => Promise<void>
  onGuestAssignableChange: (roleId: string, checked: boolean) => void
  onSave: (role: EnterpriseRoleDefinition) => Promise<void>
}) {
  const permissionGroups: readonly EnterpriseSecuritySnapshot['permissions'][number]['group'][] =
    [
      'workspace',
      'members',
      'content',
      'security',
      'automation',
    ]
  const isBusy = Boolean(busyOperation)
  const assignablePermissionIdSet = new Set(assignablePermissionIds)

  /** Reports whether a role draft exceeds the caller's current grant ceiling. */
  const roleExceedsGrantCeiling = (roleId: string) =>
    (roleDrafts[roleId] ?? []).some(
      (permissionId) => !assignablePermissionIdSet.has(permissionId),
    )

  return (
    <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
      <table
        className="w-full min-w-[980px] border-collapse text-left"
        data-testid="security-role-permission-matrix"
      >
        <thead>
          <tr className="workbench-table-head">
            <th
              className="sticky left-0 z-10 min-w-[320px] bg-[var(--workbench-surface-muted)] px-4 py-3"
              scope="col"
            >
              {t('security.access.permission')}
            </th>
            {roles.map((role) => (
              <th
                className="min-w-[170px] px-4 py-3 text-center"
                key={role.id}
                scope="col"
              >
                <span className="block text-[var(--workbench-text)]">
                  {formatEnterpriseSecurityRoleName(role, t)}
                </span>
                <span className="mt-1 block text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                  {t(`security.role.kind.${role.kind}`)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {permissionGroups.map((group) => {
            const groupPermissions = permissions.filter(
              (permission) => permission.group === group,
            )

            if (groupPermissions.length === 0) {
              return null
            }

            return [
              <tr key={`${group}-heading`}>
                <th
                  className="bg-slate-50 px-4 py-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]"
                  colSpan={roles.length + 1}
                  scope="rowgroup"
                >
                  {t(`security.permissionGroup.${group}`)}
                </th>
              </tr>,
              ...groupPermissions.map((permission) => (
                <tr
                  className="border-t border-[var(--workbench-border)]"
                  key={permission.id}
                >
                  <th
                    className="sticky left-0 z-10 bg-white px-4 py-4"
                    scope="row"
                  >
                    <span className="block text-sm font-semibold text-[var(--workbench-text)]">
                      {formatEnterpriseSecurityPermissionName(permission, t)}
                    </span>
                    <span className="mt-1 block text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                      {formatEnterpriseSecurityPermissionDescription(
                        permission,
                        t,
                      )}
                    </span>
                    {permission.privileged ? (
                      <span className="workbench-badge-warning mt-2">
                        {t('security.access.privilegedPermission')}
                      </span>
                    ) : null}
                    {!assignablePermissionIdSet.has(permission.id) ? (
                      <span className="mt-2 block text-xs font-semibold text-slate-500">
                        {t('security.access.permissionOutsideGrantCeiling')}
                      </span>
                    ) : null}
                  </th>
                  {roles.map((role) => {
                    const checked = (roleDrafts[role.id] ?? []).includes(
                      permission.id,
                    )
                    const editable =
                      canManage &&
                      role.kind === 'custom' &&
                      assignablePermissionIdSet.has(permission.id)

                    return (
                      <td className="px-4 py-4 text-center" key={role.id}>
                        <input
                          aria-label={`${formatEnterpriseSecurityRoleName(role, t)}: ${formatEnterpriseSecurityPermissionName(permission, t)}`}
                          checked={checked}
                          className="h-5 w-5 accent-[var(--workbench-primary)]"
                          disabled={!editable || isBusy}
                          title={
                            assignablePermissionIdSet.has(permission.id)
                              ? undefined
                              : t(
                                  'security.access.permissionOutsideGrantCeiling',
                                )
                          }
                          type="checkbox"
                          onChange={(event) =>
                            onChange(
                              role.id,
                              permission.id,
                              event.target.checked,
                            )
                          }
                        />
                      </td>
                    )
                  })}
                </tr>
              )),
            ]
          })}
          <tr className="border-t-2 border-amber-200 bg-amber-50/60">
            <th
              className="sticky left-0 z-10 bg-amber-50 px-4 py-4"
              scope="row"
            >
              <span className="block text-sm font-semibold text-amber-950">
                {t('security.access.guestAssignable')}
              </span>
              <span className="mt-1 block text-xs font-medium leading-5 text-amber-900">
                {t('security.access.guestAssignableWarning')}
              </span>
            </th>
            {roles.map((role) => (
              <td className="px-4 py-4 text-center" key={role.id}>
                <input
                  aria-label={`${formatEnterpriseSecurityRoleName(role, t)}: ${t('security.access.guestAssignable')}`}
                  checked={
                    roleGuestAssignableDrafts[role.id] ?? role.guestAssignable
                  }
                  className="h-5 w-5 accent-[var(--workbench-primary)]"
                  disabled={
                    !canManage ||
                    role.kind !== 'custom' ||
                    roleExceedsGrantCeiling(role.id) ||
                    isBusy
                  }
                  type="checkbox"
                  onChange={(event) =>
                    onGuestAssignableChange(role.id, event.target.checked)
                  }
                />
              </td>
            ))}
          </tr>
        </tbody>
        {canManage && roles.some((role) => role.kind === 'custom') ? (
          <tfoot>
            <tr className="border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)]">
              <th className="sticky left-0 bg-[var(--workbench-surface-muted)] px-4 py-3 text-sm font-semibold text-[var(--workbench-muted)]">
                {t('security.access.saveCustomRoles')}
              </th>
              {roles.map((role) => (
                <td className="px-3 py-3 text-center" key={role.id}>
                  {role.kind === 'custom' ? (
                    <div className="grid justify-items-center gap-2">
                      <div className="flex justify-center gap-2">
                        <button
                          className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-55"
                          disabled={
                            isBusy ||
                            !canPreviewImpact ||
                            roleExceedsGrantCeiling(role.id) ||
                            (roleDrafts[role.id]?.length ?? 0) === 0
                          }
                          type="button"
                          onClick={() => void onSave(role)}
                        >
                          {t(
                            busyOperation === `role:update:${role.id}`
                              ? 'security.action.saving'
                              : 'security.access.saveRole',
                          )}
                        </button>
                        <button
                          className="workbench-button-secondary min-h-9 px-3 text-red-700 disabled:cursor-not-allowed disabled:opacity-55"
                          disabled={isBusy || !canPreviewImpact}
                          type="button"
                          onClick={() => void onDelete(role)}
                        >
                          {t('security.access.deleteRole')}
                        </button>
                      </div>
                      {roleExceedsGrantCeiling(role.id) ? (
                        <span className="max-w-[190px] text-xs font-semibold leading-5 text-slate-600">
                          {t('security.access.roleOutsideGrantCeiling')}
                        </span>
                      ) : (roleDrafts[role.id]?.length ?? 0) === 0 ? (
                        <span className="text-xs font-semibold text-amber-800">
                          {t('security.access.permissionRequired')}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                      {t('security.access.systemManaged')}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  )
}
