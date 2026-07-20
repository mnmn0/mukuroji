import type { RequestForm } from '@mukuroji/contracts'

/**
 * Form editor instance を form ID 単位で安定させる React key を返します。
 *
 * Revision 更新では editor を remount しないため、persist 後の publish failure と
 * その error state を同じ instance で保持できます。
 *
 * @param form - 編集対象 form、または新規 editor の undefined です。
 * @returns Form ID、または新規 editor 用の固定 key です。
 */
export function getRequestFormEditorInstanceKey(
  form: Pick<RequestForm, 'id'> | undefined,
) {
  return form?.id ?? 'new'
}
