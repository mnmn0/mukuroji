# Workspace UI refinement

The shared application shell and everyday work views now use a quieter hierarchy:
summary first, actionable work second, waiting work alongside it. A 256px forest-green
sidebar leaves more room for content, with a restrained selected state and unread badge.

## Design decisions

- Retain Mukuroji's brand mark and teal action color. Use neutral surfaces, fine borders,
  8px-or-smaller corners, and a consistent system-font stack. No decorative hero,
  gradients, new fonts, or icon dependency.
- Put Home metrics in a semantic definition list that switches from four columns to
  two on phones. Keep unavailable Focus values distinct from zero.
- Give Focus one primary action. Show complete task titles above status/date metadata;
  waiting items use separated rows instead of nested cards.
- Keep the mobile header compact, make the primary action and logout at least 44px high,
  retain drawer focus restoration, and give keyboard focus a visible outline.
- Use muted board lanes behind task cards. Shared metric cards elsewhere use a small
  semantic color marker instead of four competing colored borders.
- Keep existing routes, ranking, permissions, mutations, and translations' key names.
  Japanese and English wording was updated together.

Refero was unavailable in this session. No external-reference research is claimed;
the repository's `mukuroji-ui-design` fallback constraints guided these changes.

## Visual comparison

These images contain only existing Storybook fixture data, not production records.

### Before — 1440 × 900

![Previous workspace home](workspace-ui/before-desktop.png)

### After — 1440 × 900

![Updated workspace home](workspace-ui/after-desktop.png)

### After — 390 × 844

![Updated mobile workspace home](workspace-ui/after-mobile.png)

## Verification and reproduction

Run `bun install --frozen-lockfile`, then `bun run web:storybook` and open
`http://127.0.0.1:6006/iframe.html?id=application-pages-workspaceroutes--home-route&viewMode=story`.
The after images were captured with Playwright 1.60.0 using local headless Chrome.
The before image uses the same fixture via the recovered common-data-error shell at
base `ecd3ffbd`. Use the listed viewport sizes to reproduce the composition.

- Lint, production build, and Storybook build passed.
- Home (Japanese/English, empty, unavailable, loading), Dashboard, My Tasks, project
  Task Screen, and long-title rows were checked at 1440, 390, and 320px: 27 combinations,
  no document horizontal overflow or browser exceptions.
- Keyboard focus, sidebar collapse/expand, phone drawer Escape and focus restoration,
  primary Focus deep link, and reduced motion were checked in Chrome.
- Text contrast: muted text on white 5.08:1, teal on white 5.47:1, sidebar muted text
  7.22:1. Sidebar focus ring against its background: 10.06:1.
- Existing real-app workspace-session E2E: 7 passed, with local API stubs.
- Web unit tests: 1141 passed. AI review suites pin their clock within the fixed
  fixtures' retention window; a regression test verifies withholding at the deadline.
  This fixes 22 date-dependent failures also reproduced at the base commit.
  The Home assertion now verifies the link text independently
  of its decorative icon while preserving the Next-section deep-link check.

This is a targeted pass over shared presentation and daily work surfaces. It does not
claim an exhaustive accessibility audit or verification of every administrative screen.
