import type {
  TaskViewDisplayOptions,
  TaskViewPresentationSettings,
} from '../../task-views/model/taskViewPresentation'
import type { TaskGanttScale } from './taskGanttTimeline'

/** Gantt presentation choices that a saved task view can persist. */
export type TaskGanttDisplaySettings = {
  /** Requested timeline scale. */
  scale: TaskGanttScale
  /** Whether each row renders on one compact line. */
  isCompact: boolean
  /** Whether the progress line through today is drawn. */
  showsProgressLine: boolean
}

/**
 * Reads the Gantt settings stored in a task view's display options.
 *
 * @param display - Display options of the effective task view.
 * @returns Complete Gantt settings, with defaults for omitted options.
 */
export function readTaskGanttDisplaySettings(
  display: TaskViewDisplayOptions,
): TaskGanttDisplaySettings {
  return {
    isCompact: display.ganttCompactRows ?? false,
    scale: display.ganttScale ?? 'auto',
    showsProgressLine: display.ganttProgressLine ?? false,
  }
}

/**
 * Stores Gantt settings in a task view's presentation settings.
 *
 * @param presentation - Current presentation settings of the task view.
 * @param gantt - Next Gantt settings.
 * @returns Presentation settings carrying the Gantt settings as display options.
 */
export function applyTaskGanttDisplaySettings(
  presentation: TaskViewPresentationSettings,
  gantt: TaskGanttDisplaySettings,
): TaskViewPresentationSettings {
  return {
    ...presentation,
    display: {
      ...presentation.display,
      ganttCompactRows: gantt.isCompact,
      ganttProgressLine: gantt.showsProgressLine,
      ganttScale: gantt.scale,
    },
  }
}

/** Gantt props that bind the chart's display settings to a task view. */
export type TaskGanttDisplayBinding = {
  /** Display settings owned by the task view. */
  display?: TaskGanttDisplaySettings
  /** Stores changed display settings in the task view. */
  onDisplayChange?: (display: TaskGanttDisplaySettings) => void
}

/**
 * Binds a Gantt chart's display settings to the effective task view when the page can change it.
 *
 * @param presentation - Presentation settings of the effective task view.
 * @param onPresentationChange - Applies changed presentation settings to the task view.
 * @returns Gantt props, or none so the chart keeps its own settings.
 */
export function createTaskGanttDisplayBinding(
  presentation: TaskViewPresentationSettings | undefined,
  onPresentationChange: ((settings: TaskViewPresentationSettings) => void) | undefined,
): TaskGanttDisplayBinding {
  if (!presentation || !onPresentationChange) return {}
  return {
    display: readTaskGanttDisplaySettings(presentation.display),
    onDisplayChange: (display) => {
      onPresentationChange(applyTaskGanttDisplaySettings(presentation, display))
    },
  }
}
