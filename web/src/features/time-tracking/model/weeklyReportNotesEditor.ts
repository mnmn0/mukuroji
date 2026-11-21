import type { WeeklyReportResponse } from '@mukuroji/contracts'
import type { PersonalWeeklyReportNotes } from './personalWeeklyReport'

/** Saved notes and the revision they were read at. */
export type WeeklyReportNotesBase = {
  /** Saved revision; 0 when nothing was saved. */
  revision: number
  /** Notes saved at that revision. */
  notes: PersonalWeeklyReportNotes
}

/** State of the notes editor. */
export type WeeklyReportEditorState = {
  /** Notes as the member is typing them. */
  notes: PersonalWeeklyReportNotes
  /** Saved notes the edit started from; a save expects this revision. */
  base: WeeklyReportNotesBase
  /** Saved report the state was last reconciled with. */
  seen: WeeklyReportResponse
}

/** Notes of a week nothing was saved for. */
const emptyWeeklyReportNotes: PersonalWeeklyReportNotes = { issues: '', reflection: '' }

/**
 * Tells whether two sets of notes are the same once surrounding whitespace is ignored, as the
 * server stores them trimmed.
 *
 * @param left - First notes.
 * @param right - Second notes.
 * @returns Whether both fields match.
 */
export function sameWeeklyReportNotes(left: PersonalWeeklyReportNotes, right: PersonalWeeklyReportNotes) {
  return left.issues.trim() === right.issues.trim() && left.reflection.trim() === right.reflection.trim()
}

/**
 * Reads the saved notes and their revision from a saved report.
 *
 * @param savedReport - Saved report.
 * @returns Saved revision and notes.
 */
export function readWeeklyReportSavedBase(savedReport: WeeklyReportResponse): WeeklyReportNotesBase {
  return { revision: savedReport.draft?.revision ?? 0, notes: savedReport.draft?.notes ?? emptyWeeklyReportNotes }
}

/**
 * Reconciles the editor with a newly read saved report. Notes without unsaved changes follow the
 * saved notes; unsaved changes are kept and stay tied to the revision they started from, so saving
 * them over notes saved elsewhere is refused until the member chooses.
 *
 * @param state - Current state, or undefined before the first read.
 * @param savedReport - Saved report just read.
 * @returns The next state.
 */
export function reconcileWeeklyReportEditor(state: WeeklyReportEditorState | undefined, savedReport: WeeklyReportResponse): WeeklyReportEditorState {
  const saved = readWeeklyReportSavedBase(savedReport)
  if (!state || state.base.revision === saved.revision) {
    return { notes: state?.notes ?? saved.notes, base: saved, seen: savedReport }
  }
  // No unsaved changes, or the save that produced this revision was this editor's own.
  if (sameWeeklyReportNotes(state.notes, state.base.notes) || sameWeeklyReportNotes(state.notes, saved.notes)) {
    return { notes: sameWeeklyReportNotes(state.notes, saved.notes) ? state.notes : saved.notes, base: saved, seen: savedReport }
  }
  return { ...state, seen: savedReport }
}
