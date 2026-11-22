import { describe, expect, test } from 'bun:test'
import {
  createDefaultDueDateWorkItemSchedule,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CanonicalWorkItem,
  type TeamWorkItemHierarchyNode,
  type WorkItemScheduleDependency,
} from '@mukuroji/contracts'
import { readDeveloperImportSource, suggestDeveloperImportMapping } from '../src/developer-platform/model/importSources'
import { createMsProjectXml, readMsProjectXml } from '../src/developer-platform/model/msProjectXml'
import { findSpreadsheetTable, readSpreadsheetWorkbook } from '../src/developer-platform/model/spreadsheet'
import { createDeveloperExportFile, type DeveloperExportContext } from '../src/developer-platform/model/transfers'
import { parseXmlDocument } from '../src/developer-platform/model/xmlDocument'
import { createZipArchive, readZipArchive } from '../src/developer-platform/model/zipArchive'

/** Workbook saved by openpyxl: a title row above the header, shared strings, and date cells. */
const openpyxlWorkbook = 'UEsDBBQAAAAIAN2Odl1Gx01IlQAAAM0AAAAQAAAAZG9jUHJvcHMvYXBwLnhtbE3PTQvCMAwG4L9SdreZih6kDkQ9ip68zy51hbYpbYT67+0EP255ecgboi6JIia2mEXxLuRtMzLHDUDWI/o+y8qhiqHke64x3YGMsRoPpB8eA8OibdeAhTEMOMzit7Dp1C5GZ3XPlkJ3sjpRJsPiWDQ6sScfq9wcChDneiU+ixNLOZcrBf+LU8sVU57mym/8ZAW/B7oXUEsDBBQAAAAIAN2Odl12A87/8AAAACsCAAARAAAAZG9jUHJvcHMvY29yZS54bWzNks9OwzAMh18F5d666dgQUdcL004gITEJxC1KvC2i+aPEqN3b04atE4IH4Bj7l8+fJTcqCOUjPkcfMJLBdDPYziWhwpodiYIASOqIVqZyTLixuffRShqf8QBBqg95QKiragUWSWpJEiZgEWYiaxuthIooycczXqsZHz5jl2FaAXZo0VECXnJg7TQxnIaugStgghFGm74LqGdirv6JzR1g5+SQzJzq+77sFzk37sDh7enxJa9bGJdIOoXjr2QEnQKu2WXy6+Jhs9uytq7qVcF5Udc7fieWt2J5/z65/vC7Cluvzd78Y+OLYNvAr7tovwBQSwMEFAAAAAgA3Y52XZlcnCMQBgAAnCcAABMAAAB4bC90aGVtZS90aGVtZTEueG1s7Vpbc9o4FH7vr9B4Z/ZtC8Y2gba0E3Npdtu0mYTtTh+FEViNbHlkkYR/v0c2EMuWDe2STbqbPAQs6fvORUfn6Dh58+4uYuiGiJTyeGDZL9vWu7cv3uBXMiQRQTAZp6/wwAqlTF61WmkAwzh9yRMSw9yCiwhLeBTL1lzgWxovI9bqtNvdVoRpbKEYR2RgfV4saEDQVFFab18gtOUfM/gVy1SNZaMBE1dBJrmItPL5bMX82t4+Zc/pOh0ygW4wG1ggf85vp+ROWojhVMLEwGpnP1Zrx9HSSICCyX2UBbpJ9qPTFQgyDTs6nVjOdnz2xO2fjMradDRtGuDj8Xg4tsvSi3AcBOBRu57CnfRsv6RBCbSjadBk2PbarpGmqo1TT9P3fd/rm2icCo1bT9Nrd93TjonGrdB4Db7xT4fDronGq9B062kmJ/2ua6TpFmhCRuPrehIVteVA0yAAWHB21szSA5ZeKfp1lBrZHbvdQVzwWO45iRH+xsUE1mnSGZY0RnKdkAUOADfE0UxQfK9BtorgwpLSXJDWzym1UBoImsiB9UeCIcXcr/31l7vJpDN6nX06zmuUf2mrAaftu5vPk/xz6OSfp5PXTULOcLwsCfH7I1thhyduOxNyOhxnQnzP9vaRpSUyz+/5CutOPGcfVpawXc/P5J6MciO73fZYffZPR24j16nAsyLXlEYkRZ/ILbrkETi1SQ0yEz8InYaYalAcAqQJMZahhvi0xqwR4BN9t74IyN+NiPerb5o9V6FYSdqE+BBGGuKcc+Zz0Wz7B6VG0fZVvNyjl1gVAZcY3zSqNSzF1niVwPGtnDwdExLNlAsGQYaXJCYSqTl+TUgT/iul2v6c00DwlC8k+kqRj2mzI6d0Js3oMxrBRq8bdYdo0jx6/gX5nDUKHJEbHQJnG7NGIYRpu/AerySOmq3CEStCPmIZNhpytRaBtnGphGBaEsbReE7StBH8Waw1kz5gyOzNkXXO1pEOEZJeN0I+Ys6LkBG/HoY4SprtonFYBP2eXsNJweiCy2b9uH6G1TNsLI73R9QXSuQPJqc/6TI0B6OaWQm9hFZqn6qHND6oHjIKBfG5Hj7lengKN5bGvFCugnsB/9HaN8Kr+ILAOX8ufc+l77n0PaHStzcjfWfB04tb3kZuW8T7rjHa1zQuKGNXcs3Ix1SvkynYOZ/A7P1oPp7x7frZJISvmlktIxaQS4GzQSS4/IvK8CrECehkWyUJy1TTZTeKEp5CG27pU/VKldflr7kouDxb5OmvoXQ+LM/5PF/ntM0LM0O3ckvqtpS+tSY4SvSxzHBOHssMO2c8kh22d6AdNfv2XXbkI6UwU5dDuBpCvgNtup3cOjiemJG5CtNSkG/D+enFeBriOdkEuX2YV23n2NHR++fBUbCj7zyWHceI8qIh7qGGmM/DQ4d5e1+YZ5XGUDQUbWysJCxGt2C41/EsFOBkYC2gB4OvUQLyUlVgMVvGAyuQonxMjEXocOeXXF/j0ZLj26ZltW6vKXcZbSJSOcJpmBNnq8reZbHBVR3PVVvysL5qPbQVTs/+Wa3InwwRThYLEkhjlBemSqLzGVO+5ytJxFU4v0UzthKXGLzj5sdxTlO4Ena2DwIyubs5qXplMWem8t8tDAksW4hZEuJNXe3V55ucrnoidvqXd8Fg8v1wyUcP5TvnX/RdQ65+9t3j+m6TO0hMnHnFEQF0RQIjlRwGFhcy5FDukpAGEwHNlMlE8AKCZKYcgJj6C73yDLkpFc6tPjl/RSyDhk5e0iUSFIqwDAUhF3Lj7++TaneM1/osgW2EVDJk1RfKQ4nBPTNyQ9hUJfOu2iYLhdviVM27Gr4mYEvDem6dLSf/217UPbQXPUbzo5ngHrOHc5t6uMJFrP9Y1h75Mt85cNs63gNe5hMsQ6R+wX2KioARq2K+uq9P+SWcO7R78YEgm/zW26T23eAMfNSrWqVkKxE/Swd8H5IGY4xb9DRfjxRiraaxrcbaMQx5gFjzDKFmON+HRZoaM9WLrDmNCm9B1UDlP9vUDWj2DTQckQVeMZm2NqPkTgo83P7vDbDCxI7h7Yu/AVBLAwQUAAAACADdjnZdHW5ArNYBAAC/BAAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbH1UXY+bMBD8K5Yf+hgTQu6qKyA1H1WrqlKUu7bPJixgnbGpvYTev69NLohE0AeEd3dmvLOyHXfavNoKAMnfWiqb0AqxeWLMniqouV3oBpSrFNrUHF1oSmYbAzzvSbVkYRA8sJoLRdO4zx1MGusWpVBwMMS2dc3N2wak7hK6pNfEUZQV+gRL44aX8Az4szkYF7FBJRc1KCu0IgaKhH5ePu0jj+8BvwR0drQm3kmm9asPvuUJDXxDIOGEXoG73xm2IKUXcm38edekw5aeOF5f1b/03p2XjFvYavlb5Fgl9CMlORS8lXjU3Vd497MeGtxx5GlsdEeM95nGJ7/wezucUH4+z2hcXriNMD26Vp0+aSRXMUPXiM+zk/ucxiAUDkLhjNB3eLvl9/DNHPxFoIQJwnaOsGun4Ls5+L5wZwcnGPvZDbSC/0xgNUxgNSPAp/zPgXdgRammBuAYtj+yjudP9zmNHsLVY8zOY9+rUT1crG+r+0s166vLoXbjJxr8RDMtZlN+5sCbVsicfOB184kg2KnJb6MpZ1F05ywa1+98RSNfwZ0vNjr+/mr/4KYUyhIJheMEi8c1JeZyXS4B6qbvJtOIuu6XlXthwHiAqxda4zXwt3V4s9J/UEsDBBQAAAAIAN2Odl0UBBlNfgIAAL8KAAANAAAAeGwvc3R5bGVzLnhtbN1WTYvbMBD9K0b3rTZx18QlzqGGQKEtC7uHXpVITgT6cGV5Sfrrq7G8TrzRLLT0VJvg0Ty9Nx8a46w7f1bi6SiEz05ama4iR+/bT5R2+6PQrPtgW2EC0linmQ9Ld6Bd6wTjHZC0osv7+4JqJg3ZrE2vt9p32d72xldkObmy+PjCK7IoPpIsytWWi4qcw3Wn9R3nhCb3P9zup1rTuJ+OMTfrxppL6AWJjiDItMhemKpIzZTcOQmshmmpztG9BMfeKusyH2oWQA6e7leEF3EF7Rh1tDTWDbFjhOEBCUilZrWDY7NumffCmW1YDJzBeQNlo/18bkMGB8fOi+UDuRCGRwiys44LN6szujZrJRofCE4ejvD0tqUAem91MLhkB2vYkMMrYzSC7F4o9QSz8KOZaZ+aq6O4h4MwkxkSGs0oExegf60Wta9kl38lm7XyxfrPfajGDOufvfXi0YlGnob1qZniz9TH+fmX+nSs6Kpts6ZN3gyGryLfYXrVRSLb9VJ5acbVUXIuzE3vgrxnu/B2zvTDfi4a1iv/PIEVudjfBJe9Lqddj1DWuOtif4UZWRTT5IdY0nBxErwel+6wG8wsGCHqeAHhLbIdrjSCcSKWRgDD4mAZYJzIwuL8T/Ws0HoihuW2SiIrlLNCOZGVQurhxuKkOWW40pWWZZ4XBdbRuk5mUGN9Kwr4pdWw3ICBxYFIf9Zr/LTxCXl/DrAzfW9CsErxScQqxXsNSLpvwCjL9GljcYCBnQI2OxA/HQdmKs3JczhVLDfsDcaRssQQmMX0jBYF0p0C7vT5YG9JnpdlGgEsnUGeYwi8jTiCZQA5YEieD9/BN98j+vqdope/rJvfUEsDBBQAAAAIAN2Odl2XirscwAAAABMCAAALAAAAX3JlbHMvLnJlbHOdkrluwzAMQH/F0J4wB9AhiDNl8RYE+QFWog/YEgWKRZ2/r9qlcZALGXk9PBLcHmlA7TiktoupGP0QUmla1bgBSLYlj2nOkUKu1CweNYfSQETbY0OwWiw+QC4ZZre9ZBanc6RXiFzXnaU92y9PQW+ArzpMcUJpSEszDvDN0n8y9/MMNUXlSiOVWxp40+X+duBJ0aEiWBaaRcnToh2lfx3H9pDT6a9jIrR6W+j5cWhUCo7cYyWMcWK0/jWCyQ/sfgBQSwMEFAAAAAgA3Y52XVg3MeEyAQAAIQIAAA8AAAB4bC93b3JrYm9vay54bWyNUdFKw0AQ/JVwH2BS0YKl6YtFLYgWK32/JJtm6d1t2Nu02q93kxAs+OLT3s4sw8zc8kx8LIiOyZd3IeamEWkXaRrLBryNN9RCUKYm9lZ05UMaWwZbxQZAvEtvs2yeeovBrJaT1pbT64UESkEKCvbAHuEcf/l+TU4YsUCH8p2b4e3AJB4DerxAlZvMJLGh8wsxXiiIdbuSybnczEZiDyxY/oF3vclPW8QBEVt8WDWSm3mmgjVylOFi0Lfq8QR6PG6d0BM6AV5bgWemrsVw6GU0RXoVY+hhmmOJC/5PjVTXWMKays5DkLFHBtcbDLHBNpokWA+52Tob+jiqv6nGaKKeroriBSrBm2p0N1mqoMYA1ZuqRMW1nnLLST8Gndu7+9mD1tA596jYe3glW00Jp99Z/QBQSwMEFAAAAAgA3Y52XSQem6KtAAAA+AEAABoAAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc7WRPQ6DMAyFrxLlADVQqUMFTF1YKy4QBfMjEhLFrgq3L4UBkDp0YbKeLX/vyU6faBR3bqC28yRGawbKZMvs7wCkW7SKLs7jME9qF6ziWYYGvNK9ahCSKLpB2DNknu6Zopw8/kN0dd1pfDj9sjjwDzC8XeipRWQpShUa5EzCaLY2wVLiy0yWoqgyGYoqlnBaIOLJIG1pVn2wT06053kXN/dFrs3jCa7fDHB4dP4BUEsDBBQAAAAIAN2Odl1lkHmSGQEAAM8DAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2TTU7DMBCFrxJlWyUuLFigphtgC11wAWNPGqv+k2da0tszTtpKoBIVhU2seN68z56XrN6PEbDonfXYlB1RfBQCVQdOYh0ieK60ITlJ/Jq2Ikq1k1sQ98vlg1DBE3iqKHuU69UztHJvqXjpeRtN8E2ZwGJZPI3CzGpKGaM1ShLXxcHrH5TqRKi5c9BgZyIuWFCKq4Rc+R1w6ns7QEpGQ7GRiV6lY5XorUA6WsB62uLKGUPbGgU6qL3jlhpjAqmxAyBn69F0MU0mnjCMz7vZ/MFmCsjKTQoRObEEf8edI8ndVWQjSGSmr3ghsvXs+0FOW4O+kc3j/QxpN+SBYljmz/h7xhf/G87xEcLuvz+xvNZOGn/mi+E/Xn8BUEsBAhQDFAAAAAgA3Y52XUbHTUiVAAAAzQAAABAAAAAAAAAAAAAAAIABAAAAAGRvY1Byb3BzL2FwcC54bWxQSwECFAMUAAAACADdjnZddgPO//AAAAArAgAAEQAAAAAAAAAAAAAAgAHDAAAAZG9jUHJvcHMvY29yZS54bWxQSwECFAMUAAAACADdjnZdmVycIxAGAACcJwAAEwAAAAAAAAAAAAAAgAHiAQAAeGwvdGhlbWUvdGhlbWUxLnhtbFBLAQIUAxQAAAAIAN2Odl0dbkCs1gEAAL8EAAAYAAAAAAAAAAAAAACAgSMIAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwECFAMUAAAACADdjnZdFAQZTX4CAAC/CgAADQAAAAAAAAAAAAAAgAEvCgAAeGwvc3R5bGVzLnhtbFBLAQIUAxQAAAAIAN2Odl2XirscwAAAABMCAAALAAAAAAAAAAAAAACAAdgMAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAN2Odl1YNzHhMgEAACECAAAPAAAAAAAAAAAAAACAAcENAAB4bC93b3JrYm9vay54bWxQSwECFAMUAAAACADdjnZdJB6boq0AAAD4AQAAGgAAAAAAAAAAAAAAgAEgDwAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECFAMUAAAACADdjnZdZZB5khkBAADPAwAAEwAAAAAAAAAAAAAAgAEFEAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLBQYAAAAACQAJAD4CAABPEQAAAAA='

