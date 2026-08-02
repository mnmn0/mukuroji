import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { WorkloadHoliday, WorkloadSnapshot, WorkingSchedule } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createWorkloadAssignment,
  createWorkloadRequest,
  previewWorkloadAssignment,
  saveWorkloadProfile,
  saveWorkloadTimeOff,
  type CreateWorkloadAssignmentRequest,
  type CreateWorkloadRequestRequest,
  type SaveWorkloadProfileRequest,
} from '../api'

/** A Team member option used by workload planning controls. */
export type WorkloadPlanningMemberOption = {
  /** Stable member identifier. */
  id: string
  /** Display name. */
  name: string
  /** Optional email shown as a secondary label. */
  email?: string
}

/** A project option used when creating a resource request or assignment. */
export type WorkloadPlanningProjectOption = {
  /** Stable project identifier. */
  id: string
  /** Display name. */
  name: string
}

/** Props for the workload setup and planning controls. */
export type WorkloadPlanningControlsProps = {
  /** Authenticated API token. */
  accessToken?: string
  /** Current Team identifier. */
  teamId?: string
  /** Current snapshot used for optimistic concurrency and previews. */
  snapshot?: WorkloadSnapshot
  /** Members available for profile and assignment selection. */
  members: readonly WorkloadPlanningMemberOption[]
  /** Projects available for request and assignment selection. */
  projects: readonly WorkloadPlanningProjectOption[]
  /** Refreshes the workload snapshot after a successful mutation. */
  onSaved: () => Promise<void> | void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

const defaultWorkingSchedule: WorkingSchedule = {
  monday: { enabled: true, minutes: 480 },
  tuesday: { enabled: true, minutes: 480 },
  wednesday: { enabled: true, minutes: 480 },
  thursday: { enabled: true, minutes: 480 },
  friday: { enabled: true, minutes: 480 },
  saturday: { enabled: false, minutes: 0 },
  sunday: { enabled: false, minutes: 0 },
}

/**
 * Renders the forms that make a workload snapshot actionable from the Team screen.
 *
 * @param props - Authenticated Team data, options, and localized labels.
 * @returns Profile, time-off, request, assignment, and what-if controls.
 */
export function WorkloadPlanningControls({
  accessToken,
  members,
  onSaved,
  projects,
  snapshot,
  t,
  teamId,
}: WorkloadPlanningControlsProps) {
  const defaultMemberId = members[0]?.id ?? ''
  const [memberId, setMemberId] = useState(defaultMemberId)
  const [profileTimeZone, setProfileTimeZone] = useState('UTC')
  const [profileRole, setProfileRole] = useState('')
  const [profileSkills, setProfileSkills] = useState('')
  const [profileHours, setProfileHours] = useState('8')
  const [profileHolidayDates, setProfileHolidayDates] = useState('')
  const [profileSchedule, setProfileSchedule] = useState<WorkingSchedule>(defaultWorkingSchedule)
  const [timeOffFrom, setTimeOffFrom] = useState(() => todayDate())
  const [timeOffTo, setTimeOffTo] = useState(() => todayDate())
  const [timeOffMinutes, setTimeOffMinutes] = useState('')
  const [requestTitle, setRequestTitle] = useState('')
  const [requestProjectId, setRequestProjectId] = useState('')
  const [requestFrom, setRequestFrom] = useState(() => todayDate())
  const [requestTo, setRequestTo] = useState(() => todayDate())
  const [requestMinutes, setRequestMinutes] = useState('480')
  const [requestRole, setRequestRole] = useState('')
  const [requestSkills, setRequestSkills] = useState('')
  const [requestConfidential, setRequestConfidential] = useState(false)
  const [assignmentProjectId, setAssignmentProjectId] = useState('')
  const [assignmentRequestId, setAssignmentRequestId] = useState('')
  const [assignmentWorkItemId, setAssignmentWorkItemId] = useState('')
  const [assignmentFrom, setAssignmentFrom] = useState(() => todayDate())
  const [assignmentTo, setAssignmentTo] = useState(() => todayDate())
  const [assignmentAllocation, setAssignmentAllocation] = useState('480')
  const [assignmentPlanned, setAssignmentPlanned] = useState('480')
  const [assignmentConfidential, setAssignmentConfidential] = useState(false)
  const [preview, setPreview] = useState<WorkloadSnapshot>()
  const [error, setError] = useState<Error>()
  const [isSaving, setIsSaving] = useState(false)

  const selectedMemberId = members.some((member) => member.id === memberId)
    ? memberId
    : defaultMemberId
  const selectedMemberProfile = snapshot?.members.find((member) => member.memberId === selectedMemberId)
  const profileRevision = selectedMemberProfile?.profileRevision ?? 0
  const teamRevision = snapshot?.revision ?? 0
  const selectedMemberLabel = useMemo(
    () => members.find((member) => member.id === selectedMemberId)?.name ?? selectedMemberId,
    [members, selectedMemberId],
  )

  useEffect(() => {
    if (!selectedMemberProfile) {
      setProfileTimeZone('UTC')
      setProfileRole('')
      setProfileSkills('')
      setProfileHours('8')
      setProfileHolidayDates('')
      setProfileSchedule(defaultWorkingSchedule)
      return
    }
    setProfileTimeZone(selectedMemberProfile.timeZone)
    setProfileRole(selectedMemberProfile.role ?? '')
    setProfileSkills(selectedMemberProfile.skills.join(', '))
    setProfileHours(String(selectedMemberProfile.schedule.monday.minutes / 60))
    setProfileHolidayDates(selectedMemberProfile.holidays.map((holiday) => holiday.date).join(', '))
    setProfileSchedule(selectedMemberProfile.schedule)
  }, [selectedMemberId, selectedMemberProfile?.profileRevision])

  if (members.length === 0) return null

  /** Runs one planning mutation and refreshes the authoritative snapshot. */
  const runMutation = async (operation: () => Promise<unknown>) => {
    setError(undefined)
    setIsSaving(true)
    try {
      await operation()
      setPreview(undefined)
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(t('workload.controls.error')))
    } finally {
      setIsSaving(false)
    }
  }

  /** Saves the selected member's recurring availability profile. */
  const saveProfile = () => {
    if (!accessToken || !teamId) return
    const input: SaveWorkloadProfileRequest = {
      displayName: selectedMemberLabel,
      ...(profileRole.trim() ? { role: profileRole.trim() } : {}),
      skills: splitList(profileSkills),
      timeZone: profileTimeZone.trim() || 'UTC',
      schedule: selectedMemberProfile && Number(profileHours) === selectedMemberProfile.schedule.monday.minutes / 60
        ? profileSchedule
        : createSchedule(profileHours),
      holidays: createHolidays(profileHolidayDates, selectedMemberProfile?.holidays ?? []),
      expectedRevision: profileRevision,
      expectedTeamRevision: teamRevision,
    }
    void runMutation(() => saveWorkloadProfile(accessToken, teamId, selectedMemberId, input))
  }

  /** Saves a full-day or partial-day absence for the selected member. */
  const saveTimeOff = () => {
    if (!accessToken || !teamId) return
    void runMutation(() => saveWorkloadTimeOff(accessToken, teamId, selectedMemberId, `time-off-${Date.now()}`, {
      fromDate: timeOffFrom,
      toDate: timeOffTo,
      ...(timeOffMinutes.trim() ? { minutesPerDay: Number(timeOffMinutes) } : {}),
      status: 'planned',
      expectedRevision: profileRevision,
      expectedTeamRevision: teamRevision,
    }))
  }

  /** Creates the resource request currently entered in the form. */
  const createRequest = () => {
    if (!accessToken || !teamId) return
    const input: CreateWorkloadRequestRequest = {
      ...(requestProjectId ? { projectId: requestProjectId } : {}),
      title: requestTitle,
      ...(requestRole.trim() ? { role: requestRole.trim() } : {}),
      skillIds: splitList(requestSkills),
      fromDate: requestFrom,
      toDate: requestTo,
      requestedMinutes: Number(requestMinutes),
      confidential: requestConfidential,
      expectedTeamRevision: teamRevision,
    }
    void runMutation(() => createWorkloadRequest(accessToken, teamId, input))
  }

  /** Creates the resource assignment currently entered in the form. */
  const createAssignment = () => {
    if (!accessToken || !teamId) return
    const input: CreateWorkloadAssignmentRequest = {
      ...(assignmentRequestId.trim() ? { requestId: assignmentRequestId.trim() } : {}),
      ...(assignmentProjectId ? { projectId: assignmentProjectId } : {}),
      ...(assignmentWorkItemId.trim() ? { workItemId: assignmentWorkItemId.trim() } : {}),
      memberId: selectedMemberId,
      skillIds: [],
      fromDate: assignmentFrom,
      toDate: assignmentTo,
      allocationMinutes: Number(assignmentAllocation),
      plannedEffortMinutes: Number(assignmentPlanned),
      confidential: assignmentConfidential,
      status: 'tentative',
      expectedTeamRevision: teamRevision,
    }
    void runMutation(() => createWorkloadAssignment(accessToken, teamId, input))
  }

  /** Calculates the current assignment form as a non-persisted what-if. */
  const previewAssignment = () => {
    if (!accessToken || !teamId || !snapshot) return
    setError(undefined)
    setIsSaving(true)
    void previewWorkloadAssignment(accessToken, teamId, {
      fromDate: snapshot.fromDate,
      toDate: snapshot.toDate,
      granularity: snapshot.granularity,
      memberId: selectedMemberId,
      assignmentFromDate: assignmentFrom,
      assignmentToDate: assignmentTo,
      allocationMinutes: Number(assignmentAllocation),
      plannedEffortMinutes: Number(assignmentPlanned),
    }).then(setPreview).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause : new Error(t('workload.controls.error')))
    }).finally(() => setIsSaving(false))
  }

  return (
    <section className="grid gap-5 border border-slate-200 bg-white p-5 shadow-[0_18px_42px_rgba(30,52,88,0.04)]" data-testid="workload-planning-controls">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--workbench-primary)]">{t('workload.controls.eyebrow')}</p>
        <h2 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0d1833]">{t('workload.controls.title')}</h2>
        <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('workload.controls.description')}</p>
      </div>

      {error ? <p className="border border-[#f2c7c7] bg-[#fff7f7] px-4 py-3 text-sm font-semibold text-[#9f3f3f]" role="alert">{error.message}</p> : null}

      <label className="grid max-w-md gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {t('workload.controls.member')}
        <select className={inputClass} value={selectedMemberId} onChange={(event) => setMemberId(event.target.value)}>
          {members.map((member) => <option key={member.id} value={member.id}>{member.name}{member.email ? ` · ${member.email}` : ''}</option>)}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-5 max-[820px]:grid-cols-1">
        <ControlCard title={t('workload.controls.profile.title')} description={t('workload.controls.profile.description')}>
          <div className="grid gap-3">
            <Field label={t('workload.controls.profile.timezone')} value={profileTimeZone} onChange={setProfileTimeZone} placeholder="Asia/Tokyo" />
            <Field label={t('workload.controls.profile.hours')} value={profileHours} onChange={setProfileHours} type="number" min="0" max="24" step="0.5" />
            <Field label={t('workload.controls.profile.role')} value={profileRole} onChange={setProfileRole} />
            <Field label={t('workload.controls.profile.skills')} value={profileSkills} onChange={setProfileSkills} placeholder={t('workload.controls.profile.skillsPlaceholder')} />
            <Field label={t('workload.controls.profile.holidays')} value={profileHolidayDates} onChange={setProfileHolidayDates} placeholder={t('workload.controls.profile.holidaysPlaceholder')} />
            <button className={buttonClass} disabled={isSaving} type="button" onClick={saveProfile}>{t('workload.controls.profile.save')}</button>
          </div>
        </ControlCard>

        <ControlCard title={t('workload.controls.timeOff.title')} description={t('workload.controls.timeOff.description')}>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('workload.controls.from')} value={timeOffFrom} onChange={setTimeOffFrom} type="date" />
              <Field label={t('workload.controls.to')} value={timeOffTo} onChange={setTimeOffTo} type="date" />
            </div>
            <Field label={t('workload.controls.timeOff.minutes')} value={timeOffMinutes} onChange={setTimeOffMinutes} type="number" min="0" placeholder={t('workload.controls.timeOff.fullDay')} />
            <button className={buttonClass} disabled={isSaving || profileRevision === 0} type="button" onClick={saveTimeOff}>{t('workload.controls.timeOff.save')}</button>
            {profileRevision === 0 ? <p className="text-xs font-semibold text-[var(--workbench-muted)]">{t('workload.controls.timeOff.setupFirst')}</p> : null}
          </div>
        </ControlCard>

        <ControlCard title={t('workload.controls.request.title')} description={t('workload.controls.request.description')}>
          <div className="grid gap-3">
            <Field label={t('workload.controls.request.name')} value={requestTitle} onChange={setRequestTitle} />
            <select className={inputClass} aria-label={t('workload.controls.project')} value={requestProjectId} onChange={(event) => setRequestProjectId(event.target.value)}>
              <option value="">{t('workload.controls.projectNone')}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('workload.controls.from')} value={requestFrom} onChange={setRequestFrom} type="date" />
              <Field label={t('workload.controls.to')} value={requestTo} onChange={setRequestTo} type="date" />
            </div>
            <Field label={t('workload.controls.request.minutes')} value={requestMinutes} onChange={setRequestMinutes} type="number" min="0" />
            <Field label={t('workload.controls.request.role')} value={requestRole} onChange={setRequestRole} />
            <Field label={t('workload.controls.request.skills')} value={requestSkills} onChange={setRequestSkills} placeholder={t('workload.controls.profile.skillsPlaceholder')} />
            <label className="flex items-center gap-2 text-sm font-semibold text-[#526381]"><input checked={requestConfidential} type="checkbox" onChange={(event) => setRequestConfidential(event.target.checked)} />{t('workload.controls.confidential')}</label>
            <button className={buttonClass} disabled={isSaving || requestTitle.trim().length === 0} type="button" onClick={createRequest}>{t('workload.controls.request.save')}</button>
          </div>
        </ControlCard>

        <ControlCard title={t('workload.controls.assignment.title')} description={t('workload.controls.assignment.description')}>
          <div className="grid gap-3">
            <select className={inputClass} aria-label={t('workload.controls.project')} value={assignmentProjectId} onChange={(event) => setAssignmentProjectId(event.target.value)}>
              <option value="">{t('workload.controls.projectNone')}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <Field label={t('workload.controls.assignment.requestId')} value={assignmentRequestId} onChange={setAssignmentRequestId} />
            <Field label={t('workload.controls.assignment.workItemId')} value={assignmentWorkItemId} onChange={setAssignmentWorkItemId} />
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('workload.controls.from')} value={assignmentFrom} onChange={setAssignmentFrom} type="date" />
              <Field label={t('workload.controls.to')} value={assignmentTo} onChange={setAssignmentTo} type="date" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('workload.controls.assignment.allocation')} value={assignmentAllocation} onChange={setAssignmentAllocation} type="number" min="0" />
              <Field label={t('workload.controls.assignment.planned')} value={assignmentPlanned} onChange={setAssignmentPlanned} type="number" min="0" />
            </div>
            <label className="flex items-center gap-2 text-sm font-semibold text-[#526381]"><input checked={assignmentConfidential} type="checkbox" onChange={(event) => setAssignmentConfidential(event.target.checked)} />{t('workload.controls.confidential')}</label>
            <div className="flex flex-wrap gap-2">
              <button className={buttonClass} disabled={isSaving || profileRevision === 0} type="button" onClick={createAssignment}>{t('workload.controls.assignment.save')}</button>
              <button className={secondaryButtonClass} disabled={isSaving || !snapshot || profileRevision === 0} type="button" onClick={previewAssignment}>{t('workload.controls.assignment.preview')}</button>
            </div>
            {profileRevision === 0 ? <p className="text-xs font-semibold text-[var(--workbench-muted)]">{t('workload.controls.assignment.setupFirst')}</p> : null}
            {preview ? <PreviewSummary memberId={selectedMemberId} memberLabel={selectedMemberLabel} snapshot={preview} t={t} /> : null}
          </div>
        </ControlCard>
      </div>
    </section>
  )
}

