/**
 * Work Item または Project のうち、file を所有する resource scope です。
 */
export type FileResourceScope =
  | {
      /**
       * Team-owned Work Item scope です。
       */
      kind: 'work-item'
      /**
       * Work Item を所有する Team ID です。
       */
      teamId: string
      /**
       * Work Item ID です。
       */
      issueId: string
    }
  | {
      /**
       * Team 内 Project scope です。
       */
      kind: 'project'
      /**
       * Project を所有する Team ID です。
       */
      teamId: string
      /**
       * Project ID です。
       */
      projectId: string
    }
