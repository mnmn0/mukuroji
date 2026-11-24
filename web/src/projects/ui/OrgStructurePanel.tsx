import { useMemo, useState, type FormEvent } from 'react'
import { useSWRConfig } from 'swr'
import {
  ORG_UNIT_NAME_MAX_LENGTH,
  type OrgStructure,
} from '@mukuroji/contracts'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import { ProjectDirectoryApiError } from '../api/errors'
import { replaceOrgStructure } from '../api/orgStructure'
import {
  addOrgUnit,
  assignTeamToOrgUnit,
  createOrgUnitId,
  listOrgUnitParentCandidates,
  listOrgUnitTreeRows,
  moveOrgUnit,
  removeOrgUnit,
  renameOrgUnit,
  type OrgStructureDraft,
} from '../model/orgStructure'
import { isOrgStructureKey, useOrgStructure } from '../queries/useOrgStructure'

/** Team offered in the membership list. */
export type OrgStructurePanelTeam = {
  /** Team identifier. */
  id: string
  /** Display name. */
  name: string
}

/** Props of the OrgUnit structure container. */
type OrgStructurePanelContainerProps = {
  /** Bearer token of the Workspace administrator. */
  accessToken: string
  /** Locale of labels. */
  locale: Locale
  /** Active Teams of the Workspace. */
  teams: readonly OrgStructurePanelTeam[]
}

/**
 * Loads the OrgUnit structure and saves the administrator's edits as one replacement.
 *
 * @param props - Authenticated settings inputs.
 * @returns The OrgUnit structure panel.
 */
export function OrgStructurePanelContainer({ accessToken, locale, teams }: OrgStructurePanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const query = useOrgStructure(accessToken)
  const { mutate } = useSWRConfig()
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; key: MessageKey }>()

  if (!query.data) {
    return (
      <section className="workbench-panel p-5" data-testid="org-structure-loading">
        {query.error ? t('projects.orgUnits.loadError') : t('projects.orgUnits.loading')}
        {query.error ? (
          <button className="workbench-button-secondary ml-3 min-h-10 px-4" onClick={() => void query.mutate()} type="button">
            {t('projects.administration.retry')}
          </button>
        ) : null}
      </section>
    )
  }

  /** Saves the draft over the revision it was edited from. */
  const save = async (draft: OrgStructureDraft) => {
    if (isSaving || !query.data) return false
    setIsSaving(true)
    setMessage(undefined)
    try {
      const saved = await replaceOrgStructure(
        accessToken,
        { expectedRevision: query.data.revision, ...draft },
        createMutationRequestContext(),
      )
      await query.mutate(saved, { revalidate: false })
      await mutate(isOrgStructureKey)
      setMessage({ tone: 'success', key: 'projects.orgUnits.saved' })
      return true
    } catch (error) {
      setMessage({ tone: 'error', key: readOrgStructureErrorKey(error) })
      await query.mutate()
      return false
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <OrgStructurePanel
      // A newly loaded revision restarts the editor from the stored structure.
      key={query.data.revision}
      isSaving={isSaving}
      structure={query.data}
      t={t}
      teams={teams}
      onSave={save}
      {...(message ? { message: { tone: message.tone, text: t(message.key) } } : {})}
    />
  )
}

/**
 * Maps a failed save to its message.
 *
 * @param error - Error of the save.
 * @returns The message key.
 */
function readOrgStructureErrorKey(error: unknown): MessageKey {
  if (error instanceof ProjectDirectoryApiError) {
    if (error.code === 'OrgStructureConflict') return 'projects.orgUnits.error.conflict'
    if (error.code === 'InvalidOrgStructure') return 'projects.orgUnits.error.invalid'
    if (error.status === 403) return 'projects.orgUnits.error.denied'
  }
  return 'projects.administration.error.action'
}

/** Props of the OrgUnit structure editor. */
export type OrgStructurePanelProps = {
  /** Stored structure the editor starts from. */
  structure: OrgStructure
  /** Active Teams of the Workspace. */
  teams: readonly OrgStructurePanelTeam[]
  /** Whether a save is in flight. */
  isSaving: boolean
  /** Result of the last save. */
  message?: { tone: 'error' | 'success'; text: string }
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Saves the edited structure; resolves to whether it succeeded. */
  onSave: (draft: OrgStructureDraft) => Promise<boolean>
}

/**
 * Lets a Workspace administrator edit the OrgUnit tree and which OrgUnit each Team belongs to.
 *
 * Every editing control is disabled while a save is in flight: a successful save loads a new
 * revision that restarts the editor, so an edit made meanwhile would be lost.
 *
 * @param props - Stored structure, Teams, and save callback.
 * @returns The OrgUnit structure editor.
 */
