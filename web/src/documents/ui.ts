import type { MessageKey } from '../i18n'
import type { WhiteboardObject } from './api'

const whiteboardWidth = 1400
const whiteboardHeight = 900

/**
 * Tree move API error を permission denial または一般失敗の表示 key へ変換します。
 *
 * @param error - Move callback が返した任意の error です。
 * @returns Document tree に表示する翻訳 key です。
 */
export function resolveDocumentMoveErrorKey(error: unknown): MessageKey {
  return (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    error.status === 403
  )
    ? 'documents.tree.moveDenied'
    : 'documents.tree.moveError'
}

/**
 * Whiteboard object を canvas 外へ出さずに指定量だけ移動します。
 *
 * @param object - 移動対象 object です。
 * @param deltaX - X 軸の移動量です。
 * @param deltaY - Y 軸の移動量です。
 * @returns Bounds 以外を保持した新しい object です。
 */
export function moveWhiteboardObjectWithinCanvas(
  object: WhiteboardObject,
  deltaX: number,
  deltaY: number,
) {
  return {
    ...object,
    bounds: {
      ...object.bounds,
      x: clamp(
        object.bounds.x + deltaX,
        0,
        whiteboardWidth - object.bounds.width,
      ),
      y: clamp(
        object.bounds.y + deltaY,
        0,
        whiteboardHeight - object.bounds.height,
      ),
    },
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