const zipLimits = { maxEntries: 10, maxEntryBytes: 1_000, maxTotalBytes: 2_000 }

/**
 * Builds an exported Work Item.
 *
 * @param overrides - Fields to replace.
 * @returns The Work Item.
 */
function workItem(overrides: Partial<CanonicalWorkItem>): CanonicalWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id: 'item',
    teamId: 'team-a',
    title: 'Item',
    assigneeUserId: 'user-owner',
    creatorMemberKey: 'member-owner',
    customFieldValues: {},
    statusCategory: 'unstarted',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'todo',
    dueDate: '2026-08-03',
    schedule: createDefaultDueDateWorkItemSchedule('2026-08-03'),
    priority: 'medium',
    relationIds: [],
    source: 'dynamodb',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Builds a hierarchy node.
 *
 * @param workItemId - Work Item.
 * @param parentWorkItemId - Parent, or null at the top.
 * @param depth - Outline depth.
 * @param wbsNumber - WBS number.
 * @returns The node.
 */
function node(workItemId: string, parentWorkItemId: string | null, depth: number, wbsNumber: string): TeamWorkItemHierarchyNode {
  return { workItemId, parentWorkItemId, depth, wbsNumber, hierarchyRank: wbsNumber, childWorkItemIds: [] }
}

/**
 * Builds a schedule dependency.
 *
 * @param predecessor - Predecessor Work Item.
 * @param successor - Successor Work Item.
 * @param lagDays - Lag.
 * @returns The dependency.
 */
