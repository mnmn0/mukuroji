import { useMemo, useState } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { readWorkCalendarErrorKey, useWorkCalendarChange } from '../mutations/useWorkCalendarChange'
import {
  createWorkCalendarDraft,
  toWorkCalendarOverrides,
  type WorkCalendarDraft,
} from '../model/workCalendarDraft'
import { useWorkCalendar } from '../queries/useWorkCalendar'
import { WorkCalendarPanel, type WorkCalendarScopeOption } from './WorkCalendarPanel'

/** Team as listed in the Workspace directory. */
export type WorkCalendarTeam = {
  /** Team ID. */
  id: string
  /** Team name. */
  name: string
  /** Projects of the Team that the member can see. */
  projects: readonly {
    /** Project ID. */
    id: string
    /** Project name. */
    name: string
  }[]
}

/** Props of the calendar panel container. */
export type WorkCalendarPanelContainerProps = {
  /** Session access token. */
  accessToken: string
  /** Locale of the panel. */
  locale: Locale
  /** Teams of the Workspace. */
  teams: readonly WorkCalendarTeam[]
}

/** Form values edited from one loaded revision of one calendar. */
type DraftState = {
  /** Calendar the draft belongs to. */
  scope: string
  /** Revision the draft was started from; 0 when nothing was stored. */
  baseRevision: number
  /** Form values. */
  value: WorkCalendarDraft
}

/**
 * Connects the Team and Project calendar panel to the calendar read, the preview, and the save.
 *
 * @param props - Authentication, locale, and Teams.
 * @returns The calendar panel.
 */
export function WorkCalendarPanelContainer({ accessToken, locale, teams }: WorkCalendarPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const scopeOptions = useMemo(() => createScopeOptions(teams, t), [teams, t])
  const [selectedScope, setSelectedScope] = useState(scopeOptions[0]?.value)
  const scope = scopeOptions.find((option) => option.value === selectedScope) ?? scopeOptions[0]
  const [teamId, projectId] = splitScope(scope?.value)
  const query = useWorkCalendar(accessToken, teamId, projectId)
  const [draftState, setDraftState] = useState<DraftState>()
  const change = useWorkCalendarChange(accessToken, () => query.mutate())
  const calendar = query.data
  const ownDraft = draftState && draftState.scope === scope?.value ? draftState : undefined
  const draft = calendar ? ownDraft?.value ?? createWorkCalendarDraft(calendar) : undefined
  const baseRevision = ownDraft?.baseRevision ?? calendar?.calendar?.revision ?? 0

  /** Previews the drafted change. */
  function preview() {
    if (!teamId || !draft) return
    void change.preview(teamId, {
      ...(projectId ? { projectId } : {}),
      overrides: toWorkCalendarOverrides(draft),
      adjustment: draft.adjustment,
    })
  }

  /** Saves the previewed change and applies it to the Work Items that follow the calendar. */
  async function save() {
    if (!teamId || !draft || !change.impact) return
    const saved = await change.save(teamId, {
      ...(projectId ? { projectId } : {}),
      overrides: toWorkCalendarOverrides(draft),
      adjustment: draft.adjustment,
      expectedRevision: baseRevision,
    })
    if (saved) setDraftState(undefined)
  }

  return (
    <WorkCalendarPanel
      calendar={calendar}
      draft={draft}
      errorMessage={change.errorKey
        ? t(change.errorKey)
        : query.error ? t(readWorkCalendarErrorKey(query.error)) : undefined}
      impact={change.impact}
      isBusy={change.isBusy}
      isLoading={query.isLoading}
      onDraftChange={(value) => {
        if (!scope || !calendar) return
        change.reset()
        setDraftState({ scope: scope.value, baseRevision, value })
      }}
      onPreview={preview}
      onRetry={() => {
        change.reset()
        // Reloading starts again from the stored calendar, so a later save uses its new revision.
        setDraftState(undefined)
        void query.mutate()
      }}
      onSave={() => void save()}
      onScopeChange={(value) => {
        change.reset()
        setDraftState(undefined)
        setSelectedScope(value)
      }}
      result={change.result}
      scopeOptions={scopeOptions}
      selectedScope={scope?.value}
      t={t}
    />
  )
}

/**
 * Lists every Team calendar followed by its Project calendars.
 *
 * @param teams - Teams of the Workspace.
 * @param t - Translator.
 * @returns Options whose value is the Team ID or `<teamId>/<projectId>`.
 */
function createScopeOptions(
  teams: readonly WorkCalendarTeam[],
  t: (key: MessageKey) => string,
): WorkCalendarScopeOption[] {
  return teams.flatMap((team) => [
    { value: team.id, label: t('workspace.workCalendar.scope.team').replace('{team}', team.name) },
    ...team.projects.map((project) => ({
      value: `${team.id}/${project.id}`,
      label: t('workspace.workCalendar.scope.project')
        .replace('{team}', team.name)
        .replace('{project}', project.name),
    })),
  ])
}

/**
 * Splits a scope option value.
 *
 * @param value - Option value.
 * @returns The Team ID and the Project ID, if any.
 */
function splitScope(value: string | undefined): [string | undefined, string | undefined] {
  if (!value) return [undefined, undefined]
  const separator = value.indexOf('/')
  return separator < 0 ? [value, undefined] : [value.slice(0, separator), value.slice(separator + 1)]
}
