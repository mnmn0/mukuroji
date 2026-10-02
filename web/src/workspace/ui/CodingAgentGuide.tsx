import { useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { MessageKey } from '../../shared/i18n/i18n'
import { codingAgentConfigurationTemplate } from '../model/codingAgentGuide'

/** Localized inputs for the external coding-agent connection guide. */
export type CodingAgentGuideProps = {
  /** Resolves the guide's interface and instructions in the active locale. */
  t: (key: MessageKey) => string
}

/** One ordered step in the shared task workflow. */
type WorkflowStep = {
  /** Translation key for the step heading. */
  title: MessageKey
  /** Translation key for the concrete tool sequence. */
  description: MessageKey
}

const workflowSteps: readonly WorkflowStep[] = [
  { title: 'agents.guide.configureTitle', description: 'agents.guide.configureDescription' },
  { title: 'agents.guide.startTitle', description: 'agents.guide.startDescription' },
  { title: 'agents.guide.reportTitle', description: 'agents.guide.reportDescription' },
  { title: 'agents.guide.completeTitle', description: 'agents.guide.completeDescription' },
]

/**
 * Explains the real MCP connection and task lifecycle with a credential-free template.
 *
 * @param props - Translator for setup, workflow, and clipboard feedback.
 * @returns An addressable Help section with accessible manual-copy recovery.
 */
export function CodingAgentGuide({ t }: CodingAgentGuideProps) {
  const [copyState, setCopyState] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle')
  const configurationRef = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()
  const configurationId = useId()
  const copyFeedbackId = useId()

  /** Copies only the public template, or selects it for manual copying on failure. */
  async function copyConfiguration() {
    if (copyState === 'pending') return
    setCopyState('pending')
    try {
      await navigator.clipboard.writeText(codingAgentConfigurationTemplate)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
      configurationRef.current?.focus()
      configurationRef.current?.select()
    }
  }

  return (
    <section aria-labelledby={titleId} className="min-w-0 scroll-mt-5 border-y border-[var(--workbench-border)] bg-white" id="coding-agent">
      <header className="border-b border-[var(--workbench-border)] px-5 py-5">
        <p className="text-xs font-semibold text-[var(--workbench-primary)]">{t('agents.guide.eyebrow')}</p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-[var(--workbench-text)]" id={titleId}>{t('agents.guide.title')}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--workbench-muted)]">{t('agents.guide.description')}</p>
      </header>
      <div className="grid min-w-0 gap-7 px-5 py-6 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('agents.guide.setupTitle')}</h3>
          <ol className="mt-4 grid list-decimal gap-5 pl-5 marker:font-semibold marker:text-[var(--workbench-primary)]">
            <li className="pl-1">
              <h4 className="text-sm font-semibold text-[var(--workbench-text)]">{t('agents.guide.credentialsTitle')}</h4>
              <p className="mt-1 text-sm leading-6 text-[var(--workbench-muted)]">{t('agents.guide.credentialsDescription')}</p>
              <Link className="mt-2 inline-flex min-h-[44px] items-center text-sm font-semibold text-[var(--workbench-primary)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2" to="/settings">
                {t('agents.guide.openSettings')}
              </Link>
            </li>
            <li className="pl-1">
              <h4 className="text-sm font-semibold text-[var(--workbench-text)]">{t('agents.guide.scopeTitle')}</h4>
              <p className="mt-1 text-sm leading-6 text-[var(--workbench-muted)]">{t('agents.guide.scopeDescription')}</p>
            </li>
            <li className="pl-1">
              <h4 className="text-sm font-semibold text-[var(--workbench-text)]">{t('agents.guide.clientTitle')}</h4>
              <p className="mt-1 break-words text-sm leading-6 text-[var(--workbench-muted)]">{t('agents.guide.clientDescription')}</p>
            </li>
          </ol>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('agents.guide.configTitle')}</h3>
            <button
              aria-disabled={copyState === 'pending' || undefined}
              aria-describedby={copyState === 'copied' || copyState === 'failed' ? copyFeedbackId : undefined}
              className="workbench-button-primary min-h-[44px] px-3 text-xs aria-disabled:opacity-60"
              onClick={() => { void copyConfiguration() }}
              type="button"
            >
              {t(copyState === 'pending' ? 'agents.guide.copying' : 'agents.guide.copy')}
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--workbench-muted)]">{t('agents.guide.configDescription')}</p>
          <label className="sr-only" htmlFor={configurationId}>{t('agents.guide.configLabel')}</label>
          <textarea
            className="mt-3 block min-h-80 w-full min-w-0 resize-y rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3 font-mono text-xs leading-5 text-[var(--workbench-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workbench-focus)]"
            id={configurationId}
            readOnly
            ref={configurationRef}
            rows={18}
            spellCheck={false}
            value={codingAgentConfigurationTemplate}
          />
          <p className={`mt-2 text-xs leading-5 ${copyState === 'failed' ? 'text-amber-800' : 'text-[var(--workbench-primary)]'}`} id={copyFeedbackId} role="status">
            {copyState === 'copied' ? t('agents.guide.copied') : copyState === 'failed' ? t('agents.guide.copyFailed') : null}
          </p>
          <p className="mt-3 break-words text-xs leading-6 text-[var(--workbench-muted)]">{t('agents.guide.tokenHelp')}</p>
        </div>
      </div>
      <details className="border-t border-[var(--workbench-border)] px-5">
        <summary className="cursor-pointer py-4 text-sm font-semibold text-[var(--workbench-text)] focus-visible:outline-2 focus-visible:outline-offset-2">{t('agents.guide.optionsTitle')}</summary>
        <ul className="grid list-disc gap-2 pb-5 pl-5 text-sm leading-6 text-[var(--workbench-muted)]">
          <li className="break-words">{t('agents.guide.projectOption')}</li>
          <li className="break-words">{t('agents.guide.readOnlyOption')}</li>
          <li>{t('agents.guide.restartOption')}</li>
          <li>{t('agents.guide.verifyOption')}</li>
        </ul>
      </details>
      <div className="border-t border-[var(--workbench-border)] px-5 py-5">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('agents.guide.workflowTitle')}</h3>
        <ol className="mt-5 grid list-decimal gap-x-10 gap-y-5 pl-5 marker:font-semibold marker:text-[var(--workbench-primary)] min-[760px]:grid-cols-2">
          {workflowSteps.map((step) => (
            <li className="min-w-0 pl-1" key={step.title}>
              <h4 className="text-sm font-semibold text-[var(--workbench-text)]">{t(step.title)}</h4>
              <p className="mt-1 break-words text-xs leading-6 text-[var(--workbench-muted)]">{t(step.description)}</p>
            </li>
          ))}
        </ol>
        <p className="mt-5 break-words text-xs leading-6 text-[var(--workbench-muted)]">{t('agents.guide.workflowResource')}</p>
      </div>
      <p className="border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4 text-xs leading-6 text-[var(--workbench-muted)]">{t('agents.guide.limitations')}</p>
    </section>
  )
}
