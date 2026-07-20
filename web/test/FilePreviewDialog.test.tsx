import { describe, expect, test } from 'bun:test'
import type { FileAttachment } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { FilePreviewDialog } from '../src/files/ui/FilePreviewDialog'
import {
  fileArtifactsControllerFixture,
  imageFileFixture,
} from '../src/files/fixtures'
import { collaborationWorkspaceMemberFixtures } from '../src/issues/fixtures'

describe('FilePreviewDialog', () => {
  test('only offers center annotation placement for an available version', () => {
    const availableHtml = renderToStaticMarkup(
      <FilePreviewDialog
        controller={fileArtifactsControllerFixture}
        file={imageFileFixture}
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
        onClose={() => undefined}
      />,
    )
    const blockedVersion = {
      ...imageFileFixture.currentVersion,
      id: 'version-image-blocked',
      scanStatus: 'blocked' as const,
    }
    const blockedFile = {
      ...imageFileFixture,
      currentVersion: blockedVersion,
      versions: [blockedVersion],
    } satisfies FileAttachment
    const blockedHtml = renderToStaticMarkup(
      <FilePreviewDialog
        controller={fileArtifactsControllerFixture}
        file={blockedFile}
        locale="en"
        members={collaborationWorkspaceMemberFixtures}
        onClose={() => undefined}
      />,
    )

    expect(availableHtml).toContain('Add an annotation at the center')
    expect(blockedHtml).toContain('Blocked')
    expect(blockedHtml).not.toContain('Add an annotation at the center')
  })
})
