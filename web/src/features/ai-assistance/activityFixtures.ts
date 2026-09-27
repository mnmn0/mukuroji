import type { AiActivity, AiActivityPhase, AiActivityEvent } from './model/aiActivity'

/** Fixed visual-test clock independent of draft fixture retention. */
export const aiActivityFixtureNow = Date.parse('2026-09-27T05:30:00.000Z')

/** Creates metadata-only sample activity for isolated visual review. */
function activity(id: string, label: string, task: AiActivity['task'], phase: AiActivityPhase, minutesAgo: number): AiActivity {
  const at = aiActivityFixtureNow - minutesAgo * 60_000
  const events: AiActivityEvent[] = [{ phase: 'generating', at: at - 30_000 }]
  if (phase !== 'generating') events.push({ phase, at })
  return { id, label, task, phase, origin: '/home', expiresAt: aiActivityFixtureNow + 60_000, events }
}

/** Representative concurrent operations, human decisions, and failure states. */
export const aiActivityFixtures: readonly AiActivity[] = [
  activity('plan-api', 'APIの認証フローを整理する', 'planning', 'generating', 0),
  activity('summary-launch', 'リリースに向けた進捗をまとめる', 'summary', 'generating', 1),
  activity('triage-access', 'アクセス権限のリクエスト', 'triage', 'review', 3),
  activity('plan-onboarding', '初回セットアップをわかりやすくする', 'planning', 'review', 5),
  activity('summary-design', 'デザインレビューの論点整理', 'summary', 'cancelled', 8),
  activity('plan-dashboard', 'ダッシュボードの表示改善', 'planning', 'closed', 12),
  activity('search-priority', '今週の優先タスクを探す', 'search', 'approved', 15),
  activity('triage-import', 'CSVインポートの相談', 'triage', 'rejected', 20),
  activity('summary-retro', '振り返りの要約', 'summary', 'failed', 25),
]