/** Renders a compact form card. */
function ControlCard({ children, description, title }: { children: ReactNode; description: string; title: string }) {
  return <div className="grid gap-3 rounded-lg border border-slate-200 bg-[#fbfcfd] p-4"><div><h3 className="text-sm font-bold text-[#0d1833]">{title}</h3><p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">{description}</p></div>{children}</div>
}

/** Renders a labeled input with shared Workbench styling. */
function Field({ label, max, min, onChange, placeholder, step, type = 'text', value }: { label: string; max?: string; min?: string; onChange: (value: string) => void; placeholder?: string; step?: string; type?: string; value: string }) {
  return <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">{label}<input className={inputClass} max={max} min={min} placeholder={placeholder} step={step} type={type} value={value} onChange={(event) => onChange(event.target.value)} /></label>
}

/** Renders the high-level result of an unsaved assignment preview. */
function PreviewSummary({ memberId, memberLabel, snapshot, t }: { memberId: string; memberLabel: string; snapshot: WorkloadSnapshot; t: (key: MessageKey) => string }) {
  const member = snapshot.members.find((candidate) => candidate.memberId === memberId)
  if (!member) return null
  return <p className="border border-[#c9d8f0] bg-[#f5f8ff] px-3 py-2 text-xs font-semibold leading-5 text-[#526381]">{t('workload.controls.assignment.previewResult').replace('{member}', memberLabel).replace('{allocated}', formatHours(member.allocatedMinutes)).replace('{capacity}', formatHours(member.capacityMinutes))}</p>
}

