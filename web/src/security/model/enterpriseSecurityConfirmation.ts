import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  EnterpriseBreakGlassAdministrator,
  EnterpriseGroupRoleMapping,
  EnterpriseProvisioningImpact,
  EnterpriseRoleDefinition,
  EnterpriseRoleImpact,
  EnterpriseServiceAccount,
  EnterpriseSessionPolicyImpact,
  UpdateEnterpriseGroupRoleMappingInput,
  UpdateEnterpriseRoleInput,
  UpdateEnterpriseSessionPolicyInput,
} from '../api'

/**
 * 確認 dialog から実行する高影響 operation です。
 */
export type EnterpriseSecurityConfirmation =
  | {
      /** SSO enforcement 更新を表す discriminant です。 */
      kind: 'sso-enforcement'
      /** 更新後の enforcement 状態です。 */
      enforced: boolean
    }
  | {
      /** Provisioning apply を表す discriminant です。 */
      kind: 'provisioning'
      /** 適用する dry-run preview です。 */
      impact: EnterpriseProvisioningImpact
    }
  | {
      /** Caller IP 除外を伴う session policy 更新を表す discriminant です。 */
      kind: 'session-policy'
      /** 保存する session/security policy です。 */
      input: UpdateEnterpriseSessionPolicyInput
      /** Server が preview した caller IP impact です。 */
      impact: EnterpriseSessionPolicyImpact
    }
  | {
      /** SCIM credential rotate を表す discriminant です。 */
      kind: 'scim-token-rotate'
    }
  | {
      /** Service account credential rotate を表す discriminant です。 */
      kind: 'service-account-rotate'
      /** Credential を rotate する service account です。 */
      account: EnterpriseServiceAccount
    }
  | {
      /** Service account revoke を表す discriminant です。 */
      kind: 'service-account-revoke'
      /** Revoke する service account です。 */
      account: EnterpriseServiceAccount
    }
  | {
      /** Directory group mapping 削除を表す discriminant です。 */
      kind: 'mapping-delete'
      /** 削除する directory group mapping です。 */
      mapping: EnterpriseGroupRoleMapping
    }
  | {
      /** Directory group mapping 更新を表す discriminant です。 */
      kind: 'mapping-update'
      /** 更新する directory group mapping です。 */
      mapping: EnterpriseGroupRoleMapping
      /** 確認後に送る更新入力です。 */
      input: UpdateEnterpriseGroupRoleMappingInput
    }
  | {
      /** Break-glass administrator disable を表す discriminant です。 */
      kind: 'break-glass'
      /** 無効化する break-glass administrator です。 */
      administrator: EnterpriseBreakGlassAdministrator
    }
  | {
      /** Custom role 削除を表す discriminant です。 */
      kind: 'role-delete'
      /** 削除する custom role です。 */
      role: EnterpriseRoleDefinition
      /** 削除が assignment と mapping に与える影響です。 */
      impact: EnterpriseRoleImpact
    }
  | {
      /** Custom role permission 更新を表す discriminant です。 */
      kind: 'role-update'
      /** 更新する custom role です。 */
      role: EnterpriseRoleDefinition
      /** 確認後に送る更新入力です。 */
      input: UpdateEnterpriseRoleInput
      /** Permission 削除が assignment と mapping に与える影響です。 */
      impact: EnterpriseRoleImpact
    }

/**
 * Enterprise security confirmation dialog の表示 copy です。
 */
export type EnterpriseSecurityConfirmationCopy = {
  /** Dialog の見出しです。 */
  title: string
  /** 対象と影響を示す説明です。 */
  description: string
  /** 確定 button の文言です。 */
  confirmLabel: string
  /** 破壊的 operation として表示するかどうかです。 */
  destructive: boolean
}

/**
 * Builds localized dialog copy for a high-impact confirmation operation.
 *
 * @param confirmation - Operation that will be presented for confirmation.
 * @param t - Localized message resolver.
 * @returns Dialog title, description, confirmation label, and tone.
 */
