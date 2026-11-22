import type { CanonicalWorkItem, WorkItemScheduleDependency } from '@mukuroji/contracts'
import { getPlanningSnapshot } from '../../planning/api/snapshot'
import { loadTeamWorkItemHierarchies } from '../../work-items/queries/teamWorkItemHierarchies'
import { listDeveloperExportWorkItems } from '../api/transfers'
import {
  createDeveloperExportFile,
  type DeveloperExportContext,
  type DeveloperExportFile,
  type DeveloperExportFormat,
} from '../model/transfers'

/**
 * Work Item export file を Authorization header 付きで取得し、階層と依存を付けて file にします。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param format - Export format; the workbook and MS Project files are built from the JSON export.
 * @returns Browser download に使う Blob と file 名です。
 */
export async function exportDeveloperWorkItems(
  accessToken: string,
  format: DeveloperExportFormat,
): Promise<DeveloperExportFile> {
  const workItems = await listDeveloperExportWorkItems(accessToken, format === 'csv' ? 'csv' : 'json')
  return createDeveloperExportFile(
    format,
    workItems,
    await readDeveloperExportContext(accessToken, workItems),
  )
}

/**
 * Reads the hierarchy and schedule dependencies of the exported Work Items.
 *
 * Each Team is read once. A Team whose hierarchy cannot be read, such as one too large for a
 * single tree, leaves its Work Items without a WBS number or parent, and dependencies that cannot
 * be read leave the dependency cells empty, instead of failing the export.
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param workItems - Exported Work Items.
 * @returns Hierarchies by Team and the Workspace's dependencies.
 */
async function readDeveloperExportContext(
  accessToken: string,
  workItems: readonly CanonicalWorkItem[],
): Promise<DeveloperExportContext> {
  const teamIds = [...new Set(workItems.map((workItem) => workItem.teamId))]
  if (teamIds.length === 0) return { hierarchies: new Map(), dependencies: [] }
  const [hierarchies, dependencies] = await Promise.all([
    loadTeamWorkItemHierarchies(teamIds, accessToken),
    readDeveloperExportDependencies(accessToken),
  ])
  return { hierarchies: hierarchies.nodesByTeam, dependencies }
}

/**
 * Reads the Workspace's schedule dependencies.
 *
 * A failed read fails the export, because a file with empty dependency cells would lose the
 * dependencies when it is imported again.
 *
 * @param accessToken - Authorization header に使う access token です。
 * @returns Dependencies.
 */
async function readDeveloperExportDependencies(accessToken: string): Promise<readonly WorkItemScheduleDependency[]> {
  return (await getPlanningSnapshot(accessToken)).workItemDependencies
}
