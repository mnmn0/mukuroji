# AI activity and workspace clarity

## Intent and references

The user supplied a whiteboard screenshot with horizontal state lanes, compact
task tiles, and a persistent detail pane. Adapt its separation of active work,
human decisions, waiting, and finished work. Keep the existing Mukuroji teal
identity and readable solid surfaces.

Refero is unavailable in this session; no Refero research is claimed. The supplied
image, existing Home/TaskHeader/Sidebar, and AI review stories are the references.
There is no hero or illustrative image on this operational screen.

## Design

- One AI activity entry is available throughout the workspace when an AI task is
  enabled or the session already has history. Opening it overlays the current
  screen so an active request is not unmounted.
- Horizontal lanes distinguish processing, human review, stopped work, reviewed
  work, and errors. State names accompany color; counts are derived from actual
  operations. Selecting a tile reveals its observed event history and origin.
- White surfaces, teal actions, blue processing, amber attention, green reviewed,
  and red errors. Borders replace nested cards and decorative backgrounds.
- 8px maximum corner radius, 14px body, 12px metadata, 24px title. Controls have
  44px targets and visible keyboard focus. No progress percentages are invented.
- Desktop uses a detail column beside stacked lanes. Phone uses a single column
  with an explicit detail/back transition; search and filters wrap.
- Home emphasizes actionable work before workspace totals. Task headers reduce
  repeated counters; navigation groups daily work separately from resources.

## Data and states

The current API generates drafts synchronously and does not expose a global job
list. The board therefore describes only this authenticated browser session.
It stores bounded in-memory operation metadata, never prompts, generated content,
credentials, or model claims. Authentication changes/remounts clear the store.
Leaving an assistant closes its local request/review; this is shown as stopped,
not a resumable background job. Reviewed means a human decision was recorded,
not that a domain task was completed or a proposed edit was saved.

Empty, filtered-empty, running, decision-pending, review, rejected, approved,
cancelled, closed, expired, withheld, and failed operations need explicit copy.
Error classification and existing review/adoption authorization remain intact.
An in-flight review decision remains active across the draft's review deadline;
only a draft still awaiting a decision expires locally.

## Verification

Run required Web lint, build, and Storybook build, dependency checks, targeted
activity lifecycle and existing AI controller tests. Inspect the activity board,
AI review, Home, and task header at desktop and phone widths. Check selection,
filters, dialog focus/escape/return, overflow, contrast, and reduced motion.

Verified in the running Storybook at 1440×900 and 390×844: activity overview,
selection/details, Home shell, task header, and generating review. No page-level
horizontal overflow was observed. Task view tabs retain their intentional local
horizontal scrolling. Search/attention-filter and real-controller/session play
stories pass. Opening the native modal preserves the generation; native Escape
and the close action return focus to its launcher. Phone selection focuses details.
Every new action has a 44px minimum target. State names accompany every marker;
primary text colors meet WCAG AA on their light surfaces. Animation is limited to
`motion-safe:animate-pulse`; reduced-motion behavior was checked in generated CSS.

The app development server also starts successfully. Authenticated visual checks
use the actual workspace shell with Storybook fixtures; no live provider call was
made. Offline controller integration checks cover late cancellation results,
permission redaction, session isolation, retention, and bounded history.

Follow-up review verified desktop Tab traversal stays on activity cards, phone
detail/back transitions restore focus, disabled AI hides an empty launcher while
retaining existing history, and Home's DOM order matches its visual hierarchy.
Four targeted Chromium E2E cases pass, including preference/policy gates and
coexisting AI/task/triage live status regions. A lifecycle regression covers
decisions crossing the review deadline and surviving history cleanup.
Additional session stories verify that a recorded approval survives a failed
post-decision read while source metadata and draft content are cleared, and that
phone focus returns to the filter controls when an asynchronous result leaves
the selected filter. Live result counts announce the change.
Responsive focus follows breakpoint changes, clearing history returns focus to
stable filters, and a dismissed dialog falls back to the workspace when its
launcher no longer exists. The history-clear session story covers this path.
State-lane movement retains focus on the corresponding card, including the
return target when leaving phone details after a state update.
