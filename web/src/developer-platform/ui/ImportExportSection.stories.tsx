import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  developerPlatformLabelsFixture,
  developerPlatformResourcesFixture,
  importDryRunErrorDeveloperPlatformResourcesFixture,
  successfulImportDryRunReportFixture,
} from '../fixtures'
import { ImportExportSection } from './ImportExportSection'

/**
 * Storybook metadata for the isolated import/export section.
 */
const meta = {
  title: 'Application/Developer Platform/Import and Export Section',
  component: ImportExportSection,
  parameters: {
    layout: 'padded',
  },
  args: {
    canExport: true,
    canImport: true,
    format: 'csv',
    importMappings: [
      { sourceField: 'Title', targetField: 'title' },
    ],
    importProjectId: 'project-mukuroji',
    importProjectOptions: [
      {
        value: 'project-mukuroji',
        label: 'mukuroji',
        description: 'Product delivery project.',
        teamId: 'team-product',
      },
    ],
    importTeamId: 'team-product',
    importTeamOptions: [
      {
        value: 'team-product',
        label: 'Product',
        description: 'Product engineering Team.',
      },
    ],
    labels: developerPlatformLabelsFixture,
    latestImport: developerPlatformResourcesFixture.imports[0],
    onExport: async () => undefined,
    onFileChange: () => undefined,
    onFormatChange: () => undefined,
    onMappingChange: () => undefined,
    onProjectChange: () => undefined,
    onSubmit: (event) => event.preventDefault(),
    onTeamChange: () => undefined,
  },
} satisfies Meta<typeof ImportExportSection>

export default meta

/** Story type for the isolated import/export section. */
type Story = StoryObj<typeof meta>

/** Displays the most recent import report and enabled export actions. */
export const Default: Story = {}

/** Displays a valid dry-run report with the commit action. */
export const ValidPreview: Story = {
  args: {
    previewReport: successfulImportDryRunReportFixture,
    onCommit: () => undefined,
  },
}

/** Displays row-level errors from an invalid import dry-run. */
export const DryRunError: Story = {
  args: {
    latestImport:
      importDryRunErrorDeveloperPlatformResourcesFixture.imports[0],
  },
}

/** Displays import and export controls without mutation capabilities. */
export const ReadOnly: Story = {
  args: {
    canExport: false,
    canImport: false,
    onExport: undefined,
    onSubmit: undefined,
  },
}

/** Displays the rows and links a running import has processed so far. */
export const RunningImport: Story = {
  args: {
    latestImport: {
      ...developerPlatformResourcesFixture.imports[0]!,
      status: 'running',
    },
    latestImportProgress: {
      jobId: developerPlatformResourcesFixture.imports[0]!.id,
      status: 'running',
      totalRows: 5_000,
      processedRows: 1_200,
      totalLinks: 4_900,
      processedLinks: 0,
    },
  },
}

/** Displays the retry action when the running import's progress could not be loaded. */
export const ImportProgressFailed: Story = {
  args: {
    latestImport: {
      ...developerPlatformResourcesFixture.imports[0]!,
      status: 'running',
    },
    latestImportProgressFailed: true,
    onRetryImportProgress: () => undefined,
  },
}