function dependency(predecessor: string, successor: string, lagDays: number): WorkItemScheduleDependency {
  return {
    id: `${predecessor}-${successor}`,
    predecessor: { teamId: 'team-a', workItemId: predecessor },
    successor: { teamId: 'team-a', workItemId: successor },
    type: 'finish-to-start',
    lagDays,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  }
}

const items = [
  workItem({
    id: 'design',
    title: 'Design',
    relationIds: ['blocks:build', 'related:outside'],
    contributorAssignments: [
      { assignmentId: 'a1', memberUserId: 'user-dev', plannedEffortMinutes: 120, status: 'planned' },
      { assignmentId: 'a2', jobRoleId: 'designer', status: 'in-progress' },
    ],
    acceptanceCriteria: [
      { id: '1'.repeat(32), text: 'Spec reviewed', satisfied: true },
      { id: '2'.repeat(32), text: 'Tests pass', satisfied: false },
    ],
  }),
  workItem({ id: 'build', title: '=Build', relationIds: ['parent:plan', 'blockedBy:design'], customFieldValues: { risk: 'high' } }),
  workItem({ id: 'plan', title: 'Plan', statusCategory: 'completed', description: 'Line 1\nLine 2' }),
]

const context: DeveloperExportContext = {
  hierarchies: new Map([['team-a', [node('plan', null, 0, '1'), node('design', 'plan', 1, '1.1'), node('build', 'plan', 1, '1.2')]]]),
  dependencies: [dependency('design', 'build', 2), dependency('outside', 'build', 0)],
}

