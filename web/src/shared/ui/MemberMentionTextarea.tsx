import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  filterMentionSuggestions,
  formatMemberMentionLabel,
  readMentionAtCursor,
  type MentionableMember,
} from '../lib/memberMentions'

/** Composer text together with the members picked from the suggestion list. */
export type MemberMentionDraft = {
  /** Raw composer text. */
  body: string
  /** Member keys picked from the suggestions; tokens later removed from the text are resolved away on submit. */
  mentionMemberKeys: string[]
}

/** Props of {@link MemberMentionTextarea}. */
export type MemberMentionTextareaProps = {
  /** Current text and picked members. */
  draft: MemberMentionDraft
  /** Receives every change of text or picked members. */
  onDraftChange: (draft: MemberMentionDraft) => void
  /** Members offered after `@`; an empty list leaves a plain textarea. */
  members: readonly MentionableMember[]
  /** Accessible name of the suggestion list. */
  suggestionsLabel: string
  /** Accessible name of the textarea. */
  ariaLabel: string
  /** Whether the textarea takes focus when it mounts. */
  autoFocus?: boolean
  /** Textarea classes. */
  className?: string
  /** Whether the textarea is disabled. */
  disabled?: boolean
  /** Form field name. */
  name?: string
  /** Placeholder text. */
  placeholder?: string
  /** Whether a value is required. */
  required?: boolean
}

/**
 * Comment textarea that offers members by display name after `@` and inserts `@Name` tokens.
 *
 * Arrow keys move through the suggestions, Enter or Tab picks one, and Escape closes the list.
 *
 * @param props - Draft, change callback, candidates, and textarea attributes.
 * @returns The textarea with its suggestion list.
 */
export function MemberMentionTextarea({
  ariaLabel,
  autoFocus = false,
  className,
  disabled = false,
  draft,
  members,
  name,
  onDraftChange,
  placeholder,
  required = false,
  suggestionsLabel,
}: MemberMentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
  const [mentionQuery, setMentionQuery] = useState<string | undefined>()
  const [activeIndex, setActiveIndex] = useState(0)
  const activeMembers = useMemo(
    () => members.filter((member) => member.status === 'active'),
    [members],
  )
  const suggestions = useMemo(
    () => mentionQuery === undefined ? [] : filterMentionSuggestions(activeMembers, mentionQuery),
    [activeMembers, mentionQuery],
  )
  const isOpen = !disabled && suggestions.length > 0
  const activeSuggestion = isOpen ? suggestions[Math.min(activeIndex, suggestions.length - 1)] : undefined

  /** Updates the typed query from the text before the cursor. */
  const readQuery = (value: string, cursor: number) => {
    setMentionQuery(readMentionAtCursor(value, cursor)?.query)
    setActiveIndex(0)
  }

  /** Replaces the typed `@query` with the member's token and records the pick. */
  const insertMention = (member: MentionableMember) => {
    const textarea = textareaRef.current
    const cursor = textarea?.selectionStart ?? draft.body.length
    const mention = readMentionAtCursor(draft.body, cursor)
    const token = `@${formatMemberMentionLabel(member, activeMembers)}`
    const start = mention?.start ?? cursor
    const body = `${draft.body.slice(0, start)}${token} ${draft.body.slice(cursor)}`
    onDraftChange({
      body,
      mentionMemberKeys: [...new Set([...draft.mentionMemberKeys, member.memberKey])],
    })
    setMentionQuery(undefined)
    requestAnimationFrame(() => {
      const nextCursor = start + token.length + 1
      textarea?.focus()
      textarea?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  /** Moves through and picks suggestions from the keyboard. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isOpen) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((index) => (index + step + suggestions.length) % suggestions.length)
    } else if ((event.key === 'Enter' || event.key === 'Tab') && activeSuggestion) {
      event.preventDefault()
      insertMention(activeSuggestion)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setMentionQuery(undefined)
    }
  }

  return (
    <div className="relative grid min-w-0">
      <textarea
        aria-activedescendant={activeSuggestion ? `${listId}-${activeSuggestion.memberKey}` : undefined}
        aria-autocomplete={activeMembers.length > 0 ? 'list' : undefined}
        aria-controls={isOpen ? listId : undefined}
        aria-expanded={activeMembers.length > 0 ? isOpen : undefined}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        className={className}
        disabled={disabled}
        name={name}
        placeholder={placeholder}
        ref={textareaRef}
        required={required}
        role={activeMembers.length > 0 ? 'combobox' : undefined}
        value={draft.body}
        onBlur={() => setMentionQuery(undefined)}
        onChange={(event) => {
          onDraftChange({ body: event.target.value, mentionMemberKeys: draft.mentionMemberKeys })
          readQuery(event.target.value, event.target.selectionStart)
        }}
        onClick={(event) => readQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
      />
      {isOpen ? (
        <ul
          aria-label={suggestionsLabel}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-52 overflow-y-auto rounded-md border border-[var(--workbench-border)] bg-surface p-1.5 shadow-[0_12px_30px_rgba(38,51,63,0.16)]"
          id={listId}
          role="listbox"
        >
          {suggestions.map((member) => (
            <li
              aria-selected={member === activeSuggestion}
              className={`flex min-h-11 cursor-pointer flex-col justify-center rounded px-2 py-1.5 text-left ${member === activeSuggestion ? 'bg-[var(--workbench-surface-muted)]' : 'hover:bg-[var(--workbench-surface-muted)]'}`}
              id={`${listId}-${member.memberKey}`}
              key={member.memberKey}
              role="option"
              onMouseDown={(event) => {
                // Keep focus in the textarea so the cursor position survives the pick.
                event.preventDefault()
                insertMention(member)
              }}
            >
              <span className="block truncate text-xs font-semibold text-[var(--workbench-text)]">
                {member.name?.trim() || member.email || member.memberKey}
              </span>
              {member.email ? (
                <span className="block truncate text-[0.68rem] font-medium text-[var(--workbench-muted)]">
                  {member.email}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