export function OrgStructurePanel({ structure, teams, isSaving, message, t, onSave }: OrgStructurePanelProps) {
  const [draft, setDraft] = useState<OrgStructureDraft>({
    orgUnits: structure.orgUnits,
    teamAssignments: structure.teamAssignments,
  })
  const [newName, setNewName] = useState('')
  const [newParentId, setNewParentId] = useState('')
  const rows = listOrgUnitTreeRows(draft.orgUnits)
  const pathLabel = (orgUnitId: string) => {
    const row = rows.find((candidate) => candidate.orgUnit.id === orgUnitId)
    return row ? `${'　'.repeat(row.depth)}${row.orgUnit.name}` : orgUnitId
  }
  const isDirty = JSON.stringify(draft) !== JSON.stringify({
    orgUnits: structure.orgUnits,
    teamAssignments: structure.teamAssignments,
  })

  /** Adds the OrgUnit typed in the add form. */
  const submitNew = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = newName.trim()
    if (isSaving || !name) return
    setDraft(addOrgUnit(draft, {
      id: createOrgUnitId(),
      name,
      ...(newParentId ? { parentId: newParentId } : {}),
    }))
    setNewName('')
  }

  return (
    <section aria-busy={isSaving} className="workbench-panel" data-testid="org-structure-panel">
      <SectionHeader meta={t('projects.orgUnits.description')} title={t('projects.orgUnits.title')} />
      <div className="grid gap-4 px-5 pb-5">
        {message ? (
          <p
            className={message.tone === 'error'
              ? 'rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-fg-red-700'
              : 'rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-fg-emerald-800'}
            role={message.tone === 'error' ? 'alert' : 'status'}
          >
            {message.text}
          </p>
        ) : null}
        <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={submitNew}>
          <label className="grid gap-1 text-xs font-semibold">
            {t('projects.orgUnits.name')}
            <input
              className="workbench-input min-h-10 px-3 text-sm font-normal"
              data-testid="org-structure-new-name"
              disabled={isSaving}
              maxLength={ORG_UNIT_NAME_MAX_LENGTH}
              onChange={(event) => setNewName(event.target.value)}
              value={newName}
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold">
            {t('projects.orgUnits.parent')}
            <select
              className="workbench-input min-h-10 px-3 text-sm font-normal"
              disabled={isSaving}
              onChange={(event) => setNewParentId(event.target.value)}
              value={newParentId}
            >
              <option value="">{t('projects.orgUnits.topLevel')}</option>
              {rows.map((row) => (
                <option key={row.orgUnit.id} value={row.orgUnit.id}>{pathLabel(row.orgUnit.id)}</option>
              ))}
            </select>
          </label>
          <button className="workbench-button-secondary min-h-10 px-4" disabled={isSaving || !newName.trim()} type="submit">
            {t('projects.orgUnits.add')}
          </button>
        </form>
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--workbench-muted)]">{t('projects.orgUnits.empty')}</p>
        ) : (
          <ol className="grid gap-2" data-testid="org-structure-units">
            {rows.map(({ orgUnit, depth }) => (
              <li
                className="flex min-w-0 flex-wrap items-end gap-2 rounded-lg border border-[var(--workbench-border)] p-2"
                key={orgUnit.id}
                style={{ marginInlineStart: `${depth * 16}px` }}
              >
                <label className="grid min-w-40 flex-1 gap-1 text-xs font-semibold">
                  {t('projects.orgUnits.name')}
                  <input
                    className="workbench-input min-h-9 px-3 text-sm font-normal"
                    disabled={isSaving}
                    maxLength={ORG_UNIT_NAME_MAX_LENGTH}
                    onChange={(event) => setDraft(renameOrgUnit(draft, orgUnit.id, event.target.value))}
                    value={orgUnit.name}
                  />
                </label>
                <label className="grid min-w-40 flex-1 gap-1 text-xs font-semibold">
                  {t('projects.orgUnits.parent')}
                  <select
                    className="workbench-input min-h-9 px-3 text-sm font-normal"
                    disabled={isSaving}
                    onChange={(event) => setDraft(moveOrgUnit(draft, orgUnit.id, event.target.value || undefined))}
                    value={orgUnit.parentId ?? ''}
                  >
                    <option value="">{t('projects.orgUnits.topLevel')}</option>
                    {listOrgUnitParentCandidates(draft.orgUnits, orgUnit.id).map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{pathLabel(candidate.id)}</option>
                    ))}
                  </select>
                </label>
                <button
                  aria-label={t('projects.orgUnits.remove').replace('{name}', orgUnit.name)}
                  className="workbench-button-secondary min-h-9 px-3"
                  disabled={isSaving}
                  onClick={() => setDraft(removeOrgUnit(draft, orgUnit.id))}
                  type="button"
                >
                  {t('projects.orgUnits.removeShort')}
                </button>
              </li>
            ))}
          </ol>
        )}
        {teams.length > 0 ? (
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('projects.orgUnits.teams')}</h3>
            <ul className="grid gap-2 sm:grid-cols-2" data-testid="org-structure-teams">
              {teams.map((team) => (
                <li className="grid gap-1" key={team.id}>
                  <label className="grid gap-1 text-xs font-semibold">
                    {team.name}
                    <select
                      className="workbench-input min-h-9 px-3 text-sm font-normal"
                      disabled={isSaving}
                      onChange={(event) => setDraft(assignTeamToOrgUnit(draft, team.id, event.target.value || undefined))}
                      value={draft.teamAssignments.find((assignment) => assignment.teamId === team.id)?.orgUnitId ?? ''}
                    >
                      <option value="">{t('projects.orgUnits.noOrgUnit')}</option>
                      {rows.map((row) => (
                        <option key={row.orgUnit.id} value={row.orgUnit.id}>{pathLabel(row.orgUnit.id)}</option>
                      ))}
                    </select>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="workbench-button-primary min-h-10 px-4"
            disabled={isSaving || !isDirty || draft.orgUnits.some((orgUnit) => !orgUnit.name.trim())}
            onClick={() => void onSave({
              orgUnits: draft.orgUnits.map((orgUnit) => ({ ...orgUnit, name: orgUnit.name.trim() })),
              teamAssignments: draft.teamAssignments,
            })}
            type="button"
          >
            {isSaving ? t('projects.orgUnits.saving') : t('projects.administration.save')}
          </button>
          <p className="text-xs text-[var(--workbench-muted)]">{t('projects.orgUnits.accessNote')}</p>
        </div>
      </div>
    </section>
  )
}
