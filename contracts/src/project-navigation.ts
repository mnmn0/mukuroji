/** Maximum number of projects retained in one viewer's quick-access preference. */
export const PROJECT_QUICK_ACCESS_MAX_ITEMS = 100

/** Identifies one Team-owned Project in a viewer's quick-access order. */
export type ProjectQuickAccessItem = {
  /** ID of the Team that owns the Project. */
  teamId: string
  /** ID of the Project shown in quick access. */
  projectId: string
}

/** Versioned quick-access preference returned to an authenticated viewer. */
export type ProjectQuickAccessPreferences = {
  /** Projects in the stable order chosen by the viewer. */
  items: ProjectQuickAccessItem[]
  /** Compare-and-swap revision used to reject stale updates. */
  revision: number
}

/** Input used to replace an authenticated viewer's quick-access order. */
export type UpdateProjectQuickAccessPreferencesInput = {
  /** Complete next Project order. */
  items: ProjectQuickAccessItem[]
  /** Revision read before constructing this update. */
  revision: number
}
