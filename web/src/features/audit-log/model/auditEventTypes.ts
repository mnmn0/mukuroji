import type { MessageKey } from '../../../shared/i18n/i18n'

/** Resolves a message key in the display locale. */
type Translate = (key: MessageKey) => string

/**
 * Message keys of the resource part of an event type, keyed by everything before the last `.`.
 */
const resourceLabelKeys: Readonly<Record<string, MessageKey>> = {
  'agent-run': 'auditLog.resource.agent-run',
  'agent-settings': 'auditLog.resource.agent-settings',
  'ai-assistance.policy': 'auditLog.resource.ai-assistance.policy',
  'ai-assistance.provider-credential': 'auditLog.resource.ai-assistance.provider-credential',
  'annotation': 'auditLog.resource.annotation',
  'api-key': 'auditLog.resource.api-key',
  'approval': 'auditLog.resource.approval',
  'audit': 'auditLog.resource.audit',
  'automation': 'auditLog.resource.automation',
  'break-glass': 'auditLog.resource.break-glass',
  'break-glass-account': 'auditLog.resource.break-glass-account',
  'comment': 'auditLog.resource.comment',
  'connector': 'auditLog.resource.connector',
  'connector.credential': 'auditLog.resource.connector.credential',
  'context-item': 'auditLog.resource.context-item',
  'credential-policy': 'auditLog.resource.credential-policy',
  'custom-role': 'auditLog.resource.custom-role',
  'directory-group-mapping': 'auditLog.resource.directory-group-mapping',
  'document': 'auditLog.resource.document',
  'document.comment': 'auditLog.resource.document.comment',
  'document.permission': 'auditLog.resource.document.permission',
  'document.public-link': 'auditLog.resource.document.public-link',
  'document.version': 'auditLog.resource.document.version',
  'document-public-link': 'auditLog.resource.document.public-link',
  'document-version': 'auditLog.resource.document.version',
  'enterprise-security': 'auditLog.resource.enterprise-security',
  'external-link': 'auditLog.resource.external-link',
  'file': 'auditLog.resource.file',
  'form': 'auditLog.resource.form',
  'identity-domain': 'auditLog.resource.identity-domain',
  'identity-provider': 'auditLog.resource.identity-provider',
  'import': 'auditLog.resource.import',
  'invitation': 'auditLog.resource.invitation',
  'member': 'auditLog.resource.member',
  'notification-reminders': 'auditLog.resource.notification-reminders',
  'oauth-app': 'auditLog.resource.oauth-app',
  'planning-entity': 'auditLog.resource.planning-entity',
  'planning-dependency': 'auditLog.resource.planning-dependency',
  'planning-update': 'auditLog.resource.planning-update',
  'project': 'auditLog.resource.project',
  'provisioning': 'auditLog.resource.provisioning',
  'role-assignment': 'auditLog.resource.role-assignment',
  'runtime-control': 'auditLog.resource.runtime-control',
  'scim-credential': 'auditLog.resource.scim-credential',
  'scim-group': 'auditLog.resource.scim-group',
  'scim-user': 'auditLog.resource.scim-user',
  'security-policy': 'auditLog.resource.security-policy',
  'service-account': 'auditLog.resource.service-account',
  'service-account-credential': 'auditLog.resource.service-account-credential',
  'sync-conflict': 'auditLog.resource.sync-conflict',
  'tenant.export': 'auditLog.resource.tenant.export',
  'tenant.governance': 'auditLog.resource.tenant.governance',
  'tenant.profile': 'auditLog.resource.tenant.profile',
  'time-budget': 'auditLog.resource.time-budget',
  'time-entry': 'auditLog.resource.time-entry',
  'time-period': 'auditLog.resource.time-period',
  'time-rate-card': 'auditLog.resource.time-rate-card',
  'timer': 'auditLog.resource.timer',
  'triage': 'auditLog.resource.triage',
  'update-feed': 'auditLog.resource.update-feed',
  'watcher': 'auditLog.resource.watcher',
  'webhook': 'auditLog.resource.webhook',
  'webhook-subscription': 'auditLog.resource.webhook-subscription',
  'work-item': 'auditLog.resource.work-item',
  'workflow': 'auditLog.resource.workflow',
}

/**
 * Message keys of the action part of an event type: a Japanese noun and an English past participle.
 */
