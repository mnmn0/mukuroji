import {
  WORK_ITEM_JOB_ROLE_LIMIT,
  type WorkItemConfiguration,
  type WorkItemJobRoleDefinition,
} from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'

/**
 * Props accepted by the job role configuration section.
 */
export type JobRolesConfigurationSectionProps = {
  /** Configuration being edited. */
  configuration: WorkItemConfiguration
  /** IDs of job roles already saved; these can be archived but not removed. */
  savedJobRoleIds: ReadonlySet<string>
  /** Display locale. */
  locale: Locale
  /** Replaces the configuration draft. */
  onChange: (configuration: WorkItemConfiguration) => void
}

/**
 * Edits the job roles contributors can be planned against.
 *
 * Saved roles can be renamed or archived but not removed, because Work Items keep
 * referring to them by ID. Roles added in this draft can still be removed.
 *
 * @param props - Draft configuration, saved role IDs, and the change callback.
 * @returns The job role section.
 */
export function JobRolesConfigurationSection({
  configuration,
  locale,
  onChange,
  savedJobRoleIds,
}: JobRolesConfigurationSectionProps) {
  const t = createTranslator(locale)
  const jobRoles = configuration.jobRoles ?? []

  /**
   * Replaces the job role list in the draft.
   *
   * @param nextJobRoles - Updated job roles.
   */
  const updateJobRoles = (nextJobRoles: WorkItemJobRoleDefinition[]) => {
    onChange({ ...configuration, jobRoles: nextJobRoles })
  }

  /**
   * Replaces one job role.
   *
   * @param id - Job role to change.
   * @param patch - Fields to replace.
   */
  const updateJobRole = (id: string, patch: Partial<WorkItemJobRoleDefinition>) => {
    updateJobRoles(jobRoles.map((jobRole) => jobRole.id === id ? { ...jobRole, ...patch } : jobRole))
  }

  /** Adds a job role with a new stable ID. */
  const addJobRole = () => {
    const existingIds = new Set(jobRoles.map((jobRole) => jobRole.id))
    let id: string
    do {
      id = `role-${crypto.randomUUID()}`
    } while (existingIds.has(id))
    updateJobRoles([...jobRoles, { id, name: t('workItems.configuration.jobRoles.newRole') }])
  }

  return (
    <section className="workbench-panel overflow-hidden" data-testid="work-item-configuration-job-roles">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
        <div>
          <p className="workbench-eyebrow">{t('workItems.configuration.jobRoles.eyebrow')}</p>
          <h3 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
            {t('workItems.configuration.jobRoles.title')}
          </h3>
          <p className="mt-1 max-w-[760px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workItems.configuration.jobRoles.description')}
          </p>
        </div>
        <button
          className="workbench-button-secondary min-h-10 px-4"
          disabled={jobRoles.length >= WORK_ITEM_JOB_ROLE_LIMIT}
          onClick={addJobRole}
          type="button"
        >
          + {t('workItems.configuration.jobRoles.add')}
        </button>
      </div>

      <div className="grid gap-3 p-5">
        {jobRoles.map((jobRole, index) => (
          <div
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-3 max-[640px]:grid-cols-1"
            data-testid="work-item-configuration-job-role"
            key={jobRole.id}
          >
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {`${t('workItems.configuration.jobRoles.name')} ${index + 1}`}
              <input
                className="workbench-input min-h-10 w-full min-w-0 px-3"
                maxLength={160}
                onChange={(event) => updateJobRole(jobRole.id, { name: event.target.value })}
                required
                value={jobRole.name}
              />
            </label>
            <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              <input
                checked={jobRole.archived === true}
                onChange={(event) => updateJobRole(jobRole.id, { archived: event.target.checked })}
                type="checkbox"
              />
              {t('workItems.configuration.jobRoles.archived')}
            </label>
            {savedJobRoleIds.has(jobRole.id) ? (
              <span aria-hidden="true" />
            ) : (
              <button
                className="workbench-button-secondary min-h-10 px-3"
                onClick={() => updateJobRoles(jobRoles.filter((candidate) => candidate.id !== jobRole.id))}
                type="button"
              >
                {t('workItems.configuration.jobRoles.remove')}
              </button>
            )}
          </div>
        ))}
        {jobRoles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('workItems.configuration.jobRoles.empty')}
          </p>
        ) : null}
      </div>
    </section>
  )
}
