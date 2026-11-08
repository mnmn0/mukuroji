import { expect, test } from 'bun:test'
import {
  createScheduledJobsDispatcher,
  ScheduledJobsFailedError,
  selectDueScheduledJobs,
  type ScheduledJob,
} from './scheduled-jobs'

/**
 * Creates a job that records each call and fails a fixed number of times first.
 *
 * @param name - Job name.
 * @param everyMinutes - Run interval in minutes.
 * @param attempts - Tries per invocation.
 * @param failures - Calls that throw before one succeeds.
 * @returns The job and its call log.
 */
function recordingJob(name: string, everyMinutes: number, attempts: number, failures = 0) {
  const calls: unknown[] = []
  const job: ScheduledJob = {
    name,
    everyMinutes,
    attempts,
    async run(event) {
      calls.push(event)
      if (calls.length <= failures) throw new Error(`${name} failed`)
    },
  }
  return { job, calls }
}

const silent = { sleep: async () => {}, logFailure: () => {} }

test('selects jobs by the scheduled minute of the event', () => {
  const jobs = [
    recordingJob('every-minute', 1, 1).job,
    recordingJob('five-minutes', 5, 1).job,
    recordingJob('hourly', 60, 1).job,
  ]
  const names = (time: string) =>
    selectDueScheduledJobs(jobs, { time }).map((job) => job.name)

  expect(names('2026-11-08T10:01:00Z')).toEqual(['every-minute'])
  expect(names('2026-11-08T10:05:00Z')).toEqual(['every-minute', 'five-minutes'])
  expect(names('2026-11-08T10:00:00Z')).toEqual(['every-minute', 'five-minutes', 'hourly'])
})

test('falls back to the clock when the event has no scheduled time', () => {
  const jobs = [recordingJob('hourly', 60, 1).job]

  expect(selectDueScheduledJobs(jobs, {}, () => new Date('2026-11-08T11:00:30Z')))
    .toHaveLength(1)
  expect(selectDueScheduledJobs(jobs, { time: 'not-a-time' }, () => new Date('2026-11-08T11:01:00Z')))
    .toHaveLength(0)
})

test('passes the schedule event to every due job', async () => {
  const first = recordingJob('first', 1, 1)
  const second = recordingJob('second', 1, 1)
  const event = { time: '2026-11-08T10:00:00Z', source: 'aws.events' }

  const result = await createScheduledJobsDispatcher([first.job, second.job], silent)(event)

  expect(result).toEqual({ ran: ['first', 'second'] })
  expect(first.calls).toEqual([event])
  expect(second.calls).toEqual([event])
})

test('retries a failed job without rerunning the jobs that succeeded', async () => {
  const flaky = recordingJob('flaky', 1, 3, 2)
  const steady = recordingJob('steady', 1, 3)

  await createScheduledJobsDispatcher([flaky.job, steady.job], silent)({
    time: '2026-11-08T10:00:00Z',
  })

  expect(flaky.calls).toHaveLength(3)
  expect(steady.calls).toHaveLength(1)
})

test('fails the invocation after every job ran when one exhausts its tries', async () => {
  const once = recordingJob('once', 1, 1, 1)
  const other = recordingJob('other', 1, 1)
  const failures: string[] = []

  const run = createScheduledJobsDispatcher([once.job, other.job], {
    sleep: async () => {},
    logFailure: (name, attempt) => failures.push(`${name}#${attempt}`),
  })({ time: '2026-11-08T10:00:00Z' })

  const error = await run.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ScheduledJobsFailedError)
  expect((error as ScheduledJobsFailedError).failedJobs).toEqual(['once'])
  // The job's own error stays in the message the DLQ records, and in the cause.
  expect((error as ScheduledJobsFailedError).message)
    .toBe('Scheduled jobs failed: once (Error: once failed)')
  expect(((error as ScheduledJobsFailedError).cause as AggregateError).errors)
    .toEqual([new Error('once failed')])
  expect(once.calls).toHaveLength(1)
  expect(other.calls).toHaveLength(1)
  expect(failures).toEqual(['once#1'])
})
