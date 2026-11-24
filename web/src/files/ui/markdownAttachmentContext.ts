import { createContext, useContext } from 'react'
import type { MarkdownAttachmentContext } from './MarkdownAttachment'

/**
 * Supplies the Work Item file controller to every Markdown body below it, such as comments,
 * captured resolutions, and decision evidence, without passing it through each component.
 */
export const MarkdownAttachmentReactContext = createContext<MarkdownAttachmentContext | undefined>(undefined)

/**
 * Reads the nearest Work Item attachment context.
 *
 * @returns The context, or `undefined` outside a Work Item.
 */
export function useMarkdownAttachmentContext(): MarkdownAttachmentContext | undefined {
  return useContext(MarkdownAttachmentReactContext)
}
