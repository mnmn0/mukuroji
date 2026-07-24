import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type {
  EnterpriseSecuritySnapshot,
  EnterpriseSessionPolicyImpact,
  UpdateEnterpriseSessionPolicyInput,
} from '../api'
import {
  createSessionPolicyDraft,
  normalizeEnterpriseSecurityLineList,
} from '../model/enterpriseSecurityForms'
import {
  EnterpriseSecurityReadOnlyNotice,
  EnterpriseSecuritySectionHeader,
  SecurityNumberField,
  SecurityToggle,
} from './EnterpriseSecurityFields'

/**
 * Renders authentication, network, and guest session-policy forms.
 *
 * @param props - Session snapshot, preview/update callbacks, and localized copy.
 * @returns The independently renderable sessions tab.
 */
export function SecuritySessionsTab({
  busyOperation,
  snapshot,
  t,
  onPreview,
  onRequestConfirmation,
  onUpdate,
}: {
  busyOperation?: string
  snapshot: EnterpriseSecuritySnapshot
  t: (key: MessageKey) => string
  onPreview?: (
    input: UpdateEnterpriseSessionPolicyInput,
  ) => Promise<EnterpriseSessionPolicyImpact>
  onRequestConfirmation: (
    input: UpdateEnterpriseSessionPolicyInput,
    impact: EnterpriseSessionPolicyImpact,
  ) => void
  onUpdate?: (input: UpdateEnterpriseSessionPolicyInput) => Promise<unknown>
}) {
  const canManage = snapshot.capabilities.canManageSessions
  const [draft, setDraft] = useState(() =>
    createSessionPolicyDraft(snapshot.sessionPolicy),
  )
  const isBusy = Boolean(busyOperation)
  const invalidSessionIntervals =
    !Number.isFinite(draft.idleTimeoutMinutes) ||
    !Number.isFinite(draft.reauthenticationMinutes) ||
    !Number.isFinite(draft.sensitiveActionReauthenticationMinutes) ||
    !Number.isFinite(draft.sessionLifetimeMinutes) ||
    draft.idleTimeoutMinutes > draft.sessionLifetimeMinutes ||
    draft.reauthenticationMinutes > draft.sessionLifetimeMinutes ||
    draft.sensitiveActionReauthenticationMinutes > draft.reauthenticationMinutes

  /** Previews the session-policy impact before saving it. */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      !canManage ||
      !onPreview ||
      !onUpdate ||
      isBusy ||
      invalidSessionIntervals
    ) {
      return
    }

    const input = {
      allowedGuestDomains: normalizeEnterpriseSecurityLineList(
        draft.allowedGuestDomains,
      ),
      expectedVersion: snapshot.sessionPolicy.version,
      externalCollaboratorsAllowed: draft.externalCollaboratorsAllowed,
      guestSessionLifetimeMinutes: draft.guestSessionLifetimeMinutes,
      guestsAllowed: draft.guestsAllowed,
      idleTimeoutMinutes: draft.idleTimeoutMinutes,
      ipAllowlist: normalizeEnterpriseSecurityLineList(draft.ipAllowlist),
      mfaRequired: draft.mfaRequired,
      reauthenticationMinutes: draft.reauthenticationMinutes,
      sensitiveActionReauthenticationMinutes:
        draft.sensitiveActionReauthenticationMinutes,
      sessionLifetimeMinutes: draft.sessionLifetimeMinutes,
    } satisfies UpdateEnterpriseSessionPolicyInput

    try {
      const impact = await onPreview(input)
      if (impact.requiresConfirmation) {
        onRequestConfirmation(input, impact)
        return
      }

      await onUpdate(input)
    } catch {
      // The container owns the shared mutation error banner.
    }
  }

  return (
    <form
      className="grid gap-5"
      data-testid="security-sessions"
      onSubmit={(event) => void handleSubmit(event)}
    >
      {!canManage ? <EnterpriseSecurityReadOnlyNotice t={t} /> : null}

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          description={t('security.sessions.authenticationDescription')}
          title={t('security.sessions.authenticationTitle')}
        />
        <div className="grid grid-cols-2 gap-4 border-t border-[var(--workbench-border)] p-5 max-[760px]:grid-cols-1">
          <SecurityToggle
            checked={draft.mfaRequired}
            description={t('security.sessions.mfaDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.mfaRequired')}
            onChange={(checked) =>
              setDraft((current) => ({ ...current, mfaRequired: checked }))
            }
          />
          <SecurityNumberField
            description={t('security.sessions.lifetimeDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.lifetime')}
            max={43_200}
            min={15}
            unit={t('security.unit.minutes')}
            value={draft.sessionLifetimeMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                sessionLifetimeMinutes: value,
              }))
            }
          />
          <SecurityNumberField
            description={t('security.sessions.idleTimeoutDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.idleTimeout')}
            max={43_200}
            min={5}
            unit={t('security.unit.minutes')}
            value={draft.idleTimeoutMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                idleTimeoutMinutes: value,
              }))
            }
          />
          <SecurityNumberField
            description={t('security.sessions.reauthenticationDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.reauthentication')}
            max={10_080}
            min={5}
            unit={t('security.unit.minutes')}
            value={draft.reauthenticationMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                reauthenticationMinutes: value,
              }))
            }
          />
          <SecurityNumberField
            description={t(
              'security.sessions.sensitiveReauthenticationDescription',
            )}
            disabled={!canManage || isBusy}
            label={t('security.sessions.sensitiveReauthentication')}
            max={10_080}
            min={1}
            unit={t('security.unit.minutes')}
            value={draft.sensitiveActionReauthenticationMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                sensitiveActionReauthenticationMinutes: value,
              }))
            }
          />
          <div className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
            <p className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('security.sessions.unitHelpTitle')}
            </p>
            <p className="mt-2 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('security.sessions.unitHelpDescription')}
            </p>
            {invalidSessionIntervals ? (
              <p className="mt-3 text-xs font-semibold text-red-700" role="alert">
                {t('security.sessions.reauthenticationError')}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          description={t('security.sessions.networkDescription')}
          title={t('security.sessions.networkTitle')}
        />
        <div className="border-t border-[var(--workbench-border)] p-5">
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('security.sessions.ipAllowlist')}
            <textarea
              className="workbench-input min-h-32 resize-y px-3 py-2 font-mono text-sm"
              disabled={!canManage || isBusy}
              placeholder={'203.0.113.0/24\n2001:db8::/48'}
              value={draft.ipAllowlist.join('\n')}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  ipAllowlist: event.target.value.split('\n'),
                }))
              }
            />
            <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('security.sessions.ipAllowlistHelp')}
            </span>
          </label>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
        <EnterpriseSecuritySectionHeader
          description={t('security.sessions.guestsDescription')}
          title={t('security.sessions.guestsTitle')}
        />
        <div className="grid grid-cols-2 gap-4 border-t border-[var(--workbench-border)] p-5 max-[760px]:grid-cols-1">
          <SecurityToggle
            checked={draft.guestsAllowed}
            description={t('security.sessions.guestsAllowedDescription')}
            disabled={!canManage || isBusy}
            label={t('security.sessions.guestsAllowed')}
            onChange={(checked) =>
              setDraft((current) => ({ ...current, guestsAllowed: checked }))
            }
          />
          <SecurityToggle
            checked={draft.externalCollaboratorsAllowed}
            description={t(
              'security.sessions.externalCollaboratorsAllowedDescription',
            )}
            disabled={!canManage || isBusy}
            label={t('security.sessions.externalCollaboratorsAllowed')}
            onChange={(checked) =>
              setDraft((current) => ({
                ...current,
                externalCollaboratorsAllowed: checked,
              }))
            }
          />
          <SecurityNumberField
            description={t(
              'security.sessions.guestSessionLifetimeDescription',
            )}
            disabled={!canManage || isBusy || !draft.guestsAllowed}
            label={t('security.sessions.guestSessionLifetime')}
            max={43_200}
            min={15}
            unit={t('security.unit.minutes')}
            value={draft.guestSessionLifetimeMinutes}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                guestSessionLifetimeMinutes: value,
              }))
            }
          />
          <label className="col-span-2 grid gap-2 text-sm font-semibold text-[var(--workbench-text)] max-[760px]:col-span-1">
            {t('security.sessions.allowedGuestDomains')}
            <textarea
              className="workbench-input min-h-28 resize-y px-3 py-2 font-mono text-sm"
              disabled={
                !canManage ||
                isBusy ||
                (!draft.guestsAllowed && !draft.externalCollaboratorsAllowed)
              }
              placeholder={'partner.example\nvendor.example'}
              value={draft.allowedGuestDomains.join('\n')}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  allowedGuestDomains: event.target.value.split('\n'),
                }))
              }
            />
            <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('security.sessions.allowedGuestDomainsHelp')}
            </span>
          </label>
        </div>
      </section>

      {canManage ? (
        <div className="sticky bottom-4 flex justify-end">
          <button
            className="workbench-button-primary min-h-11 px-5 shadow-lg disabled:cursor-not-allowed disabled:opacity-55"
            data-testid="security-session-policy-save"
            disabled={
              isBusy || invalidSessionIntervals || !onPreview || !onUpdate
            }
            type="submit"
          >
            {t(
              busyOperation === 'session-policy:preview'
                ? 'security.action.previewing'
                : busyOperation === 'session-policy:update'
                  ? 'security.action.saving'
                  : 'security.sessions.save',
            )}
          </button>
        </div>
      ) : null}
    </form>
  )
}
