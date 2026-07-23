import type { ImportJob } from '@mukuroji/contracts'

/** Validated input used to create an import job. */
export type CreateImportJobInput = {
  /** Source file format. */
  format: ImportJob['format']
  /** Team that owns imported Work Items. */
  teamId: string
  /** Default assigned Project for imported Work Items. */
  assignedProjectId?: string
  /** Mapping from source columns to canonical fields. */
  mapping: ImportJob['mapping']
  /** Whether to validate and report without persisting Work Items. */
  dryRun?: boolean
}

/** Request used to create an import job. */
export type CreateImportJobRequest = {
  /** Workspace being imported into. */
  workspaceId: string
  /** User starting the import. */
  createdByUserId: string
  /** Optional deterministic job identifier retained across queue retries. */
  jobId?: string
  /** Validated import input. */
  input: CreateImportJobInput
}

/** Request used to update an import job. */
export type UpdateImportJobRequest = {
  /** Workspace being imported into. */
  workspaceId: string
  /** Import job to update. */
  jobId: string
  /** New job status. */
  status: ImportJob['status']
  /** Bounded completion, dry-run, or validation report. */
  report?: ImportJob['report']
  /** Secret-free error summary. */
  error?: ImportJob['error']
}

/** Application port for import job metadata lifecycle. */
export interface ImportPort {
  /** Creates an import job in queued state. */
  createImportJob(request: CreateImportJobRequest): Promise<ImportJob>
  /** Lists import jobs for a workspace by creation time descending. */
  listImportJobs(workspaceId: string): Promise<ImportJob[]>
  /** Persists import job state and report updates. */
  updateImportJob(request: UpdateImportJobRequest): Promise<ImportJob>
}
