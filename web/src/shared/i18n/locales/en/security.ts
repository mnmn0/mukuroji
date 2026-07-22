/**
 * English messages for the security domain.
 */
export const securityMessages = {
  'security.recovery.header': 'Security recovery',
  'security.recovery.eyebrow': 'Emergency access',
  'security.recovery.title': 'Recover administrative access safely',
  'security.recovery.description':
    'When the normal administration path is unavailable, a pre-registered emergency administrator can elevate access for a short, controlled window.',
  'security.recovery.step.verify.title': 'Verify identity and session',
  'security.recovery.step.verify.description':
    'Recovery can start only from a session that satisfies multi-factor and recent reauthentication checks.',
  'security.recovery.step.audit.title': 'Record a specific reason',
  'security.recovery.step.audit.description':
    'The reason, actor, start time, and expiry are recorded for later audit review.',
  'security.recovery.step.expire.title': 'Expire after the minimum time',
  'security.recovery.step.expire.description':
    'Elevation ends automatically after the selected window and your normal permissions resume.',
  'security.recovery.form.label': 'Break-glass activation',
  'security.recovery.form.title': 'Start recovery access',
  'security.recovery.warning.title': 'Use only for an emergency',
  'security.recovery.warning.description':
    'This action temporarily grants powerful administrative access and is audited.',
  'security.recovery.reason': 'Reason recovery is required',
  'security.recovery.reasonPlaceholder':
    'Example: Restore the SSO configuration and resume normal administrator access',
  'security.recovery.reasonHelp':
    'Enter at least 10 characters. The reason is saved in the audit log.',
  'security.recovery.duration': 'Access window',
  'security.recovery.duration.five': '5 min',
  'security.recovery.duration.fifteen': '15 min',
  'security.recovery.duration.thirty': '30 min',
  'security.recovery.durationHelp':
    'Choose the shortest window needed to complete the recovery.',
  'security.recovery.activate': 'Start recovery access',
  'security.recovery.activating': 'Verifying and starting…',
  'security.recovery.reauthenticate':
    'Sign in again to verify identity',
  'security.recovery.cancel': 'Return to dashboard',
  'security.recovery.error.reason': 'Enter a recovery reason of at least 10 characters.',
  'security.recovery.error.denied':
    'This account is not pre-registered as an emergency administrator. Contact another recovery owner.',
  'security.recovery.error.mfa':
    'Multi-factor authentication could not be verified. Sign in again using MFA.',
  'security.recovery.error.reauthentication':
    'Recent identity verification is required. Sign in again, then retry.',
  'security.recovery.error.duration':
    'That access window is not allowed for this emergency administrator. Choose a shorter window.',
  'security.recovery.error.session':
    'Your login session could not be verified. Sign in again.',
  'security.recovery.error.unknown':
    'Recovery access could not be started. Check your connection and try again.',
  'security.recovery.active.title': 'Emergency recovery access is active',
  'security.recovery.active.description':
    'It expires automatically at {time}. End it early as soon as recovery work is complete.',
  'security.recovery.active.revoke': 'End access now',
  'security.recovery.active.revoking': 'Ending access…',
  'security.page.eyebrow': 'Enterprise administration',
  'security.page.title': 'Identity and security',
  'security.page.description':
    'Manage organization authentication, provisioning, access controls, sessions, and emergency access in one place.',
  'security.eyebrow': 'Enterprise security',
  'security.title': 'Organization security controls',
  'security.description':
    'Operate identity lifecycle and privileged access safely with prerequisites and impact shown before each change.',
  'security.tabsAria': 'Enterprise security settings',
  'security.tab.overview': 'Overview',
  'security.tab.identity': 'Identity',
  'security.tab.provisioning': 'Provisioning',
  'security.tab.access': 'Mappings and roles',
  'security.tab.sessions': 'Sessions',
  'security.tab.privileged': 'Privileged',
  'security.mode.admin': 'Can manage',
  'security.mode.readOnly': 'Read-only',
  'security.readOnly':
    'These settings are read-only. Enterprise security administration permission is required to make changes.',
  'security.action.retryLoad': 'Reload',
  'security.action.refresh': 'Refresh state',
  'security.action.testing': 'Saving and testing',
  'security.action.rotating': 'Rotating',
  'security.action.previewing': 'Checking impact',
  'security.action.retrying': 'Retrying',
  'security.action.remove': 'Remove',
  'security.action.saving': 'Saving',
  'security.action.save': 'Save',
  'security.action.close': 'Close',
  'security.action.working': 'Working',
  'security.action.cancel': 'Cancel',
  'security.action.copy': 'Copy',
  'security.action.copied': 'Copied',
  'security.action.signInAgain': 'Verify identity again',
  'security.action.recoverAccess': 'Continue to recovery',
  'security.error.load': 'Could not load enterprise security settings.',
  'security.error.stale':
    'The displayed state may be stale. Refresh before making changes.',
  'security.error.forbidden': 'You do not have permission to perform this action.',
  'security.error.authenticationRequired':
    'Your session expiry, MFA, or reauthentication policy requires identity verification again. Temporary credentials were cleared from this screen for safety.',
  'security.error.ipDenied':
    'Your current network is not in the Workspace IP allowlist. Switch to an approved network, then reload.',
  'security.error.ipDeniedRecovery':
    'Your current network is not in the Workspace IP allowlist. Switch to an approved network, or continue to recovery as a pre-registered emergency administrator.',
  'security.error.conflict':
    'Another administrator updated these settings. Refresh and try again.',
  'security.error.invalid': 'Review the input and try again.',
  'security.error.prerequisite':
    'A safety prerequisite is missing. Review the readiness checklist.',
  'security.error.operation': 'Could not update security settings.',
  'security.error.refreshAfterMutation':
    'The change was applied, but the latest state could not be loaded. Refresh the state.',
  'security.error.refreshAfterCredential':
    'The credential was issued, but the latest state could not be loaded. Save the displayed credential securely, then refresh the state.',
  'security.value.notConfigured': 'Not configured',
  'security.value.none': 'None',
  'security.value.never': 'Never',
  'security.unit.minutes': 'minutes',
  'security.unit.days': 'days',
  'security.overview.metric.sso': 'SSO enforcement',
  'security.overview.metric.scim': 'SCIM',
  'security.overview.metric.provisioningErrors': 'Sync attention',
  'security.overview.metric.privileged': 'Privileged paths',
  'security.overview.enforced': 'Enforced',
  'security.overview.notEnforced': 'Optional',
  'security.overview.privilegedCount':
    '{service} service · {breakGlass} emergency',
  'security.overview.readinessEyebrow': 'Safe enablement',
  'security.overview.readinessTitle': 'SSO enforcement readiness',
  'security.overview.readinessDescription':
    'Require a tested connection, verified domain, and emergency administrator before enforcing SSO for managed domains.',
  'security.overview.card.identityTitle': 'Review identity connections',
  'security.overview.card.identityDescription':
    'Check the IdP, managed domains, and prerequisites for SSO enforcement.',
  'security.overview.card.provisioningTitle': 'Review sync impact',
  'security.overview.card.provisioningDescription':
    'Manage the SCIM token, dry-run changes, failed logs, and retries.',
  'security.overview.card.sessionsTitle': 'Control sessions',
  'security.overview.card.sessionsDescription':
    'Set MFA, lifetime, reauthentication, network, and guest limits.',
  'security.overview.open': 'Open',
  'security.prerequisite.ready': 'Ready to enable',
  'security.prerequisite.actionRequired': 'Action required',
  'security.prerequisite.identity': 'The IdP connection test has succeeded',
  'security.prerequisite.domain': 'At least one domain is verified',
  'security.prerequisite.breakGlass':
    'An active emergency administrator has MFA configured',
  'security.prerequisite.complete': 'Complete',
  'security.prerequisite.incomplete': 'Incomplete',
  'security.prerequisite.unavailable':
    'Status unavailable with current access',
  'security.identity.status.not-configured': 'Not configured',
  'security.identity.status.draft': 'Draft',
  'security.identity.status.verified': 'Connection verified',
  'security.identity.status.error': 'Needs attention',
  'security.identity.providerTitle': 'Identity provider',
  'security.identity.providerDescription':
    'Save public SAML or OIDC settings and verify availability with a connection test.',
  'security.identity.protocol': 'Protocol',
  'security.identity.displayName': 'Display name',
  'security.identity.issuer': 'Issuer / Entity ID',
  'security.identity.metadataUrl': 'SAML metadata URL',
  'security.identity.metadataUrlHelp':
    'The connection test fetches metadata XML over HTTPS and verifies the entity ID, SSO URL, and signing certificate.',
  'security.identity.ssoUrl': 'SSO URL',
  'security.identity.clientId': 'Client ID / Audience',
  'security.identity.saveAndTest': 'Save and test connection',
  'security.identity.lastTested': 'Last connection test: {date}',
  'security.identity.domainsTitle': 'Managed domains',
  'security.identity.domainsDescription':
    'Verify ownership with a DNS TXT record and make the SSO boundary explicit.',
  'security.identity.domainLabel': 'Domain',
  'security.identity.claimDomain': 'Add domain',
  'security.identity.verifyDomain': 'Verify ownership',
  'security.identity.domainsEmpty': 'No managed domains yet.',
  'security.identity.verificationRecordName': 'TXT record name',
  'security.domainChallenge.title': 'DNS verification for {domain}',
  'security.domainChallenge.description':
    'This TXT value will not be shown again. Store it securely until it is configured in DNS.',
  'security.domainChallenge.recordName': 'TXT record name',
  'security.domainChallenge.recordValue': 'TXT value (shown once)',
  'security.domain.status.pending': 'Pending',
  'security.domain.status.verified': 'Verified',
  'security.domain.status.conflict': 'Conflict',
  'security.identity.enforcementTitle': 'SSO enforcement',
  'security.identity.enforcementDescription':
    'Standardize managed-domain sign-in through the IdP. Establish an emergency path first.',
  'security.identity.enforcementReady':
    'All prerequisites are complete. Review the impact before enforcing SSO.',
  'security.identity.enforcementBlocked':
    'Complete the missing checklist items before enforcement can be enabled.',
  'security.identity.disableEnforcement': 'Disable enforcement',
  'security.identity.enableEnforcement': 'Enforce SSO',
  'security.scim.status.disabled': 'Disabled',
  'security.scim.status.ready': 'Ready',
  'security.scim.status.syncing': 'Syncing',
  'security.scim.status.error': 'Needs attention',
  'security.provisioning.scimTitle': 'SCIM connection',
  'security.provisioning.scimDescription':
    'Review the endpoint shared with the IdP and safe metadata for the stored credential.',
  'security.provisioning.endpoint': 'Endpoint',
  'security.provisioning.tokenGeneration': 'Token',
  'security.provisioning.generation':
    'Generation {generation} · ending {lastFour}',
  'security.provisioning.lastSync': 'Last sync',
  'security.provisioning.tokenHelp':
    'A new token is shown only once. Be ready to store it securely in the IdP before issuing it.',
  'security.provisioning.rotateToken': 'Rotate token',
  'security.provisioning.createToken': 'Issue token',
  'security.provisioning.scimTokenLabel': 'SCIM bearer token',
  'security.provisioning.reconcileTitle': 'Directory reconciliation',
  'security.provisioning.reconcileDescription':
    'Run a dry-run before applying changes and review creates, updates, deactivations, and session revocations.',
  'security.provisioning.dryRunTitle': 'Preview without changing data',
  'security.provisioning.dryRunDescription':
    'Compare current directory state with the workspace and create a short-lived preview.',
  'security.provisioning.preview': 'Run dry-run',
  'security.provisioning.logsTitle': 'Run logs',
  'security.provisioning.logsDescription':
    'Review secret-free sync history and correlation IDs.',
  'security.provisioning.logStatus.pending': 'Pending',
  'security.provisioning.logStatus.running': 'Running',
  'security.provisioning.logStatus.succeeded': 'Succeeded',
  'security.provisioning.logStatus.partial': 'Partial',
  'security.provisioning.logStatus.failed': 'Failed',
  'security.provisioning.summary.pending':
    'The provisioning operation is waiting to run.',
  'security.provisioning.summary.running':
    'The provisioning operation is running.',
  'security.provisioning.summary.succeeded':
    'The provisioning operation completed.',
  'security.provisioning.summary.partial':
    'Part of the provisioning operation needs attention.',
  'security.provisioning.summary.failed':
    'The provisioning operation failed. Review the audit log for details.',
  'security.provisioning.operation.scim': 'SCIM',
  'security.provisioning.operation.dry-run': 'Dry-run',
  'security.provisioning.operation.reconcile': 'Reconcile',
  'security.provisioning.operation.deprovision': 'Deprovision',
  'security.provisioning.attempts': '{count} attempts',
  'security.provisioning.retry': 'Retry',
  'security.provisioning.logsEmpty': 'No run logs yet.',
  'security.provisioning.impactTitle': 'Changes to apply',
  'security.provisioning.previewExpires': 'Preview expires: {date}',
  'security.provisioning.previewExpired':
    'This preview has expired. Run the dry-run again before applying changes.',
  'security.provisioning.previewExpiredAction': 'Expired · preview again',
  'security.provisioning.previewBlocked':
    'This preview cannot be applied because it affects protected access. Exclude the warned entries from the directory change and run the dry-run again.',
  'security.provisioning.previewBlockedAction':
    'Resolve protected-access impact',
  'security.provisioning.blockingChanges': 'Blocked',
  'security.provisioning.warningSummary':
    'This preview contains {count} impacts that need review. Check the counts and protection state, then use the audit log for details.',
  'security.provisioning.changesFound': 'Changes found',
  'security.provisioning.noChanges': 'No changes',
  'security.provisioning.impact.usersCreated': 'Users created',
  'security.provisioning.impact.usersUpdated': 'Users updated',
  'security.provisioning.impact.usersDeactivated': 'Users deactivated',
  'security.provisioning.impact.groupsCreated': 'Groups created',
  'security.provisioning.impact.groupsUpdated': 'Groups updated',
  'security.provisioning.impact.sessionsRevoked': 'Sessions revoked',
  'security.provisioning.apply': 'Apply this change set',
  'security.access.mappingsTitle': 'Directory group mappings',
  'security.access.mappingsDescription':
    'Map IdP groups deterministically to workspace, team, or project roles.',
  'security.access.directoryGroupName': 'Directory group name',
  'security.access.directoryGroupId': 'Directory group ID',
  'security.access.scope': 'Scope',
  'security.access.role': 'Role',
  'security.access.selectRole': 'Select a role',
  'security.access.addMapping': 'Add mapping',
  'security.scope.workspace': 'Workspace',
  'security.scope.team': 'Team',
  'security.scope.project': 'Project',
  'security.access.column.group': 'Directory group',
  'security.access.column.scope': 'Scope',
  'security.access.column.role': 'Role',
  'security.access.column.action': 'Action',
  'security.access.mappingsEmpty': 'No group mappings yet.',
  'security.access.rolesTitle': 'Roles and permissions',
  'security.access.rolesDescription':
    'Compare permissions by purpose. Only custom roles can be edited.',
  'security.access.roleName': 'Role name',
  'security.access.roleDescription': 'Description',
  'security.access.rolePermissions': 'Permissions to grant',
  'security.access.permissionRequired': 'Select at least one permission.',
  'security.access.permissionGrantCeilingHelp':
    'You can grant only permissions you currently hold. Permissions outside that ceiling are disabled.',
  'security.access.permissionOutsideGrantCeiling':
    'You do not currently have authority to grant this permission to a role.',
  'security.access.roleOutsideGrantCeiling':
    'This role includes permissions outside your grant ceiling and cannot be edited.',
  'security.access.guestAssignable': 'Allow assignment to guests',
  'security.access.guestAssignableWarning':
    'When enabled, external guests can receive every permission in this role. Review the guest policy and permission set first.',
  'security.access.createRole': 'Create custom role',
  'security.access.permission': 'Permission',
  'security.access.privilegedPermission': 'Privileged',
  'security.access.saveCustomRoles': 'Save custom role changes',
  'security.access.saveRole': 'Save',
  'security.access.deleteRole': 'Delete',
  'security.access.roleInUse': 'Assigned roles cannot be deleted.',
  'security.access.roleImpactBlocked':
    'This role is referenced by {assignments} direct assignments, {mappings} group mappings, and {serviceAccounts} service accounts. Remove those references before deleting it.',
  'security.access.systemManaged': 'System managed',
  'security.role.kind.built-in': 'Built-in',
  'security.role.kind.custom': 'Custom',
  'security.role.name.workspaceOwner': 'Workspace owner',
  'security.role.name.workspaceAdmin': 'Workspace administrator',
  'security.role.name.workspaceMember': 'Workspace member',
  'security.role.name.workspaceGuest': 'Guest',
  'security.role.name.teamManager': 'Team manager',
  'security.role.name.teamMember': 'Team member',
  'security.role.name.projectManager': 'Project manager',
  'security.role.name.projectMember': 'Project member',
  'security.role.name.projectViewer': 'Project viewer',
  'security.permission.localizedName': '{action} {resource}',
  'security.permission.localizedDescription':
    'Grants the “{permission}” permission.',
  'security.permission.resource.workspace': 'workspace',
  'security.permission.resource.members': 'members',
  'security.permission.resource.teams': 'teams',
  'security.permission.resource.projects': 'projects',
  'security.permission.resource.workItems': 'work items',
  'security.permission.resource.files': 'files',
  'security.permission.resource.requests': 'requests',
  'security.permission.resource.planning': 'planning',
  'security.permission.resource.automation': 'automation',
  'security.permission.resource.audit': 'audit log',
  'security.permission.resource.identity': 'identity',
  'security.permission.resource.security': 'security',
  'security.permission.resource.serviceAccounts': 'service accounts',
  'security.permission.resource.content': 'content',
  'security.permission.action.read': 'View',
  'security.permission.action.write': 'Edit',
  'security.permission.action.manage': 'Manage',
  'security.permission.action.approve': 'Approve',
  'security.permission.action.export': 'Export',
  'security.permission.action.use': 'Use',
  'security.permission.action.configure': 'Configure',
  'security.permissionGroup.workspace': 'Workspace',
  'security.permissionGroup.members': 'Members',
  'security.permissionGroup.content': 'Content',
  'security.permissionGroup.security': 'Security',
  'security.permissionGroup.automation': 'Automation',
  'security.sessions.authenticationTitle': 'Authentication and sessions',
  'security.sessions.authenticationDescription':
    'Set explicit units and limits for standard sessions and sensitive-operation reauthentication.',
  'security.sessions.mfaRequired': 'Require MFA',
  'security.sessions.mfaDescription':
    'Require multi-factor authentication for human workspace members.',
  'security.sessions.lifetime': 'Session lifetime',
  'security.sessions.lifetimeDescription':
    'Absolute time from sign-in until the session ends.',
  'security.sessions.idleTimeout': 'Idle timeout',
  'security.sessions.idleTimeoutDescription':
    'Time without activity before an interactive session ends.',
  'security.sessions.reauthentication': 'Standard reauthentication',
  'security.sessions.reauthenticationDescription':
    'Time before a standard session requires identity verification again.',
  'security.sessions.sensitiveReauthentication':
    'Sensitive-action reauthentication',
  'security.sessions.sensitiveReauthenticationDescription':
    'Time before security settings and other sensitive actions require verification again.',
  'security.sessions.unitHelpTitle': 'How the time settings relate',
  'security.sessions.unitHelpDescription':
    'Idle and standard reauthentication must not exceed session lifetime; sensitive reauthentication must not exceed standard reauthentication.',
  'security.sessions.reauthenticationError':
    'Review the relationship between session, idle, standard, and sensitive-action intervals.',
  'security.sessions.networkTitle': 'Network boundary',
  'security.sessions.networkDescription':
    'Enter one IPv4 or IPv6 CIDR per line to control workspace access.',
  'security.sessions.ipAllowlist': 'IP allowlist',
  'security.sessions.ipAllowlistHelp':
    'Leave blank for no restriction. Confirm your current network will remain allowed.',
  'security.sessions.guestsTitle': 'Guests and external collaborators',
  'security.sessions.guestsDescription':
    'Limit guest availability, session duration, and allowed email domains.',
  'security.sessions.guestsAllowed': 'Allow guests',
  'security.sessions.guestsAllowedDescription':
    'External collaborators with limited roles can join the workspace.',
  'security.sessions.externalCollaboratorsAllowed':
    'Allow external collaborators',
  'security.sessions.externalCollaboratorsAllowedDescription':
    'Members outside verified domains can join the workspace. This is controlled separately from guests.',
  'security.sessions.guestSessionLifetime': 'Guest session lifetime',
  'security.sessions.guestSessionLifetimeDescription':
    'Maximum duration of a guest interactive session. This is not an account expiration.',
  'security.sessions.allowedGuestDomains': 'Allowed guest domains',
  'security.sessions.allowedGuestDomainsHelp':
    'Enter allowed lowercase domains for guests and external collaborators, one per line. Leave blank for no domain restriction.',
  'security.sessions.save': 'Save security policy',
  'security.privileged.serviceAccountsTitle': 'Service accounts',
  'security.privileged.serviceAccountsDescription':
    'Give non-human principals a least-privilege role and credential isolated from interactive sessions.',
  'security.privileged.serviceAccountName': 'Service account name',
  'security.privileged.serviceAccountScope': 'Allowed resource scope',
  'security.privileged.selectScope': 'Select a scope',
  'security.privileged.selectRole': 'Select a role',
  'security.privileged.role': 'Least-privilege role',
  'security.privileged.credentialLifetime': 'Credential lifetime',
  'security.privileged.credentialLifetimeHelp':
    'Absolute lifetime from 1 to 365 days, retained after rotation.',
  'security.privileged.allowedSourceCidrs': 'Allowed source CIDRs',
  'security.privileged.allowedSourceCidrsHelp':
    'Enter one CIDR per line. Leave blank to allow any source network.',
  'security.privileged.impactSummary': 'Access boundary to create',
  'security.privileged.impactSummaryDescription':
    'Scope: {scope}. The credential expires after {days} days. Source: {source}',
  'security.privileged.serviceAccountScopeValue': 'Scope: {scope}',
  'security.privileged.credentialExpires': 'Credential expires: {date}',
  'security.privileged.sourceCidrsRestricted':
    'Restricted to {count} source CIDRs',
  'security.privileged.sourceCidrsUnrestricted':
    'No source network restriction',
  'security.privileged.createServiceAccount': 'Create account',
  'security.privileged.credentialGeneration': 'Credential generation {generation}',
  'security.privileged.lastUsed': 'Last used: {date}',
  'security.privileged.rotateCredential': 'Rotate credential',
  'security.privileged.revoke': 'Revoke',
  'security.privileged.serviceAccountsEmpty': 'No service accounts yet.',
  'security.service.status.active': 'Active',
  'security.service.status.revoked': 'Revoked',
  'security.privileged.breakGlassTitle': 'Emergency administrators',
  'security.privileged.breakGlassDescription':
    'Pre-register a recovery operator outside verified domains. SSO enforcement requires MFA and an access test within 30 days.',
  'security.privileged.recoveryOnly': 'Emergency only',
  'security.privileged.breakGlassEmail': 'Emergency administrator email',
  'security.privileged.registerBreakGlass': 'Register administrator',
  'security.privileged.testBreakGlass': 'Test current recovery access',
  'security.privileged.testingBreakGlass': 'Testing recovery access',
  'security.privileged.mfaConfigured': 'MFA configured',
  'security.privileged.mfaRequired': 'MFA setup required',
  'security.privileged.lastTested': 'Last tested: {date}',
  'security.privileged.deactivate': 'Deactivate',
  'security.privileged.breakGlassEmpty':
    'No emergency administrator is configured.',
  'security.breakGlass.status.active': 'Active',
  'security.breakGlass.status.disabled': 'Disabled',
  'security.secret.title': 'Secret shown only now',
  'security.secret.scimDescription':
    'This SCIM token cannot be shown again. Store it securely in the IdP now.',
  'security.secret.serviceAccountDescription':
    'This service account token cannot be shown again. Store it in your secrets manager now.',
  'security.dialog.retryHint':
    'The change was not confirmed. Refresh state before trying again.',
  'security.dialog.ssoEnableTitle': 'Enforce SSO?',
  'security.dialog.ssoEnableDescription':
    'Standard sign-in for managed domains will use the IdP. Confirm the emergency administrator can recover access.',
  'security.dialog.ssoDisableTitle': 'Disable SSO enforcement?',
  'security.dialog.ssoDisableDescription':
    'Sign-in methods outside SSO will become available again for managed domains.',
  'security.dialog.provisioningTitle': 'Apply directory changes?',
  'security.dialog.provisioningDescription':
    'Apply {count} changes. Sessions for deactivated users may be revoked immediately.',
  'security.dialog.sessionPolicyTitle':
    'Save while excluding your current connection?',
  'security.dialog.sessionPolicyDescription':
    'The updated IP allowlist will reject your current source ({ip}). You may lose access to this administration page immediately after saving.',
  'security.dialog.sessionPolicyUnknownIp': 'unresolved source IP',
  'security.dialog.sessionPolicyConfirm': 'Save and continue',
  'security.dialog.scimRotateTitle': 'Rotate the SCIM token?',
  'security.dialog.scimRotateDescription':
    'The current SCIM token will stop working immediately. Continue only when you are ready to update the IdP credential.',
  'security.dialog.serviceAccountRotateTitle':
    'Rotate the service account credential?',
  'security.dialog.serviceAccountRotateDescription':
    'The current credential for {name} will stop working immediately, and the new credential will use the same lifetime policy. Continue only when dependent integrations are ready to switch.',
  'security.dialog.mappingDeleteTitle': 'Remove group mapping?',
  'security.dialog.mappingDeleteDescription':
    'Remove the {scope} / {role} mapping for {group}. Access granted through this group may be lost immediately.',
  'security.dialog.mappingUpdateTitle': 'Change group mapping?',
  'security.dialog.mappingUpdateDescription':
    'Change {group} to {scope} / {role}. Access granted through the current mapping may change immediately.',
  'security.dialog.serviceAccountTitle': 'Revoke service account?',
  'security.dialog.serviceAccountDescription':
    'Credentials for {name} will stop working immediately. Migrate active integrations first.',
  'security.dialog.breakGlassTitle': 'Deactivate emergency administrator?',
  'security.dialog.breakGlassDescription':
    'Deactivating {email} reduces recovery options during an IdP outage.',
  'security.dialog.roleUpdateTitle': 'Reduce role permissions?',
  'security.dialog.roleUpdateDescription':
    'Remove {permissions} permissions from {name}. This immediately affects {assignments} direct assignments, {mappings} group mappings, and {serviceAccounts} service accounts.',
  'security.dialog.roleGuestTitle': 'Change guest assignment eligibility?',
  'security.dialog.roleGuestEnableDescription':
    'Allow {name} to be assigned to external guests. Guests may receive every permission in this role.',
  'security.dialog.roleGuestDisableDescription':
    'Prevent new external guest assignments for {name}. Review the impact on existing assignments.',
  'security.dialog.roleTitle': 'Delete custom role?',
  'security.dialog.roleDescription':
    'Delete {name}. The confirmed impact includes {assignments} direct assignments, {mappings} group mappings, and {serviceAccounts} service accounts.',
} as const
