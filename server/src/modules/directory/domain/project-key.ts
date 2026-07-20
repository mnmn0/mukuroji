/**
 * Workspace directory と Project の canonical storage relationship ID を生成します。
 */
export function createDirectoryProjectId(
  directoryId: string,
  projectId: string,
): string {
  return `${directoryId}#project#${projectId}`
}