const exportedAt = new Date('2026-07-10T00:00:00.000Z')

describe('Developer Platform ZIP and XML readers', () => {
  test('reads back stored entries and enforces the entry limits', async () => {
    const archive = createZipArchive([
      { name: 'a.txt', data: new TextEncoder().encode('alpha') },
      { name: 'dir/b.txt', data: new TextEncoder().encode('beta') },
    ])

    const files = await readZipArchive(archive, zipLimits)
    expect(new TextDecoder().decode(files.get('dir/b.txt'))).toBe('beta')
    expect([...(await readZipArchive(archive, zipLimits, (name) => name === 'a.txt')).keys()]).toEqual(['a.txt'])
    await expect(readZipArchive(archive, { ...zipLimits, maxEntryBytes: 4 })).rejects.toThrow('too large')
    await expect(readZipArchive(archive, { ...zipLimits, maxEntries: 1 })).rejects.toThrow('too many entries')
    await expect(readZipArchive(new Uint8Array(30), zipLimits)).rejects.toThrow('not a ZIP archive')
  })

  test('rejects document type declarations and unknown entities', () => {
    expect(() => parseXmlDocument('<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>')).toThrow('Document type')
    expect(() => parseXmlDocument('<x>&e;</x>')).toThrow('&e;')
    expect(parseXmlDocument('<a:x b:y="1 &amp; 2">&#x41;<![CDATA[<b>]]></a:x>')).toEqual({
      name: 'x',
      attributes: { y: '1 & 2' },
      children: ['A', '<b>'],
    })
  })
})

