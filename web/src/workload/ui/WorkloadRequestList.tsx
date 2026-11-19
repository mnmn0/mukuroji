import { useState } from 'react'
import type { ResourceRequest } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { UpdateWorkloadRequestRequest } from '../api'
import { resourceRequestStatusKey, sortResourceRequestsForDisplay } from '../model/resourceRequestDisplay'

/** Fields a manager can change on a request, without the optimistic-concurrency values. */
export type WorkloadRequestChange = Omit<UpdateWorkloadRequestRequest, 'expectedRevision' | 'expectedTeamRevision'>

/** Props for the resource request management list. */
export type WorkloadRequestListProps = {
  /** Visible resource requests from the workload snapshot. */
  requests: readonly ResourceRequest[]
  /** Number of confidential requests hidden from the viewer. */
  redactedCount: number
  /** Project options used to show request Project names. */
  projects: readonly {
    /** Stable project identifier. */
    id: string
    /** Display name. */
    name: string
  }[]
  /** Whether any planning mutation is in flight. */
  isSaving: boolean
  /** Saves a change to one request and resolves to whether it succeeded. */
  onUpdate: (request: ResourceRequest, change: WorkloadRequestChange) => Promise<boolean>
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Lists resource requests and lets a manager change or cancel each one.
 *
 * @param props - Requests, Project names, mutation state, and localized labels.
 * @returns The request list with inline edit and cancel controls.
 */
export function WorkloadRequestList({ isSaving, onUpdate, projects, redactedCount, requests, t }: WorkloadRequestListProps) {
  const [editingId, setEditingId] = useState<string>()
  const [confirmingId, setConfirmingId] = useState<string>()
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const sorted = sortResourceRequestsForDisplay(requests)

  /** Saves a change and closes the open editor or confirmation when it succeeds. */
  const update = async (request: ResourceRequest, change: WorkloadRequestChange) => {
    if (await onUpdate(request, change)) {
      setEditingId(undefined)
      setConfirmingId(undefined)
    }
  }

  return (
    <div className="grid min-w-0 gap-3 border-t border-[var(--workbench-border)] pt-4" data-testid="workload-request-list">
      <div>
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('workload.controls.requests.title')}</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--workbench-muted)]">{t('workload.controls.requests.description')}</p>
      </div>
      {sorted.length === 0 ? <p className="text-xs font-semibold text-[var(--workbench-muted)]">{t('workload.controls.requests.empty')}</p> : null}
      {redactedCount > 0 ? <p className="text-xs font-semibold text-[var(--workbench-muted)]">{t('workload.controls.requests.redacted').replace('{count}', String(redactedCount))}</p> : null}
      <ul className="grid gap-2">
        {sorted.map((request) => {
          const canceled = request.status === 'canceled'
          return (
            <li key={request.id} className={`grid min-w-0 gap-2 border border-[var(--workbench-border)] px-3 py-2 ${canceled ? 'opacity-60' : ''}`}>
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-[var(--workbench-text)]">{request.title}</p>
                  <p className="text-xs leading-5 text-[var(--workbench-muted)]">
                    {[
                      request.projectId ? projectNames.get(request.projectId) ?? request.projectId : t('workload.controls.projectNone'),
                      `${request.fromDate} – ${request.toDate}`,
                      formatHours(request.requestedMinutes),
                      request.role,
                      request.skillIds.join(', '),
                      request.confidential ? t('workload.controls.confidential') : undefined,
                    ].filter(Boolean).join(' · ')}
                  </p>
                  <p className="break-all text-[11px] text-[var(--workbench-muted)]">{t('workload.controls.requests.id')}: <span className="font-mono">{request.id}</span></p>
                </div>
                <span className="shrink-0 border border-[var(--workbench-border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--workbench-text)]">
                  {t(`workload.controls.requests.status.${resourceRequestStatusKey(request.status)}`)}
                </span>
              </div>
              {!canceled && editingId !== request.id && confirmingId !== request.id ? (
                <div className="flex flex-wrap gap-2">
                  <button className={secondaryButtonClass} disabled={isSaving} type="button" onClick={() => { setConfirmingId(undefined); setEditingId(request.id) }}>{t('workload.controls.requests.edit')}</button>
                  <button className={secondaryButtonClass} disabled={isSaving} type="button" onClick={() => { setEditingId(undefined); setConfirmingId(request.id) }}>{t('workload.controls.requests.cancel')}</button>
                </div>
              ) : null}
              {!canceled && confirmingId === request.id ? (
                <div className="grid gap-2" role="group" aria-label={t('workload.controls.requests.cancel')}>
                  <p className="text-xs font-semibold leading-5 text-fg-9f3f3f">{t('workload.controls.requests.cancelConfirm')}</p>
                  <div className="flex flex-wrap gap-2">
                    <button className={buttonClass} disabled={isSaving} type="button" onClick={() => { void update(request, { status: 'canceled' }) }}>{t('workload.controls.requests.cancelConfirmAction')}</button>
                    <button className={secondaryButtonClass} disabled={isSaving} type="button" onClick={() => setConfirmingId(undefined)}>{t('workload.controls.requests.keep')}</button>
                  </div>
                </div>
              ) : null}
              {!canceled && editingId === request.id ? (
                <RequestEditForm
                  key={`${request.id}:${request.revision}`}
                  isSaving={isSaving}
                  onDiscard={() => setEditingId(undefined)}
                  onSave={(change) => { void update(request, change) }}
                  request={request}
                  t={t}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Props for the inline request edit form. */
type RequestEditFormProps = {
  /** Request whose current values seed the form. */
  request: ResourceRequest
  /** Whether any planning mutation is in flight. */
  isSaving: boolean
  /** Sends the edited values. */
  onSave: (change: WorkloadRequestChange) => void
  /** Closes the form without saving. */
  onDiscard: () => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/** Renders an inline form whose initial state follows the request revision. */
function RequestEditForm({ isSaving, onDiscard, onSave, request, t }: RequestEditFormProps) {
  const [title, setTitle] = useState(request.title)
  const [fromDate, setFromDate] = useState(request.fromDate)
  const [toDate, setToDate] = useState(request.toDate)
  const [minutes, setMinutes] = useState(String(request.requestedMinutes))
  const [role, setRole] = useState(request.role ?? '')
  const [skills, setSkills] = useState(request.skillIds.join(', '))
  const [confidential, setConfidential] = useState(request.confidential)

  /** Sends every editable field so the saved request matches the form. */
  const save = () => {
    onSave({
      title,
      role: role.trim(),
      skillIds: [...new Set(skills.split(',').map((entry) => entry.trim()).filter(Boolean))],
      fromDate,
      toDate,
      requestedMinutes: Number(minutes),
      confidential,
    })
  }

  return (
    <div className="grid gap-3">
      <RequestField label={t('workload.controls.request.name')} value={title} onChange={setTitle} />
      <div className="grid grid-cols-2 gap-3">
        <RequestField label={t('workload.controls.from')} value={fromDate} onChange={setFromDate} type="date" />
        <RequestField label={t('workload.controls.to')} value={toDate} onChange={setToDate} type="date" />
      </div>
      <RequestField label={t('workload.controls.request.minutes')} value={minutes} onChange={setMinutes} type="number" min="0" />
      <RequestField label={t('workload.controls.request.role')} value={role} onChange={setRole} />
      <RequestField label={t('workload.controls.request.skills')} value={skills} onChange={setSkills} placeholder={t('workload.controls.profile.skillsPlaceholder')} />
      <label className="flex items-center gap-2 text-sm font-semibold text-fg-526381"><input checked={confidential} type="checkbox" onChange={(event) => setConfidential(event.target.checked)} />{t('workload.controls.confidential')}</label>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} disabled={isSaving || title.trim().length === 0} type="button" onClick={save}>{t('workload.controls.requests.save')}</button>
        <button className={secondaryButtonClass} disabled={isSaving} type="button" onClick={onDiscard}>{t('workload.controls.requests.discard')}</button>
      </div>
    </div>
  )
}

/** Renders a labeled input with shared Workbench styling. */
function RequestField({ label, min, onChange, placeholder, type = 'text', value }: { label: string; min?: string; onChange: (value: string) => void; placeholder?: string; type?: string; value: string }) {
  return <label className="grid min-w-0 gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">{label}<input className="workbench-input min-h-10 w-full px-3" min={min} placeholder={placeholder} type={type} value={value} onChange={(event) => onChange(event.target.value)} /></label>
}

/** Formats minutes as hours for the request summary. */
function formatHours(minutes: number): string {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

const buttonClass = 'workbench-button-primary px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50'
const secondaryButtonClass = 'workbench-button-secondary px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50'
