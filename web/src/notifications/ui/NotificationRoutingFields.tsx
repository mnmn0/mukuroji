import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_ROUTING_CHANNELS,
  toNotificationMuteProjectKey,
  type NotificationMutes,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { NotificationPreferences } from '../api'
import {
  isCategoryChannelOn,
  resolveNotificationMutes,
  setCategoryChannel,
  setNotificationMuted,
  type NotificationMuteKind,
} from '../model/routing'

/** A Team, and its Projects, that the member can mute. */
export type NotificationMuteTeam = {
  /** Team ID. */
  id: string
  /** Team name. */
  name: string
  /** Projects shown under the Team. */
  projects: ReadonlyArray<{
    /** Project ID. */
    id: string
    /** Project name. */
    name: string
  }>
}

/** Props for the category channel and mute fields of the notification settings form. */
export type NotificationRoutingFieldsProps = {
  /** Draft preferences being edited. */
  draft: NotificationPreferences
  /** Replaces the draft preferences. */
  onChange: (update: (current: NotificationPreferences) => NotificationPreferences) => void
  /** Teams and Projects the member can mute; omitted while unknown. */
  muteTargets?: readonly NotificationMuteTeam[]
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders the per-category channel switches and the Project / Team mutes.
 *
 * @param props - Draft preferences, change handler, mute targets, and labels.
 * @returns Two fieldsets for the notification settings form.
 */
export function NotificationRoutingFields({ draft, onChange, muteTargets = [], t }: NotificationRoutingFieldsProps) {
  const mutes = resolveNotificationMutes(draft.mutes)
  const knownProjectKeys = new Set(muteTargets.flatMap(
    (team) => team.projects.map((project) => toNotificationMuteProjectKey(team.id, project.id)),
  ))
  const knownTeamIds = new Set(muteTargets.map((team) => team.id))
  // Mutes for Teams or Projects no longer listed stay removable.
  const unknownMutes = [
    ...mutes.teamIds.filter((id) => !knownTeamIds.has(id)).map((id) => createMuteEntry('teamIds', id)),
    ...mutes.projectKeys.filter((key) => !knownProjectKeys.has(key)).map((key) => createMuteEntry('projectKeys', key)),
  ]
  const updateMutes = (update: (current: NotificationMutes) => NotificationMutes) => onChange((current) => ({
    ...current,
    mutes: update(resolveNotificationMutes(current.mutes)),
  }))
  const setMuted = (kind: NotificationMuteKind, id: string, muted: boolean) =>
    updateMutes((current) => setNotificationMuted(current, kind, id, muted))

  return (
    <>
      <fieldset className="grid gap-4 px-5 py-5">
        <legend className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('workspace.settings.notifications.categoriesTitle')}
        </legend>
        <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('workspace.settings.notifications.categoriesDescription')}
        </p>
        <div className="overflow-x-auto rounded-lg border border-[var(--workbench-border)]">
          <table className="w-full min-w-[480px] text-sm" data-testid="notification-category-channels">
            <thead className="bg-[var(--workbench-surface-muted)] text-xs font-semibold text-[var(--workbench-muted)]">
              <tr>
                <th className="px-4 py-2 text-left" scope="col">{t('workspace.settings.notifications.categoryColumn')}</th>
                {NOTIFICATION_ROUTING_CHANNELS.map((channel) => (
                  <th className="px-3 py-2 text-center" key={channel} scope="col">
                    {t(`workspace.settings.notifications.channel.${channel}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--workbench-border)]">
              {NOTIFICATION_CATEGORIES.map((category) => (
                <tr key={category}>
                  <th className="px-4 py-2 text-left font-semibold text-[var(--workbench-text)]" scope="row">
                    {t(`workspace.settings.notifications.category.${category}`)}
                  </th>
                  {NOTIFICATION_ROUTING_CHANNELS.map((channel) => {
                    const channelOn = Boolean(draft.channels[channel])
                    return (
                      <td className="px-3 py-2 text-center" key={channel}>
                        <input
                          aria-label={t('workspace.settings.notifications.categoryChannelLabel')
                            .replace('{category}', t(`workspace.settings.notifications.category.${category}`))
                            .replace('{channel}', t(`workspace.settings.notifications.channel.${channel}`))}
                          checked={channelOn && isCategoryChannelOn(draft.categoryChannels, category, channel)}
                          className="h-4 w-4 accent-[var(--workbench-primary)] disabled:opacity-40"
                          data-testid={`notification-category-${category}-${channel}`}
                          disabled={!channelOn}
                          type="checkbox"
                          onChange={(event) => onChange((current) => ({
                            ...current,
                            categoryChannels: setCategoryChannel(current.categoryChannels, category, channel, event.target.checked),
                          }))}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 px-5 py-5" data-testid="notification-mutes">
        <legend className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('workspace.settings.notifications.mutesTitle')}
        </legend>
        <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('workspace.settings.notifications.mutesDescription')}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['keepMentions', 'keepApprovals'] as const).map((key) => (
            <label
              className="flex min-w-0 items-center justify-between gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3"
              key={key}
            >
              <span className="text-sm font-semibold text-[var(--workbench-text)]">
                {t(`workspace.settings.notifications.mutes.${key}`)}
              </span>
              <input
                checked={mutes[key]}
                className="h-5 w-5 flex-none accent-[var(--workbench-primary)]"
                data-testid={`notification-mutes-${key}`}
                type="checkbox"
                onChange={(event) => updateMutes((current) => ({ ...current, [key]: event.target.checked }))}
              />
            </label>
          ))}
        </div>
        {muteTargets.length === 0 ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {t('workspace.settings.notifications.mutes.empty')}
          </p>
        ) : (
          <ul className="grid gap-2">
            {muteTargets.map((team) => (
              <li className="rounded-lg border border-[var(--workbench-border)] px-4 py-3" key={team.id}>
                <label className="flex min-w-0 items-center justify-between gap-4">
                  <span className="min-w-0 truncate text-sm font-semibold text-[var(--workbench-text)]">
                    {t('workspace.settings.notifications.mutes.team').replace('{name}', team.name)}
                  </span>
                  <input
                    checked={mutes.teamIds.includes(team.id)}
                    className="h-4 w-4 flex-none accent-[var(--workbench-primary)]"
                    data-testid={`notification-mute-team-${team.id}`}
                    type="checkbox"
                    onChange={(event) => setMuted('teamIds', team.id, event.target.checked)}
                  />
                </label>
                {team.projects.length > 0 ? (
                  <ul className="mt-2 grid gap-1 border-l border-[var(--workbench-border)] pl-3">
                    {team.projects.map((project) => {
                      const projectKey = toNotificationMuteProjectKey(team.id, project.id)
                      return (
                      <li key={project.id}>
                        <label className="flex min-w-0 items-center justify-between gap-4">
                          <span className="min-w-0 truncate text-sm font-medium text-[var(--workbench-text)]">
                            {project.name}
                          </span>
                          <input
                            checked={mutes.projectKeys.includes(projectKey)}
                            className="h-4 w-4 flex-none accent-[var(--workbench-primary)]"
                            data-testid={`notification-mute-project-${team.id}-${project.id}`}
                            type="checkbox"
                            onChange={(event) => setMuted('projectKeys', projectKey, event.target.checked)}
                          />
                        </label>
                      </li>
                      )
                    })}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {unknownMutes.length > 0 ? (
          <div className="grid gap-2">
            <p className="text-xs font-semibold text-[var(--workbench-muted)]">
              {t('workspace.settings.notifications.mutes.unknown')}
            </p>
            <ul className="flex flex-wrap gap-2">
              {unknownMutes.map(({ kind, id }) => (
                <li key={`${kind}:${id}`}>
                  <button
                    className="workbench-button-secondary min-h-9 px-3 text-xs"
                    type="button"
                    onClick={() => setMuted(kind, id, false)}
                  >
                    {t('workspace.settings.notifications.mutes.remove').replace('{id}', id)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </fieldset>
    </>
  )
}

/**
 * Pairs a muted ID with the list it belongs to.
 *
 * @param kind - Whether the entry is a Project key or a Team ID.
 * @param id - Muted Project key or Team ID.
 * @returns The entry shown in the list of mutes no longer listed.
 */
function createMuteEntry(kind: NotificationMuteKind, id: string) {
  return { kind, id }
}
