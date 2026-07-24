import { describe, expect, test } from 'bun:test'
import { triggerDeveloperExportDownload } from '../src/developer-platform/ui/developerExportDownload'

describe('Developer Platform export download', () => {
  test('clicks before deferring object URL cleanup', () => {
    const events: string[] = []
    let scheduledCleanup: (() => void) | undefined
    const anchor = {
      click: () => {
        events.push(`click:${anchor.href}:${anchor.download}`)
      },
      download: '',
      href: '',
    }

    triggerDeveloperExportDownload(
      new Blob(['export']),
      'work-items.csv',
      {
        createObjectUrl: () => {
          events.push('create-url')
          return 'blob:developer-export'
        },
        createAnchor: () => anchor,
        scheduleCleanup: (cleanup) => {
          events.push('schedule-cleanup')
          scheduledCleanup = cleanup
        },
        revokeObjectUrl: (objectUrl) => {
          events.push(`revoke:${objectUrl}`)
        },
      },
    )

    expect(events).toEqual([
      'create-url',
      'click:blob:developer-export:work-items.csv',
      'schedule-cleanup',
    ])
    expect(scheduledCleanup).toBeFunction()

    scheduledCleanup?.()

    expect(events).toEqual([
      'create-url',
      'click:blob:developer-export:work-items.csv',
      'schedule-cleanup',
      'revoke:blob:developer-export',
    ])
  })
})
