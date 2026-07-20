import type { Locale } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import { IssueArtifactsPanel } from './IssueArtifactsPanel'
import type { FileArtifactsController } from '../mutations/useFileArtifacts'

/**
 * ProjectFilesPanel の props です。
 */
export type ProjectFilesPanelProps = {
  /**
   * Project file state と mutation を提供する controller です。
   */
  controller: FileArtifactsController
  /**
   * actor 表示に使う Workspace member 一覧です。
   */
  members: WorkspaceMember[]
  /**
   * 現在の Workspace member key です。
   */
  currentMemberKey?: string
  /**
   * 表示 locale です。
   */
  locale: Locale
}

/**
 * Project の File tab に実データを表示する広幅 panel です。
 */
export function ProjectFilesPanel({
  controller,
  currentMemberKey,
  locale,
  members,
}: ProjectFilesPanelProps) {
  return (
    <IssueArtifactsPanel
      className="mt-3 overflow-hidden rounded-xl border border-[var(--workbench-border)]"
      controller={controller}
      currentMemberKey={currentMemberKey}
      expanded
      locale={locale}
      members={members}
    />
  )
}