const actionLabelKeys: Readonly<Record<string, MessageKey>> = {
  'accepted': 'auditLog.action.accepted',
  'activated': 'auditLog.action.activated',
  'activation-revoked': 'auditLog.action.activation-revoked',
  'added': 'auditLog.action.added',
  'applied': 'auditLog.action.applied',
  'archived': 'auditLog.action.archived',
  'assigned': 'auditLog.action.assigned',
  'attached': 'auditLog.action.attached',
  'authenticated': 'auditLog.action.authenticated',
  'backfilled': 'auditLog.action.backfilled',
  'blocker-added': 'auditLog.action.blocker-added',
  'blocker-removed': 'auditLog.action.blocker-removed',
  'blocking-added': 'auditLog.action.blocking-added',
  'blocking-removed': 'auditLog.action.blocking-removed',
  'cancelled': 'auditLog.action.cancelled',
  'change-completed': 'auditLog.action.change-completed',
  'change-failed': 'auditLog.action.change-failed',
  'change-started': 'auditLog.action.change-started',
  'child-added': 'auditLog.action.child-added',
  'child-removed': 'auditLog.action.child-removed',
  'closing': 'auditLog.action.closing',
  'commented': 'auditLog.action.commented',
  'completed': 'auditLog.action.completed',
  'created': 'auditLog.action.created',
  'deactivated': 'auditLog.action.deactivated',
  'decided': 'auditLog.action.decided',
  'deleted': 'auditLog.action.deleted',
  'dependency-added': 'auditLog.action.dependency-added',
  'dependency-removed': 'auditLog.action.dependency-removed',
  'digest': 'auditLog.action.digest',
  'directory-deprovisioned': 'auditLog.action.directory-deprovisioned',
  'directory-reactivated': 'auditLog.action.directory-reactivated',
  'directory-reconciled': 'auditLog.action.directory-reconciled',
  'directory-provisioned': 'auditLog.action.directory-provisioned',
  'edited': 'auditLog.action.edited',
  'downloaded': 'auditLog.action.downloaded',
  'enforcement-updated': 'auditLog.action.enforcement-updated',
  'export-downloaded': 'auditLog.action.export-downloaded',
  'export-requested': 'auditLog.action.export-requested',
  'exported': 'auditLog.action.exported',
  'failed': 'auditLog.action.failed',
  'installed': 'auditLog.action.installed',
  'issued': 'auditLog.action.issued',
  'mfa-reset': 'auditLog.action.mfa-reset',
  'moved': 'auditLog.action.moved',
  'owner-reconciled': 'auditLog.action.owner-reconciled',
  'parent-changed': 'auditLog.action.parent-changed',
  'password-reset-requested': 'auditLog.action.password-reset-requested',
  'previewed': 'auditLog.action.previewed',
  'reactivated': 'auditLog.action.reactivated',
  'received': 'auditLog.action.received',
  'reconciled': 'auditLog.action.reconciled',
  'relation-added': 'auditLog.action.relation-added',
  'relation-removed': 'auditLog.action.relation-removed',
  'rejected': 'auditLog.action.rejected',
  'removed': 'auditLog.action.removed',
  'renamed': 'auditLog.action.renamed',
  'reordered': 'auditLog.action.reordered',
  'replaced': 'auditLog.action.replaced',
  'reopened': 'auditLog.action.reopened',
  'replied': 'auditLog.action.replied',
  'request-rejected': 'auditLog.action.request-rejected',
  'requested': 'auditLog.action.requested',
  'resolved': 'auditLog.action.resolved',
  'restored': 'auditLog.action.restored',
  'retried': 'auditLog.action.retried',
  'revoked': 'auditLog.action.revoked',
  'role-changed': 'auditLog.action.role-changed',
  'rotated': 'auditLog.action.rotated',
  'schedule': 'auditLog.action.schedule',
  'schedule-cascade-updated': 'auditLog.action.schedule-cascade-updated',
  'sibling-order-changed': 'auditLog.action.sibling-order-changed',
  'started': 'auditLog.action.started',
  'submitted': 'auditLog.action.submitted',
  'subscribed': 'auditLog.action.subscribed',
  'superseded': 'auditLog.action.superseded',
  'unsubscribed': 'auditLog.action.unsubscribed',
  'updated': 'auditLog.action.updated',
  'upload-completed': 'auditLog.action.upload-completed',
  'version-created': 'auditLog.action.version-created',
  'viewed': 'auditLog.action.viewed',
}

