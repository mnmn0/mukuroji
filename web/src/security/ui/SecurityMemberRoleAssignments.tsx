import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  CreateEnterpriseMemberRoleAssignmentInput,
  EnterpriseMemberRoleAssignment,
  EnterpriseSecuritySnapshot,
} from '../api'
import { formatEnterpriseSecurityRoleName } from '../model/enterpriseSecurityDisplay'
import {
  createEnterpriseSecurityScopeValue,
  type EnterpriseSecurityScopeOption,
} from '../model/enterpriseSecurityForms'
import {
  EnterpriseSecurityEmptyState,
  EnterpriseSecuritySectionHeader,
} from './EnterpriseSecurityFields'

/**
 * Renders the roles assigned to individual members and the form that adds one.
 *
 * @param props - Security snapshot, scope options, mutations, and localized copy.
 * @returns The member role assignment section of the access tab.
 */
export function SecurityMemberRoleAssignments({
  busyOperation,
  scopeOptions,
  snapshot,
  t,
  onCreateMemberRoleAssignment,
  onDeleteMemberRoleAssignment,
}: {
  busyOperation?: string
  scopeOptions: EnterpriseSecurityScopeOption[]
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onCreateMemberRoleAssignment?: (
    input: CreateEnterpriseMemberRoleAssignmentInput,
  ) => Promise<unknown>
  onDeleteMemberRoleAssignment?: (
    assignment: EnterpriseMemberRoleAssignment,
  ) => Promise<unknown>
}) {
  const canManage =
    snapshot.capabilities.canManageMappings &&
    onCreateMemberRoleAssignment !== undefined
  const isBusy = Boolean(busyOperation)
  const assignableMembers = snapshot.members.filter(
    (member) => member.role !== 'owner',
  )
  const [memberKey, setMemberKey] = useState('')
  const [scopeValue, setScopeValue] = useState('')
  const [roleId, setRoleId] = useState('')
  const [parentTeamId, setParentTeamId] = useState('')
  const selectedMember = assignableMembers.find(
    (member) => member.memberKey === memberKey,
  )
  const defaultScope = scopeOptions[0]
  const selectedScope =
    scopeOptions.find(
      (scope) => createEnterpriseSecurityScopeValue(scope) === scopeValue,
    ) ?? defaultScope
  const assignableRoleIds = new Set(
    selectedScope ? snapshot.assignableRoleIds.members[selectedScope.type] : [],
  )
  const availableRoles = snapshot.roles.filter(
    (role) =>
      assignableRoleIds.has(role.id) &&
      (selectedMember?.role !== 'guest' || role.guestAssignable),
  )
  const selectedRoleId = availableRoles.some((role) => role.id === roleId)
    ? roleId
    : ''
  // A Project shared by several Teams needs the owning Team that the assignment applies under.
  const owningTeams =
    selectedScope?.type === 'project' && (selectedScope.parentIds?.length ?? 0) > 1
      ? (selectedScope.parentIds ?? []).map((teamId) => ({
          id: teamId,
          name:
            scopeOptions.find(
              (scope) => scope.type === 'team' && scope.id === teamId,
            )?.name ?? teamId,
        }))
      : []
  const selectedParentTeamId = owningTeams.some((team) => team.id === parentTeamId)
    ? parentTeamId
    : ''

  /** Sends the selected member, scope, and role to the create API. */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (
      !canManage ||
      !selectedMember ||
      !selectedScope ||
      !selectedRoleId ||
      (owningTeams.length > 0 && !selectedParentTeamId) ||
      isBusy
    ) {
      return
    }

    try {
      await onCreateMemberRoleAssignment({
        memberKey: selectedMember.memberKey,
        roleId: selectedRoleId,
        scopeId: selectedScope.id,
        scopeType: selectedScope.type,
        ...(selectedParentTeamId ? { scopeParentId: selectedParentTeamId } : {}),
      })
      setRoleId('')
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  /**
   * Formats the member that holds an assignment.
   *
   * @param assignment - Assignment to label.
   * @returns The member name and email, or the member key of a former member.
   */
  const formatMember = (assignment: EnterpriseMemberRoleAssignment) => {
    const member = snapshot.members.find(
      (candidate) => candidate.memberKey === assignment.memberKey,
    )
    if (!member) return assignment.memberKey
    return member.name ? `${member.name} (${member.email})` : member.email
  }

  /**
   * Formats the scope of an assignment with the directory names the screen loaded.
   *
   * @param assignment - Assignment to label.
   * @returns The localized scope type and name.
   */
  const formatScope = (assignment: EnterpriseMemberRoleAssignment) => {
    const scope = scopeOptions.find((candidate) =>
      assignment.scopeType === 'workspace'
        ? candidate.type === 'workspace'
        : candidate.type === assignment.scopeType &&
          candidate.id === assignment.scopeId,
    )
    return `${t(`security.scope.${assignment.scopeType}`)} · ${scope?.name ?? assignment.scopeId}`
  }

  return (
    <section
      className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-surface"
      data-testid="security-member-assignments"
    >
      <EnterpriseSecuritySectionHeader
        description={t('security.access.memberAssignmentsDescription')}
        title={t('security.access.memberAssignmentsTitle')}
      />
      {canManage ? (
        <form
          className={`grid ${owningTeams.length > 0 ? 'grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_minmax(160px,0.8fr)_minmax(160px,0.8fr)_auto]' : 'grid-cols-[minmax(200px,1fr)_minmax(200px,1fr)_minmax(180px,0.8fr)_auto]'} items-end gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4 max-[1240px]:grid-cols-2 max-[640px]:grid-cols-1`}
          data-testid="security-member-assignment-form"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('security.access.member')}
            <select
              className="workbench-input min-h-10 px-3"
              disabled={isBusy || assignableMembers.length === 0}
              required
              value={selectedMember ? memberKey : ''}
              onChange={(event) => {
                setMemberKey(event.target.value)
                setRoleId('')
              }}
            >
              <option disabled value="">
                {t('security.access.selectMember')}
              </option>
              {assignableMembers.map((member) => (
                <option key={member.memberKey} value={member.memberKey}>
                  {member.name ? `${member.name} (${member.email})` : member.email}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('security.access.scope')}
            <select
              className="workbench-input min-h-10 px-3"
              disabled={isBusy || scopeOptions.length === 0}
              required
              value={
                selectedScope
                  ? createEnterpriseSecurityScopeValue(selectedScope)
                  : ''
              }
              onChange={(event) => {
                setScopeValue(event.target.value)
                setRoleId('')
                setParentTeamId('')
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
          {owningTeams.length > 0 ? (
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('security.access.owningTeam')}
              <select
                className="workbench-input min-h-10 px-3"
                disabled={isBusy}
                required
                value={selectedParentTeamId}
                onChange={(event) => setParentTeamId(event.target.value)}
              >
                <option disabled value="">
                  {t('security.access.selectOwningTeam')}
                </option>
                {owningTeams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('security.access.role')}
            <select
              className="workbench-input min-h-10 px-3"
              disabled={isBusy || availableRoles.length === 0}
              required
              value={selectedRoleId}
              onChange={(event) => setRoleId(event.target.value)}
            >
              <option disabled value="">
                {t('security.access.selectRole')}
              </option>
              {availableRoles.map((role) => (
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
              !selectedMember ||
              !selectedScope ||
              !selectedRoleId ||
              (owningTeams.length > 0 && !selectedParentTeamId)
            }
            type="submit"
          >
            {t('security.access.addMemberAssignment')}
          </button>
        </form>
      ) : null}
      <div className="overflow-x-auto border-t border-[var(--workbench-border)]">
        <table
          className="w-full min-w-[720px] border-collapse text-left"
          data-testid="security-member-assignment-table"
        >
          <thead>
            <tr className="workbench-table-head">
              <th className="px-4 py-3" scope="col">
                {t('security.access.column.member')}
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
            {snapshot.memberRoleAssignments.map((assignment) => {
              const role = snapshot.roles.find(
                (candidate) => candidate.id === assignment.roleId,
              )
              const memberLabel = formatMember(assignment)
              return (
                <tr
                  className="border-t border-[var(--workbench-border)] text-sm"
                  key={assignment.id}
                >
                  <td className="px-4 py-4 font-semibold">{memberLabel}</td>
                  <td className="px-4 py-4">{formatScope(assignment)}</td>
                  <td className="px-4 py-4">
                    {role
                      ? formatEnterpriseSecurityRoleName(role, t)
                      : assignment.roleId}
                  </td>
                  <td className="px-4 py-4 text-right">
                    {canManage && onDeleteMemberRoleAssignment ? (
                      <button
                        aria-label={`${t('security.action.remove')}: ${memberLabel}`}
                        className="workbench-button-secondary min-h-9 px-3 text-fg-red-700 disabled:cursor-not-allowed disabled:opacity-55"
                        disabled={isBusy}
                        type="button"
                        onClick={() =>
                          void onDeleteMemberRoleAssignment(assignment).catch(
                            () => undefined,
                          )
                        }
                      >
                        {t('security.action.remove')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {snapshot.memberRoleAssignments.length === 0 ? (
          <EnterpriseSecurityEmptyState
            text={t('security.access.memberAssignmentsEmpty')}
          />
        ) : null}
      </div>
    </section>
  )
}
