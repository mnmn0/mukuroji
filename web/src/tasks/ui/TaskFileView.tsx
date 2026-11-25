import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { triggerDeveloperExportDownload } from '../../shared/lib/files/fileDownload'
import type { WorkspaceMember } from '../../workspace/api'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import type { ProjectDeliverablesController } from '../../files/queries/useProjectDeliverables'
import { ProjectDeliverablesPanel } from '../../files/ui/ProjectDeliverablesPanel'
import { ProjectFilesPanel } from '../../files/ui/ProjectFilesPanel'
import {
  TaskViewHeading,
} from './TaskViewPrimitives'

/** Resolves a localized task-file message. */
type TaskFileTranslator = (key: MessageKey) => string

/** Props for the independent project task file view. */
export type TaskFileViewProps = {
  /** Current workspace member used by file actions. */
  currentWorkspaceMemberKey?: string
  /** Locale used by the project file panel. */
  locale: Locale
  /** Project file state and mutation controller. */
  projectFiles: FileArtifactsController
  /** Deliverables of the Project and its readable Work Items; the list is hidden without it. */
  projectDeliverables?: ProjectDeliverablesController
  /** Project ID used to name the deliverables CSV. */
  projectId?: string
  /** Translator used for file-view labels. */
  t: TaskFileTranslator
  /** Workspace members used for file actor labels and permissions. */
  workspaceMembers: WorkspaceMember[]
}

/**
 * Renders the Project file controller.
 *
 * @param props - File controller, locale, translator, and member data.
 * @returns The independent project task file view.
 */
export function TaskFileView({
  currentWorkspaceMemberKey,
  locale,
  projectDeliverables,
  projectFiles,
  projectId,
  t,
  workspaceMembers,
}: TaskFileViewProps) {
  return (
    <div className="px-[clamp(18px,2.5vw,30px)] py-4">
      <TaskViewHeading
        count={projectFiles.files.length}
        meta={t('files.description')}
        t={t}
        titleKey="tasks.view.file"
      />
      {projectDeliverables ? (
        <ProjectDeliverablesPanel
          controller={projectDeliverables}
          exportFileName={`${projectId ?? 'project'}-deliverables`}
          locale={locale}
          onDownloadCsv={downloadCsv}
        />
      ) : null}
      <ProjectFilesPanel
        controller={projectFiles}
        currentMemberKey={currentWorkspaceMemberKey}
        locale={locale}
        members={workspaceMembers}
      />
    </div>
  )
}

/**
 * Offers CSV text as a UTF-8 file download that spreadsheet apps read correctly.
 *
 * @param csv - CSV text.
 * @param fileName - Offered file name.
 */
function downloadCsv(csv: string, fileName: string) {
  triggerDeveloperExportDownload(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }), fileName)
}
