import { expect, test } from 'bun:test'
import { projectAgentRunFinishRange } from './project-agent-cost'

test('bounds the Agent Run read by the exact local days of the budget time zone (ADR 0119)', () => {
  expect(projectAgentRunFinishRange('Asia/Tokyo', '2026-01-05', '2026-01-06')).toEqual({
    since: '2026-01-04T15:00:00.000Z',
    until: '2026-01-06T14:59:59.999Z',
  })
  expect(projectAgentRunFinishRange('UTC', undefined, '2026-01-06')).toEqual({ until: '2026-01-06T23:59:59.999Z' })
  // New York moves its clocks forward on 2026-03-08, so that day starts at UTC-5 and ends at UTC-4.
  expect(projectAgentRunFinishRange('America/New_York', '2026-03-08', '2026-03-08')).toEqual({
    since: '2026-03-08T05:00:00.000Z',
    until: '2026-03-09T03:59:59.999Z',
  })
  expect(projectAgentRunFinishRange('Pacific/Kiritimati', '2026-01-05', '2026-01-05')).toEqual({
    since: '2026-01-04T10:00:00.000Z',
    until: '2026-01-05T09:59:59.999Z',
  })
})
