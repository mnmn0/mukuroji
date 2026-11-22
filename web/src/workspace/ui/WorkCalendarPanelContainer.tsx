import { useMemo, useRef, useState } from 'react'
import type {
  WorkCalendarChangeImpact,
  WorkCalendarChangeResult,
} from '@mukuroji/contracts'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { createMutationRequestContext, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { previewWorkCalendarChange, saveWorkCalendar } from '../api/workCalendar'
import { WorkspaceAccessApiError } from '../api/errors'
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
  const [impact, setImpact] = useState<WorkCalendarChangeImpact>()
  const [result, setResult] = useState<WorkCalendarChangeResult>()
  const [errorMessage, setErrorMessage] = useState<string>()
  const [isBusy, setIsBusy] = useState(false)
  const saveContext = useRef<MutationRequestContext | undefined>(undefined)
  /** Changes whenever the outcome is cleared, so a reply to an earlier request is dropped. */
  const requestGeneration = useRef(0)
  const calendar = query.data
  const ownDraft = draftState && draftState.scope === scope?.value ? draftState : undefined
  const draft = calendar ? ownDraft?.value ?? createWorkCalendarDraft(calendar) : undefined
  const baseRevision = ownDraft?.baseRevision ?? calendar?.calendar?.revision ?? 0

  /** Clears the preview, result, and error after any change. */
  function resetOutcome() {
    requestGeneration.current += 1
    setImpact(undefined)
    setResult(undefined)
    setErrorMessage(undefined)
    saveContext.current = undefined
  }

  /** Previews the drafted change. */
  async function preview() {
    if (!teamId || !draft) return
    const generation = requestGeneration.current
    setIsBusy(true)
    setErrorMessage(undefined)
    try {
      const previewed = await previewWorkCalendarChange(accessToken, teamId, {
        ...(projectId ? { projectId } : {}),
        overrides: toWorkCalendarOverrides(draft),
        adjustment: draft.adjustment,
      })
      if (generation === requestGeneration.current) setImpact(previewed)
    } catch (error) {
      if (generation === requestGeneration.current) setErrorMessage(readErrorMessage(error, t))
    } finally {
      setIsBusy(false)
    }
  }

  /** Saves the previewed change and applies it to the Work Items that follow the calendar. */
  async function save() {
    if (!teamId || !draft || !impact) return
    setIsBusy(true)
    setErrorMessage(undefined)
    saveContext.current ??= createMutationRequestContext()
    try {
      const saved = await saveWorkCalendar(accessToken, teamId, {
        ...(projectId ? { projectId } : {}),
        overrides: toWorkCalendarOverrides(draft),
        adjustment: draft.adjustment,
        expectedRevision: baseRevision,
      }, saveContext.current)
      saveContext.current = undefined
      setResult(saved)
      setImpact(undefined)
      setDraftState(undefined)
      await query.mutate()
    } catch (error) {
      setErrorMessage(readErrorMessage(error, t))
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <WorkCalendarPanel
      calendar={calendar}
      draft={draft}
      errorMessage={errorMessage ?? (query.error ? readErrorMessage(query.error, t) : undefined)}
      impact={impact}
      isBusy={isBusy}
      isLoading={query.isLoading}
      onDraftChange={(value) => {
        if (!scope || !calendar) return
        resetOutcome()
        setDraftState({ scope: scope.value, baseRevision, value })
      }}
      onPreview={() => void preview()}
      onRetry={() => {
        resetOutcome()
        // Reloading starts again from the stored calendar, so a later save uses its new revision.
        setDraftState(undefined)
        void query.mutate()
      }}
      onSave={() => void save()}
      onScopeChange={(value) => {
        resetOutcome()
        setDraftState(undefined)
        setSelectedScope(value)
      }}
      result={result}
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

/**
 * Picks the message of a failed calendar request.
 *
 * @param error - Thrown error.
 * @param t - Translator.
 * @returns A message for the member.
 */
function readErrorMessage(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof WorkspaceAccessApiError) {
    if (error.status === 409) return t('workspace.workCalendar.error.conflict')
    if (error.status === 413) return t('workspace.workCalendar.error.tooLarge')
    if (error.status === 403) return t('workspace.workCalendar.error.forbidden')
  }
  return t('workspace.workCalendar.error.failed')
}
