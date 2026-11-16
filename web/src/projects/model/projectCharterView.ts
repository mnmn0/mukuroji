import type {
  ProjectCharter,
  ProjectLifecycleState,
  UpdateProjectCharterInput,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Editable text values of the charter form. */
export type ProjectCharterFormValues = {
  /** Project code. */
  code: string
  /** Purpose text. */
  purpose: string
  /** Description text. */
  description: string
  /** Owner member key, or empty. */
  ownerUserId: string
  /** Sponsor member key, or empty. */
  sponsorUserId: string
  /** Planned start date. */
  plannedStartDate: string
  /** Planned end date. */
  plannedEndDate: string
  /** Comma-separated tags. */
  tags: string
  /** Newline-separated repository URLs. */
  repositoryUrls: string
}

/** Badge colors for each lifecycle state. */
export const projectLifecycleClassNames: Record<ProjectLifecycleState, string> = {
  proposed: 'border-violet-200 bg-violet-50 text-fg-violet-700',
  approved: 'border-sky-200 bg-sky-50 text-fg-sky-700',
  active: 'border-emerald-200 bg-emerald-50 text-fg-emerald-700',
  'on-hold': 'border-amber-200 bg-amber-50 text-fg-amber-800',
  closed: 'border-slate-300 bg-slate-100 text-fg-slate-700',
  archived: 'border-slate-200 bg-slate-50 text-fg-slate-600',
}

/**
 * Returns the message key of a lifecycle state label.
 *
 * @param state - Lifecycle state.
 * @returns The message key of its label.
 */
export function projectLifecycleMessageKey(state: ProjectLifecycleState): MessageKey {
  return `projects.lifecycle.${state}`
}

/**
 * Converts a charter into editable form values.
 *
 * @param charter - Stored charter.
 * @returns Form values.
 */
export function createProjectCharterFormValues(charter: ProjectCharter): ProjectCharterFormValues {
  return {
    code: charter.code ?? '',
    purpose: charter.purpose ?? '',
    description: charter.description ?? '',
    ownerUserId: charter.owner?.userId ?? '',
    sponsorUserId: charter.sponsor?.userId ?? '',
    plannedStartDate: charter.plannedStartDate ?? '',
    plannedEndDate: charter.plannedEndDate ?? '',
    tags: charter.tags.join(', '),
    repositoryUrls: charter.repositoryUrls.join('\n'),
  }
}

/**
 * Builds the charter replacement request from form values.
 *
 * @param values - Form values.
 * @param expectedRevision - Revision that was read.
 * @returns The update request; blank values are omitted so the server clears them.
 */
export function createProjectCharterUpdateInput(
  values: ProjectCharterFormValues,
  expectedRevision: number,
): UpdateProjectCharterInput {
  const optional = (value: string) => value.trim() || undefined
  const charter: UpdateProjectCharterInput['charter'] = {
    tags: values.tags.split(/[,、]/u).map((tag) => tag.trim()).filter(Boolean),
    repositoryUrls: values.repositoryUrls.split(/\r?\n/u).map((url) => url.trim()).filter(Boolean),
  }
  const code = optional(values.code)
  const purpose = optional(values.purpose)
  const description = optional(values.description)
  const ownerUserId = optional(values.ownerUserId)
  const sponsorUserId = optional(values.sponsorUserId)
  const plannedStartDate = optional(values.plannedStartDate)
  const plannedEndDate = optional(values.plannedEndDate)
  if (code) charter.code = code
  if (purpose) charter.purpose = purpose
  if (description) charter.description = description
  if (ownerUserId) charter.ownerUserId = ownerUserId
  if (sponsorUserId) charter.sponsorUserId = sponsorUserId
  if (plannedStartDate) charter.plannedStartDate = plannedStartDate
  if (plannedEndDate) charter.plannedEndDate = plannedEndDate
  return { expectedRevision, charter }
}


/** A Workspace member offered as a charter owner or sponsor. */
export type ProjectCharterPersonCandidate = {
  /** Member key sent as `ownerUserId` or `sponsorUserId`. */
  id: string
  /** Email address shown next to the name. */
  email: string
  /** Optional display name. */
  name?: string
}

/**
 * Lists active Workspace members as charter owner and sponsor candidates.
 *
 * The owner or sponsor need not belong to the Project, so candidates come from the Workspace
 * rather than the Project's access list. The server accepts any active Workspace member.
 *
 * @param members - Workspace members visible to the viewer.
 * @returns Active members ordered by display name.
 */
export function createProjectCharterPersonCandidates(
  members: readonly {
    /** Stable member key. */
    memberKey: string
    /** Email address. */
    email: string
    /** Optional display name. */
    name?: string
    /** Workspace membership status. */
    status: string
  }[],
): ProjectCharterPersonCandidate[] {
  return members
    .filter((member) => member.status === 'active')
    .map((member) => ({
      id: member.memberKey,
      email: member.email,
      ...(member.name ? { name: member.name } : {}),
    }))
    .sort((left, right) => (left.name ?? left.email).localeCompare(right.name ?? right.email))
}
