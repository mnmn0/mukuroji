import type {
  CreateImportJobRequest,
  ImportPort,
  UpdateImportJobRequest,
} from '../../application/ports'

/** Focused adapter for import job metadata operations. */
export class ImportAdapter implements ImportPort {
  /** Storage implementation that owns import job records. */
  readonly #source: ImportPort

  /** Creates a focused import adapter. */
  constructor(source: ImportPort) {
    this.#source = source
  }

  /** Creates an import job. */
  createImportJob(request: CreateImportJobRequest) {
    return this.#source.createImportJob(request)
  }

  /** Lists import jobs. */
  listImportJobs(workspaceId: string) {
    return this.#source.listImportJobs(workspaceId)
  }

  /** Updates an import job. */
  updateImportJob(request: UpdateImportJobRequest) {
    return this.#source.updateImportJob(request)
  }
}
