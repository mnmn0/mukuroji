import type {
  ResolvedWorkItemConfiguration,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import type { ProjectTask } from '../api/tasks'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { ProjectFilesPanel } from '../../files/ui/ProjectFilesPanel'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../issues/model/workItemDisplay'
import {
  resolveWorkItemWorkflowStatusLabel,
  resolveWorkflowCategoryToneClassName,
  resolveWorkflowStatusCategory,
} from '../../work-items/model/workItemDisplay'
import { createTaskKey, resolveProjectTaskConfiguration } from '../model/taskView'
import {
  TaskViewHeading,
} from './TaskViewPrimitives'

/** Resolves a localized task-file message. */
type TaskFileTranslator = (key: MessageKey) => string

/** Props for the independent project task file view. */
export type TaskFileViewProps = {
  /** Fallback configuration used for a single-team project view. */
  configuration?: WorkItemConfiguration
  /** Team-scoped resolved configurations used by the fallback task list. */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Current workspace member used by file actions. */
  currentWorkspaceMemberKey?: string
  /** Locale used by the project file panel. */
  locale: Locale
  /** Project file state and mutation controller. */
  projectFiles?: FileArtifactsController
  /** Filtered tasks used by the compatibility fallback list. */
  tasks: ProjectTask[]
  /** Translator used for file-view labels. */
  t: TaskFileTranslator
  /** Workspace members used for file actor labels and permissions. */
  workspaceMembers: WorkspaceMember[]
}

/** Props for the compatibility task list shown without a project-file controller. */
type TaskFileFallbackListProps = {
  /** Fallback configuration used for a single-team project view. */
  configuration?: WorkItemConfiguration
  /** Team-scoped resolved configurations used by each row. */
  configurationsByTeam: Record<string, ResolvedWorkItemConfiguration>
  /** Tasks represented by fallback rows. */
  tasks: ProjectTask[]
  /** Translator used for fallback-list labels. */
  t: TaskFileTranslator
}

/**
 * Renders the project file controller or the existing task-based compatibility list.
 *
 * @param props - File controller, fallback tasks, configuration, and member data.
 * @returns The independent project task file view.
 */
export function TaskFileView({
  configuration,
  configurationsByTeam,
  currentWorkspaceMemberKey,
  locale,
  projectFiles,
  tasks,
  t,
  workspaceMembers,
}: TaskFileViewProps) {
  return (
    <div className="px-[clamp(18px,2.5vw,30px)] py-4">
      {projectFiles ? (
        <>
          <TaskViewHeading
            count={projectFiles.files.length}
            meta={t('files.description')}
            t={t}
            titleKey="tasks.view.file"
          />
          <ProjectFilesPanel
            controller={projectFiles}
            currentMemberKey={currentWorkspaceMemberKey}
            locale={locale}
            members={workspaceMembers}
          />
        </>
      ) : (
        <TaskFileFallbackList
          configuration={configuration}
          configurationsByTeam={configurationsByTeam}
          t={t}
          tasks={tasks}
        />
      )}
    </div>
  )
}

/**
 * Renders the legacy task metadata table used when no project-file controller is available.
 *
 * @param props - Tasks, workflow configurations, and localization inputs.
 * @returns The fallback task file list.
 */
function TaskFileFallbackList({
  configuration,
  configurationsByTeam,
  t,
  tasks,
}: TaskFileFallbackListProps) {
  return (
    <section
      aria-label={t('tasks.view.file')}
      className="workbench-table mt-3 overflow-hidden"
    >
      <TaskViewHeading
        count={tasks.length}
        meta={t('tasks.file.description')}
        t={t}
        titleKey="tasks.view.file"
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="workbench-table-head">
              <th className="px-4 py-2.5" scope="col">{t('tasks.file.column.name')}</th>
              <th className="px-4 py-2.5" scope="col">{t('tasks.file.column.owner')}</th>
              <th className="px-4 py-2.5" scope="col">{t('tasks.column.dueDate')}</th>
              <th className="px-4 py-2.5" scope="col">{t('tasks.file.column.status')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr className="border-b border-[#e4e7ec] text-sm font-medium text-[#1c1d1f] last:border-b-0" key={createTaskKey(task)}>
                <td className="px-4 py-3 font-semibold">{resolveWorkItemTitle(task)}</td>
                <td className="px-4 py-3 text-[#505967]">{resolveWorkItemAssignee(task)}</td>
                <td className="px-4 py-3 text-[#5f6874]">{task.dueDate}</td>
                <td className="px-4 py-3">
                  <span className={resolveWorkflowCategoryToneClassName(
                    resolveWorkflowStatusCategory(task),
                  )}>
                    {resolveWorkItemWorkflowStatusLabel(
                      task,
                      resolveProjectTaskConfiguration(
                        task,
                        configurationsByTeam,
                        configuration,
                      ),
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