/**
 * Event types offered as search suggestions, grouped by the resource they belong to.
 *
 * The audit log can hold other types too, which the search still accepts as typed.
 */
export const suggestedAuditEventTypes: readonly string[] = [
  'work-item.created',
  'work-item.updated',
  'work-item.deleted',
  'work-item.parent-changed',
  'comment.created',
  'comment.edited',
  'comment.deleted',
  'member.created',
  'member.role-changed',
  'member.removed',
  'invitation.created',
  'invitation.revoked',
  'invitation.accepted',
  'role-assignment.created',
  'role-assignment.deleted',
  'custom-role.updated',
  'project.created',
  'project.updated',
  'project.renamed',
  'project.archived',
  'project.restored',
  'planning-entity.created',
  'planning-entity.updated',
  'planning-entity.moved',
  'planning-entity.archived',
  'planning-entity.dependency-added',
  'planning-entity.dependency-removed',
  'document.created',
  'document.updated',
  'document.moved',
  'document.permission.updated',
  'document.archived',
  'document.public-link.created',
  'document.public-link.revoked',
  'document.exported',
  'file.created',
  'file.deleted',
  'approval.requested',
  'approval.rejected',
  'api-key.created',
  'api-key.rotated',
  'api-key.revoked',
  'oauth-app.created',
  'oauth-app.revoked',
  'webhook-subscription.created',
  'webhook-subscription.updated',
  'webhook-subscription.deleted',
  'service-account.created',
  'service-account.revoked',
  'connector.installed',
  'external-link.created',
  'security-policy.updated',
  'identity-provider.updated',
  'break-glass.activated',
  'tenant.profile.updated',
  'tenant.governance.updated',
  'ai-assistance.policy.updated',
  'runtime-control.change-completed',
  'audit.viewed',
  'audit.export-requested',
  'audit.export-downloaded',
]

/**
 * Resource types offered by the target filter, as stored in `target.type`.
 */
export const suggestedAuditTargetTypes: readonly string[] = [
  'work-item',
  'comment',
  'member',
  'invitation',
  'project',
  'workflow',
  'file',
  'approval',
  'document',
  'document-public-link',
  'planning-entity',
  'planning-dependency',
  'audit-log',
]

/**
 * Builds the display label of an event type, such as `Work Item の更新` or `Work Item updated`.
 *
 * The resource is everything before the last `.` and the action is what follows it.
 * An unknown action keeps its raw name after the resource label, and an unknown resource
 * returns the raw event type, so a new event type still reads as itself.
 *
 * @param eventType - Event type recorded by the server.
 * @param t - Message resolver of the display locale.
 * @returns The localized label.
 */
export function formatAuditEventType(eventType: string, t: Translate): string {
  const separator = eventType.lastIndexOf('.')
  if (separator <= 0) return eventType
  const resourceKey = resourceLabelKeys[eventType.slice(0, separator)]
  if (!resourceKey) return eventType
  const resource = t(resourceKey)
  const actionName = eventType.slice(separator + 1)
  const actionKey = actionLabelKeys[actionName]
  if (!actionKey) return fillEventTypeLabel(t('auditLog.eventType.unknownAction'), resource, actionName)
  // A Latin word such as `Work Item` keeps a space before the Japanese particle.
  const template = /[A-Za-z0-9]$/u.test(resource) ? 'auditLog.eventType.labelAfterLatin' : 'auditLog.eventType.label'
  return fillEventTypeLabel(t(template), resource, t(actionKey))
}

/**
 * Fills the resource and action into an event type label template.
 *
 * @param template - Template with `{resource}` and `{action}`.
 * @param resource - Resource label.
 * @param action - Action label or raw action name.
 * @returns The filled label.
 */
function fillEventTypeLabel(template: string, resource: string, action: string): string {
  return template.replace('{resource}', resource).replace('{action}', action)
}

/**
 * Builds the display label of a resource type such as `work-item`.
 *
 * @param resourceType - Resource type recorded by the server.
 * @param t - Message resolver of the display locale.
 * @returns The localized label, or the raw type when it is unknown.
 */
export function formatAuditResourceType(resourceType: string, t: Translate): string {
  const key = resourceType === 'audit-log' ? resourceLabelKeys.audit : resourceLabelKeys[resourceType]
  return key ? t(key) : resourceType
}