export function createEnterpriseSecurityConfirmationCopy(
  confirmation: EnterpriseSecurityConfirmation,
  t: (key: MessageKey) => string,
): EnterpriseSecurityConfirmationCopy {
  if (confirmation.kind === 'sso-enforcement') {
    return {
      confirmLabel: t(
        confirmation.enforced
          ? 'security.identity.enableEnforcement'
          : 'security.identity.disableEnforcement',
      ),
      description: t(
        confirmation.enforced
          ? 'security.dialog.ssoEnableDescription'
          : 'security.dialog.ssoDisableDescription',
      ),
      destructive: true,
      title: t(
        confirmation.enforced
          ? 'security.dialog.ssoEnableTitle'
          : 'security.dialog.ssoDisableTitle',
      ),
    }
  }

  if (confirmation.kind === 'provisioning') {
    const totalChanges = Object.values(confirmation.impact.counts).reduce(
      (total, count) => total + count,
      0,
    )

    return {
      confirmLabel: t('security.provisioning.apply'),
      description: t('security.dialog.provisioningDescription').replace(
        '{count}',
        String(totalChanges),
      ),
      destructive: true,
      title: t('security.dialog.provisioningTitle'),
    }
  }

  if (confirmation.kind === 'session-policy') {
    return {
      confirmLabel: t('security.dialog.sessionPolicyConfirm'),
      description: t('security.dialog.sessionPolicyDescription').replace(
        '{ip}',
        confirmation.impact.callerIp ||
          t('security.dialog.sessionPolicyUnknownIp'),
      ),
      destructive: true,
      title: t('security.dialog.sessionPolicyTitle'),
    }
  }

  if (confirmation.kind === 'scim-token-rotate') {
    return {
      confirmLabel: t('security.provisioning.rotateToken'),
      description: t('security.dialog.scimRotateDescription'),
      destructive: true,
      title: t('security.dialog.scimRotateTitle'),
    }
  }

  if (confirmation.kind === 'service-account-rotate') {
    return {
      confirmLabel: t('security.privileged.rotateCredential'),
      description: t('security.dialog.serviceAccountRotateDescription').replace(
        '{name}',
        confirmation.account.name,
      ),
      destructive: true,
      title: t('security.dialog.serviceAccountRotateTitle'),
    }
  }

  if (confirmation.kind === 'service-account-revoke') {
    return {
      confirmLabel: t('security.privileged.revoke'),
      description: t('security.dialog.serviceAccountDescription').replace(
        '{name}',
        confirmation.account.name,
      ),
      destructive: true,
      title: t('security.dialog.serviceAccountTitle'),
    }
  }

  if (confirmation.kind === 'mapping-delete') {
    return {
      confirmLabel: t('security.action.remove'),
      description: t('security.dialog.mappingDeleteDescription')
        .replace('{group}', confirmation.mapping.directoryGroupName)
        .replace('{scope}', confirmation.mapping.scopeName)
        .replace('{role}', confirmation.mapping.roleId),
      destructive: true,
      title: t('security.dialog.mappingDeleteTitle'),
    }
  }

  if (confirmation.kind === 'mapping-update') {
    return {
      confirmLabel: t('security.action.save'),
      description: t('security.dialog.mappingUpdateDescription')
        .replace('{group}', confirmation.mapping.directoryGroupName)
        .replace('{scope}', confirmation.input.scopeName)
        .replace('{role}', confirmation.input.roleId),
      destructive: true,
      title: t('security.dialog.mappingUpdateTitle'),
    }
  }

  if (confirmation.kind === 'break-glass') {
    return {
      confirmLabel: t('security.privileged.deactivate'),
      description: t('security.dialog.breakGlassDescription').replace(
        '{email}',
        confirmation.administrator.email,
      ),
      destructive: true,
      title: t('security.dialog.breakGlassTitle'),
    }
  }

  if (confirmation.kind === 'role-update') {
    if (confirmation.input.guestAssignable !== confirmation.role.guestAssignable) {
      return {
        confirmLabel: t('security.access.saveRole'),
        description: t(
          confirmation.input.guestAssignable
            ? 'security.dialog.roleGuestEnableDescription'
            : 'security.dialog.roleGuestDisableDescription',
        ).replace('{name}', confirmation.role.name),
        destructive: true,
        title: t('security.dialog.roleGuestTitle'),
      }
    }

    return {
      confirmLabel: t('security.access.saveRole'),
      description: t('security.dialog.roleUpdateDescription')
        .replace('{name}', confirmation.role.name)
        .replace(
          '{permissions}',
          String(confirmation.impact.removedPermissionIds.length),
        )
        .replace('{assignments}', String(confirmation.impact.assignmentCount))
        .replace('{mappings}', String(confirmation.impact.mappingCount))
        .replace(
          '{serviceAccounts}',
          String(confirmation.impact.serviceAccountCount),
        ),
      destructive: true,
      title: t('security.dialog.roleUpdateTitle'),
    }
  }

  return {
    confirmLabel: t('security.access.deleteRole'),
    description: t('security.dialog.roleDescription')
      .replace('{name}', confirmation.role.name)
      .replace('{assignments}', String(confirmation.impact.assignmentCount))
      .replace('{mappings}', String(confirmation.impact.mappingCount))
      .replace(
        '{serviceAccounts}',
        String(confirmation.impact.serviceAccountCount),
      ),
    destructive: true,
    title: t('security.dialog.roleTitle'),
  }
}
