import { Link } from 'react-router'
import type { MessageKey } from '../shared/i18n/i18n'
import { createWorkItemKeyPath } from '../shared/routing/paths'
import { readWorkItemKeyInput } from '../work-items/model/workItemKeys'

/** Props for {@link SearchKeyJump}. */
export type SearchKeyJumpProps = {
  /** The search keyword as typed. */
  keyword: string
  /** Translator for the visible label. */
  t: (key: MessageKey) => string
}

/**
 * Offers to open a Work Item directly when the search keyword is exactly one key,
 * in any letter case and with surrounding spaces.
 *
 * @returns A link to the key URL, or nothing when the keyword is not a key.
 */
export function SearchKeyJump({ keyword, t }: SearchKeyJumpProps) {
  const workItemKey = readWorkItemKeyInput(keyword)
  if (!workItemKey) return null
  return (
    <Link
      className="workbench-button-primary min-h-10 px-4"
      data-testid="workspace-search-key-jump"
      to={createWorkItemKeyPath(workItemKey)}
    >
      {t('search.keyJump').replace('{key}', workItemKey)}
    </Link>
  )
}