describe('Developer Platform workbook import', () => {
  test('finds the header row and reads shared strings, numbers, booleans, and dates of a saved workbook', async () => {
    const table = findSpreadsheetTable(await readSpreadsheetWorkbook(Uint8Array.from(atob(openpyxlWorkbook), (character) => character.charCodeAt(0))))

    expect(table.sheetName).toBe('Plan')
    expect(table.headerRow).toBe(2)
    expect(table.rows).toEqual([
      { Key: 'a', Title: 'Design', Due: '2026-08-03', Effort: 2.5, Done: true },
      { Key: 'b', Title: 'Build & test', Due: '2026-08-10', Effort: 4, Done: false },
    ])
  })
})

describe('Developer Platform Work Item export', () => {
  test('writes CSV rows in outline order with parents, dependencies, relations, contributors, and criteria', async () => {
    const file = createDeveloperExportFile('csv', items, context, exportedAt)
    const lines = (await file.blob.text()).replace(/^\ufeff/u, '').split('\r\n')

    expect(file.fileName).toBe('mukuroji-work-items-2026-07-10.csv')
    expect(lines[0]).toBe('id,teamId,wbsNumber,outlineLevel,parentId,title,description,assignedProjectId,assigneeUserId,workItemTypeId,workflowStatusId,statusCategory,dueDate,schedule,priority,dependencies,relations,contributors,acceptanceCriteria,revision,createdAt,updatedAt,customFieldValues.risk')
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual(['plan', 'design', 'build', ''])
    expect(lines.join('\n')).toContain(',blocks:build,member:user-dev effort:120 status:planned; role:designer status:in-progress,"[x] Spec reviewed\n[ ] Tests pass",')
    expect(lines.join('\n')).toContain(',1.2,2,plan,\'=Build,')
    expect(lines.join('\n')).toContain(',design FS +2,blockedBy:design,,,')
  })

  test('writes the same structure to JSON in the shape import reads', async () => {
    const file = createDeveloperExportFile('json', items, context, exportedAt)
    const body: unknown = JSON.parse(await file.blob.text())

    expect(body).toMatchObject({
      workItems: [
        { id: 'plan', wbsNumber: '1', outlineLevel: 1 },
        {
          id: 'design',
          parentId: 'plan',
          relations: [{ type: 'blocks', key: 'build' }],
          contributors: [
            { memberUserId: 'user-dev', plannedEffortMinutes: 120, status: 'planned' },
            { jobRoleId: 'designer', status: 'in-progress' },
          ],
          acceptanceCriteria: [{ text: 'Spec reviewed', satisfied: true }, { text: 'Tests pass', satisfied: false }],
        },
        {
          id: 'build',
          parentId: 'plan',
          dependencies: [{ key: 'design', type: 'finish-to-start', lagDays: 2 }],
          relations: [{ type: 'blockedBy', key: 'design' }],
        },
      ],
    })
  })

  test('re-imports an exported workbook with the same rows and a mapping for every structure column', async () => {
    const csvFile = createDeveloperExportFile('csv', items, context, exportedAt)
    const workbookFile = createDeveloperExportFile('xlsx', items, context, exportedAt)
    const csvSource = await readDeveloperImportSource('csv', fileFrom('export.csv', new Uint8Array(await csvFile.blob.arrayBuffer())))
    const workbookSource = await readDeveloperImportSource('xlsx', fileFrom('export.xlsx', new Uint8Array(await workbookFile.blob.arrayBuffer())))

    expect(workbookFile.fileName).toBe('mukuroji-work-items-2026-07-10.xlsx')
    expect(workbookSource.format).toBe('json')
    expect(workbookSource.headers).toEqual(csvSource.headers)
    const rows: unknown = JSON.parse(workbookSource.content)
    expect(rows).toEqual([
      expect.objectContaining({ id: 'plan', wbsNumber: '1', outlineLevel: '1', title: 'Plan', description: 'Line 1\nLine 2', statusCategory: 'completed' }),
      expect.objectContaining({
        id: 'design',
        parentId: 'plan',
        relations: 'blocks:build',
        contributors: 'member:user-dev effort:120 status:planned; role:designer status:in-progress',
        acceptanceCriteria: '[x] Spec reviewed\n[ ] Tests pass',
        dueDate: '2026-08-03',
        schedule: JSON.stringify(createDefaultDueDateWorkItemSchedule('2026-08-03')),
      }),
      expect.objectContaining({ id: 'build', title: '=Build', dependencies: 'design FS +2', 'customFieldValues.risk': 'high' }),
    ])
    expect(suggestDeveloperImportMapping(workbookSource.headers)).toEqual([
      { sourceField: 'id', targetField: 'importKey' },
      { sourceField: 'parentId', targetField: 'parentKey' },
      { sourceField: 'title', targetField: 'title' },
      { sourceField: 'description', targetField: 'description' },
      { sourceField: 'assignedProjectId', targetField: 'assignedProjectId' },
      { sourceField: 'assigneeUserId', targetField: 'assigneeUserId' },
      { sourceField: 'workItemTypeId', targetField: 'workItemTypeId' },
      { sourceField: 'workflowStatusId', targetField: 'workflowStatusId' },
      { sourceField: 'schedule', targetField: 'schedule' },
      { sourceField: 'priority', targetField: 'priority' },
      { sourceField: 'dependencies', targetField: 'dependencies' },
      { sourceField: 'relations', targetField: 'relations' },
      { sourceField: 'contributors', targetField: 'contributors' },
      { sourceField: 'acceptanceCriteria', targetField: 'acceptanceCriteria' },
      { sourceField: 'customFieldValues.risk', targetField: 'customFieldValues.risk' },
    ])
  })

  test('round-trips tasks, outline, predecessors, and assignments through MS Project XML', async () => {
    const file = createDeveloperExportFile('msproject', items, context, exportedAt)
    const source = await readDeveloperImportSource('msproject', fileFrom('plan.xml', new TextEncoder().encode(await file.blob.text())))
    const rows: unknown = JSON.parse(source.content)

    expect(rows).toEqual([
      { UID: '1', Name: 'Plan', WBS: '1', OutlineLevel: 1, Owner: 'user-owner', Contributors: '', Predecessors: '', Schedule: { mode: 'due-date', dueDate: '2026-08-03' }, Notes: 'Line 1\nLine 2' },
      { UID: '2', Name: 'Design', WBS: '1.1', OutlineLevel: 2, Owner: 'user-owner', Contributors: 'member:user-dev effort:120', Predecessors: '', Schedule: { mode: 'due-date', dueDate: '2026-08-03' }, Notes: '' },
      { UID: '3', Name: '=Build', WBS: '1.2', OutlineLevel: 2, Owner: 'user-owner', Contributors: '', Predecessors: '2 FS +2', Schedule: { mode: 'due-date', dueDate: '2026-08-03' }, Notes: '' },
    ])
    expect(suggestDeveloperImportMapping(source.headers).map((entry) => entry.targetField)).toEqual([
      'importKey', 'title', 'wbsNumber', 'outlineLevel', 'assigneeUserId', 'contributors', 'dependencies', 'schedule', 'description',
    ])
  })

  test('reads working-day lag and date ranges from a MS Project file', () => {
    const rows = readMsProjectXml(createMsProjectXml('Plan', [
      { key: 'a', name: 'A', outlineLevel: 1, startDate: '2026-08-03', finishDate: '2026-08-07', completed: false, ownerUserId: 'u', contributors: [], dependencies: [] },
    ]).replace('</Tasks>', '<Task><UID>9</UID><Name>B</Name><OutlineLevel>1</OutlineLevel><PredecessorLink><PredecessorUID>1</PredecessorUID><Type>3</Type><LinkLag>-4800</LinkLag><LagFormat>7</LagFormat></PredecessorLink></Task></Tasks>'))

    expect(rows.map((row) => [row.UID, row.Predecessors, row.Schedule])).toEqual([
      ['1', '', { mode: 'date-range', startDate: '2026-08-03', endDate: '2026-08-07' }],
      ['9', '1 SS -1', { mode: 'unscheduled' }],
    ])
    expect(() => readMsProjectXml('<Workbook/>')).toThrow('not MS Project XML')
  })
})

/**
 * Wraps bytes as a chosen file.
 *
 * @param name - File name.
 * @param bytes - File bytes.
 * @returns The file.
 */
function fileFrom(name: string, bytes: Uint8Array) {
  return new File([new Uint8Array(bytes)], name)
}
