import type { WorkflowStatusCategory } from './work-item-configuration'

/** Maximum number of Collections in one Workspace. */
export const COLLECTION_LIMIT = 200

/** Maximum number of Work Item references in one Collection. */
export const COLLECTION_ITEM_LIMIT = 200

/** Maximum length of a Collection name. */
export const COLLECTION_NAME_MAX_LENGTH = 120

/** Maximum length of a Collection description. */
export const COLLECTION_DESCRIPTION_MAX_LENGTH = 1000

/**
 * Maximum length of a canonical Team or Work Item identifier that a Collection references,
 * matching Planning input rules; candidate search keywords accept the same length so an
 * exact Work Item ID can always be entered.
 */
export const COLLECTION_WORK_ITEM_IDENTIFIER_MAX_LENGTH = 256

/**
 * Organizing folder that references canonical Work Items without owning them.
 *
 * A Collection has no workflow, assignee, or status of its own, and adding a Work Item
 * never copies it or widens who can read it.
 */
export type WorkItemCollection = {
  /** Server-generated Collection identifier. */
  collectionId: string
  /** Display name. */
  name: string
  /** Optional purpose shown with the name. */
  description?: string
  /** Member key of the creator. */
  createdBy: string
  /** ISO timestamp of creation. */
  createdAt: string
  /** ISO timestamp of the last change to the name, description, or items. */
  updatedAt: string
  /** Optimistic concurrency revision, starting at 1. */
  revision: number
}

/** Response of the Collection list endpoint. */
export type WorkItemCollectionsResponse = {
  /** Collections in the Workspace, ordered by name. */
  collections: WorkItemCollection[]
  /** Whether the caller may create, change, and delete Collections. */
  canWrite: boolean
}

/** Request body that creates a Collection. */
export type CreateWorkItemCollectionInput = {
  /** Display name. */
  name: string
  /** Optional purpose. */
  description?: string
}

/** Request body that renames or re-describes a Collection. */
export type UpdateWorkItemCollectionInput = {
  /** Revision the caller last observed. */
  expectedRevision: number
  /** New display name, when changed. */
  name?: string
  /** New purpose; an empty string clears it. */
  description?: string
}

/** One readable Work Item placed in a Collection. */
export type WorkItemCollectionEntry = {
  /** Team that owns the canonical Work Item. */
  teamId: string
  /** Work Item identifier within the Team. */
  issueId: string
  /** Current canonical title. */
  title: string
  /** Current workflow status category. */
  statusCategory: WorkflowStatusCategory
  /** Primary Project, when the Work Item has one. */
  assignedProjectId?: string
  /** ISO timestamp when the reference was added. */
  addedAt: string
}

/**
 * Response of adding a Work Item to a Collection.
 *
 * Besides the Collection metadata, it carries the Work Item as the caller can read it,
 * so a client can show the new reference without reloading the item list.
 */
export type AddWorkItemCollectionItemResponse = WorkItemCollection & {
  /** The added Work Item, or the existing reference when it was already present. */
  item: WorkItemCollectionEntry
}

/**
 * Response of the Collection item endpoint.
 *
 * Only Work Items the caller can already read are listed; references to other
 * Work Items are omitted without revealing that they exist.
 */
export type WorkItemCollectionItemsResponse = {
  /** The Collection itself. */
  collection: WorkItemCollection
  /** Readable Work Items, most recently added first. */
  items: WorkItemCollectionEntry[]
}
