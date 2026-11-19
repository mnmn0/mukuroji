import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { createWorkItemWbsNumberIndex } from '../../work-items/model/workItemHierarchy'
import { loadTeamWorkItemHierarchies } from '../../work-items/queries/teamWorkItemHierarchies'
import { listDeveloperExportWorkItems } from '../api/transfers'
import {
  createDeveloperExportFile,
  type DeveloperExportFile,
  type DeveloperExportFormat,
} from '../model/transfers'

/**
 * Work Item export file を Authorization header 付きで取得し、各 Work Item に WBS 番号を付けます。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param format - CSV または JSON の export format です。
 * @returns Browser download に使う Blob と file 名です。
 */
export async function exportDeveloperWorkItems(
  accessToken: string,
  format: DeveloperExportFormat,
): Promise<DeveloperExportFile> {
  const workItems = await listDeveloperExportWorkItems(accessToken, format)
  return createDeveloperExportFile(
    format,
    workItems,
    await readDeveloperExportWbsNumbers(accessToken, workItems),
  )
}

/**
 * Reads the WBS number of each exported Work Item from its Team's hierarchy.
 *
 * Each Team is read once. A Team whose hierarchy cannot be read, such as one too large for a
 * single tree, leaves its Work Items without a number instead of failing the export.
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param workItems - Exported Work Items.
 * @returns WBS numbers by `createWorkItemOutlineKey` key.
 */
async function readDeveloperExportWbsNumbers(
  accessToken: string,
  workItems: readonly CanonicalWorkItem[],
): Promise<ReadonlyMap<string, string>> {
  const teamIds = [...new Set(workItems.map((workItem) => workItem.teamId))]
  if (teamIds.length === 0) return new Map()
  const hierarchies = await loadTeamWorkItemHierarchies(teamIds, accessToken)
  return createWorkItemWbsNumberIndex(hierarchies.nodesByTeam)
}
