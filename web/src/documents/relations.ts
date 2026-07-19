/**
 * Canonical Work Item relation target の構成要素です。
 */
export type CanonicalWorkItemTarget = {
  /**
   * Work Item が属する Team ID です。
   */
  teamId: string
  /**
   * Team 内の Issue ID です。
   */
  issueId: string
}

/**
 * Team/Issue ID から backlink と画面遷移で共有する canonical ID を作ります。
 *
 * @param teamId - Team ID です。
 * @param issueId - Issue ID です。
 * @returns canonical ID、または安全な構成要素でない場合は undefined です。
 */
export function createCanonicalWorkItemId(
  teamId: string,
  issueId: string,
) {
  const normalizedTeamId = normalizeCanonicalPart(teamId)
  const normalizedIssueId = normalizeCanonicalPart(issueId)
  if (!normalizedTeamId || !normalizedIssueId) return undefined
  return `team/${normalizedTeamId}/issue/${normalizedIssueId}`
}

/**
 * Canonical Work Item ID を編集フォーム用の Team/Issue ID へ分解します。
 *
 * @param workItemId - `team/<teamId>/issue/<issueId>` 形式の ID です。
 * @returns 構成要素、または非canonical ID の場合は undefined です。
 */
export function parseCanonicalWorkItemId(
  workItemId: string,
): CanonicalWorkItemTarget | undefined {
  const parts = workItemId.trim().split('/')
  if (
    parts.length !== 4 ||
    parts[0] !== 'team' ||
    parts[2] !== 'issue'
  ) {
    return undefined
  }
  const teamId = normalizeCanonicalPart(parts[1] ?? '')
  const issueId = normalizeCanonicalPart(parts[3] ?? '')
  return teamId && issueId ? { teamId, issueId } : undefined
}

function normalizeCanonicalPart(value: string) {
  const normalized = value.trim()
  return normalized &&
      normalized.length <= 500 &&
      !normalized.includes('/') &&
      ![...normalized].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint <= 31 || codePoint === 127
      })
    ? normalized
    : undefined
}