/** Creates a weekday schedule from the submitted daily hours. */
function createSchedule(hoursValue: string): WorkingSchedule {
  const minutes = Math.max(0, Math.min(1_440, Math.round(Number(hoursValue) * 60)))
  return {
    monday: { ...defaultWorkingSchedule.monday, minutes },
    tuesday: { ...defaultWorkingSchedule.tuesday, minutes },
    wednesday: { ...defaultWorkingSchedule.wednesday, minutes },
    thursday: { ...defaultWorkingSchedule.thursday, minutes },
    friday: { ...defaultWorkingSchedule.friday, minutes },
    saturday: { ...defaultWorkingSchedule.saturday },
    sunday: { ...defaultWorkingSchedule.sunday },
  }
}

/** Reconciles submitted holiday dates with existing labels while preserving known holidays. */
function createHolidays(value: string, existing: readonly WorkloadHoliday[]): WorkloadHoliday[] {
  const existingByDate = new Map(existing.map((holiday) => [holiday.date, holiday]))
  return splitList(value).map((date) => existingByDate.get(date) ?? { date })
}

/** Splits a comma-separated form field into normalized identifiers. */
function splitList(value: string): string[] {
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))]
}

/** Creates today's browser-local calendar date. */
function todayDate(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Formats minutes as hours for a preview summary. */
function formatHours(minutes: number): string {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

const inputClass = 'min-h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-[var(--workbench-text)] outline-none transition focus:border-[#6fbfb4] focus:ring-4 focus:ring-[#dff5f1]'
const buttonClass = 'rounded-md bg-[#0d1833] px-3 py-2 text-xs font-bold text-white transition hover:bg-[#1c315d] disabled:cursor-not-allowed disabled:opacity-50'
const secondaryButtonClass = 'rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-[#526381] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'
