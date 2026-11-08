/**
 * One periodic job the shared scheduled-jobs Lambda runs.
 */
export interface ScheduledJob {
  /** Stable job name used in logs and the failure summary. */
  readonly name: string
  /** Run interval in whole minutes; the job runs when the event minute is a multiple of it. */
  readonly everyMinutes: number
  /** Total tries in one invocation, matching the job's former Lambda retry policy. */
  readonly attempts: number
  /** Runtime-control guarded job entrypoint that receives the schedule event. */
  readonly run: (event: ScheduledJobsEvent) => Promise<unknown>
}

/**
 * EventBridge scheduled event delivered to the shared scheduled-jobs Lambda.
 */
export interface ScheduledJobsEvent {
  /** Scheduled time in ISO 8601, truncated to the minute by EventBridge. */
  readonly time?: string
  readonly [key: string]: unknown
}

/**
 * Optional replacements used by deterministic tests.
 */
export interface ScheduledJobsDispatcherDependencies {
  /** Clock used when the event carries no scheduled time. */
  readonly now?: () => Date
  /** Waits between tries of a failed job. */
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** Receives one line per failed try. */
  readonly logFailure?: (jobName: string, attempt: number, error: unknown) => void
}

/** Last error of one job that exhausted its tries. */
export interface ScheduledJobFailure {
  /** Job name. */
  readonly job: string
  /** The job's last error. */
  readonly error: unknown
}

/**
 * Describes a job error by its name and message.
 *
 * @param error - Error a job threw.
 * @returns `Name: message`, as Lambda reported it when the job had its own function.
 */
function describeJobError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Error raised after every due job ran and at least one still failed.
 *
 * Its message names each failed job with that job's last error, so the DLQ record and the
 * Lambda error report keep the reason the job failed. `cause` holds the original errors.
 */
export class ScheduledJobsFailedError extends Error {
  /** Names of the jobs whose last try failed. */
  readonly failedJobs: readonly string[]

  /**
   * @param failures - Each failed job with its last error.
   */
  constructor(failures: readonly ScheduledJobFailure[]) {
    super(
      `Scheduled jobs failed: ${
        failures.map(({ job, error }) => `${job} (${describeJobError(error)})`).join('; ')
      }`,
      { cause: new AggregateError(failures.map(({ error }) => error)) },
    )
    this.name = 'ScheduledJobsFailedError'
    this.failedJobs = failures.map(({ job }) => job)
  }
}

const RETRY_DELAY_MILLISECONDS = 2_000

/**
 * Resolves the scheduled minute an invocation stands for.
 *
 * @param event - Schedule event, whose `time` EventBridge sets to the scheduled minute.
 * @param now - Clock used when the event has no valid time.
 * @returns Minutes since the Unix epoch.
 */
function readScheduledMinute(event: ScheduledJobsEvent, now: () => Date): number {
  const scheduled = typeof event.time === 'string' ? Date.parse(event.time) : Number.NaN
  const milliseconds = Number.isFinite(scheduled) ? scheduled : now().getTime()
  return Math.floor(milliseconds / 60_000)
}

/**
 * Lists the jobs due at a scheduled minute.
 *
 * @param jobs - Every job the Lambda owns.
 * @param event - Schedule event for the invocation.
 * @param now - Clock used when the event has no valid time.
 * @returns Jobs whose interval divides the scheduled minute.
 */
export function selectDueScheduledJobs(
  jobs: readonly ScheduledJob[],
  event: ScheduledJobsEvent,
  now: () => Date = () => new Date(),
): readonly ScheduledJob[] {
  const minute = readScheduledMinute(event, now)
  return jobs.filter((job) => minute % job.everyMinutes === 0)
}

/**
 * Creates the entrypoint that runs every due job of one schedule tick.
 *
 * Due jobs run concurrently, and each retries on its own so one job's failure never
 * reruns another. The Lambda itself is not retried; when a job still fails after its
 * tries, the invocation fails after the others finish and its event goes to the DLQ.
 *
 * @param jobs - Every job the Lambda owns.
 * @param dependencies - Optional clock, sleep, and failure log replacements.
 * @returns Lambda handler for the EventBridge schedule.
 */
export function createScheduledJobsDispatcher(
  jobs: readonly ScheduledJob[],
  dependencies: ScheduledJobsDispatcherDependencies = {},
): (event?: ScheduledJobsEvent) => Promise<{ readonly ran: readonly string[] }> {
  const now = dependencies.now ?? (() => new Date())
  const sleep = dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds)
    }))
  const logFailure = dependencies.logFailure ??
    ((jobName: string, attempt: number, error: unknown) => {
      // The same error message and stack Lambda logged when each job had its own function.
      console.error(JSON.stringify({
        message: 'Scheduled job failed',
        job: jobName,
        attempt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }))
    })

  const runWithRetries = async (job: ScheduledJob, event: ScheduledJobsEvent) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await job.run(event)
        return
      } catch (error) {
        logFailure(job.name, attempt, error)
        if (attempt >= job.attempts) throw error
        await sleep(RETRY_DELAY_MILLISECONDS * attempt)
      }
    }
  }

  return async (event: ScheduledJobsEvent = {}) => {
    const due = selectDueScheduledJobs(jobs, event, now)
    const results = await Promise.allSettled(due.map((job) => runWithRetries(job, event)))
    const failures = due.flatMap((job, index) => {
      const result = results[index]
      return result?.status === 'rejected' ? [{ job: job.name, error: result.reason }] : []
    })
    if (failures.length > 0) throw new ScheduledJobsFailedError(failures)
    return { ran: due.map((job) => job.name) }
  }
}
