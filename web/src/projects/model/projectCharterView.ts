import {
  PROJECT_CHARTER_TAG_SEPARATOR_PATTERN,
  type ProjectCharter,
  type ProjectLifecycleState,
  type UpdateProjectCharterInput,
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

/** An unsaved charter form and the revision it was based on. */
export type ProjectCharterDraft = {
  /** Charter revision the draft started from. */
  revision: number
  /** Edited form values. */
  values: ProjectCharterFormValues
}

/** Identity of one shown charter panel, compared by reference. */
export type ProjectCharterDraftOwner = object

/** Keeps unsaved charter drafts per Team and Project while their panel is not shown. */
export type ProjectCharterDraftStore = {
  /** Returns the draft kept for one Project. */
  read(teamId: string, projectId: string): ProjectCharterDraft | undefined
  /** Makes a newly shown panel the only one that may change the draft of one Project. */
  claim(teamId: string, projectId: string, owner: ProjectCharterDraftOwner): void
  /**
   * Keeps or, with undefined, forgets the draft of one Project when `owner` is the panel that
   * last claimed it. A panel replaced by a newer one, such as one whose save completes after the
   * Project was shown again, then cannot change the newer panel's draft.
   */
  write(
    teamId: string,
    projectId: string,
    draft: ProjectCharterDraft | undefined,
    owner: ProjectCharterDraftOwner,
  ): void
}

/**
 * Creates an in-memory draft store scoped to the Team and Project pair.
 *
 * @returns A store whose drafts live as long as the store itself.
 */
export function createProjectCharterDraftStore(): ProjectCharterDraftStore {
  const drafts = new Map<string, ProjectCharterDraft>()
  const owners = new Map<string, ProjectCharterDraftOwner>()
  const keyOf = (teamId: string, projectId: string) => JSON.stringify([teamId, projectId])
  return {
    read: (teamId, projectId) => drafts.get(keyOf(teamId, projectId)),
    claim: (teamId, projectId, owner) => {
      owners.set(keyOf(teamId, projectId), owner)
    },
    write: (teamId, projectId, draft, owner) => {
      if (owners.get(keyOf(teamId, projectId)) !== owner) return
      if (draft) drafts.set(keyOf(teamId, projectId), draft)
      else drafts.delete(keyOf(teamId, projectId))
    },
  }
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
    // A stored tag never contains a separator, so splitting the joined form restores the list.
    tags: values.tags.split(PROJECT_CHARTER_TAG_SEPARATOR_PATTERN).map((tag) => tag.trim()).filter(Boolean),
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
