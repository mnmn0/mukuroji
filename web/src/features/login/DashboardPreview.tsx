import { BrandMark } from '../../shared/ui/BrandMark'
import { createTranslator } from '../../shared/i18n/i18n'

const panelCardClass =
  'rounded-lg border border-[var(--workbench-border)] bg-white shadow-[0_1px_2px_rgba(23,32,29,0.04)]'

/**
 * ログイン画面に表示する作業台プレビューの props です。
 */
type DashboardPreviewProps = {
  /**
   * 表示文言を取得する translator です。
   */
  t: ReturnType<typeof createTranslator>
}

/**
 * 実プロダクトの作業台を示すログイン画面用プレビューです。
 */
export function DashboardPreview({ t }: DashboardPreviewProps) {
  const progressRows = [
    { label: t('preview.project.website'), value: '74%', width: '74%' },
    { label: t('preview.project.mobile'), value: '48%', width: '48%' },
    { label: t('preview.project.release'), value: '31%', width: '31%' },
  ]

  return (
    <div
      className="grid min-h-[520px] w-[min(100%,820px)] grid-cols-[168px_minmax(0,1fr)] overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white shadow-[0_16px_34px_rgba(23,32,29,0.08)] max-[720px]:min-h-0 max-[720px]:grid-cols-1"
      aria-label={t('preview.aria')}
    >
      <aside className="border-r border-white/10 bg-[var(--workbench-sidebar)] px-4 py-6 max-[720px]:hidden">
        <div className="mb-[26px] inline-flex items-center gap-2 text-base font-semibold text-white">
          <BrandMark small />
          <span>mukuroji</span>
        </div>
        <span className="mb-2 block rounded-lg bg-teal-500/20 px-3 py-2.5 text-app-meta font-semibold text-white">
          {t('preview.nav.dashboard')}
        </span>
        <span className="mb-2 block rounded-lg px-3 py-2.5 text-app-meta font-medium text-[var(--workbench-sidebar-muted)]">
          {t('preview.nav.projects')}
        </span>
        <span className="mb-2 block rounded-lg px-3 py-2.5 text-app-meta font-medium text-[var(--workbench-sidebar-muted)]">
          {t('preview.nav.tasks')}
        </span>
        <span className="mb-2 block rounded-lg px-3 py-2.5 text-app-meta font-medium text-[var(--workbench-sidebar-muted)]">
          {t('preview.nav.reports')}
        </span>
      </aside>

      <div className="min-w-0 bg-[var(--workbench-canvas)] p-[26px] max-[720px]:p-[18px]">
        <div className="flex items-center justify-between gap-4 text-app-preview font-semibold text-[var(--workbench-text)]">
          <span>{t('preview.heading')}</span>
          <span className="text-app-meta font-medium text-[var(--workbench-muted)]">
            {t('preview.period')}
          </span>
        </div>

        <div
          className="mt-6 grid grid-cols-3 gap-3 max-[720px]:grid-cols-1"
          aria-hidden="true"
        >
          <PreviewStat label={t('preview.stat.projects')} value="12" />
          <PreviewStat label={t('preview.stat.completed')} value="86" />
          <PreviewStat label={t('preview.stat.blocked')} value="3" />
        </div>

        <section className={`${panelCardClass} mt-4 p-5`}>
          <h2 className="m-0 text-base font-semibold text-[var(--workbench-text)]">
            {t('preview.progress')}
          </h2>
          {progressRows.map((row) => (
            <div className="mt-[18px]" key={row.label}>
              <div className="flex justify-between gap-3">
                <span className="text-xs font-medium text-[var(--workbench-muted)]">
                  {row.label}
                </span>
                <strong className="text-xs text-[var(--workbench-text)]">{row.value}</strong>
              </div>
              <span className="mt-2 block h-[7px] overflow-hidden rounded-full bg-[var(--workbench-border)]">
                <span
                  className="block h-full rounded-[inherit] bg-[var(--workbench-primary)]"
                  style={{ width: row.width }}
                ></span>
              </span>
            </div>
          ))}
        </section>

        <section
          className={`${panelCardClass} mt-4 flex items-center gap-[18px] p-5 max-[720px]:items-start`}
        >
          <div
            className="h-[82px] w-[82px] flex-none rounded-full bg-[conic-gradient(var(--workbench-primary)_0_56%,var(--workbench-success)_56%_86%,var(--workbench-warning)_86%_100%)] [-webkit-mask:radial-gradient(circle,transparent_0_48%,#000_50%)] [mask:radial-gradient(circle,transparent_0_48%,#000_50%)] max-[720px]:h-[62px] max-[720px]:w-[62px]"
            aria-hidden="true"
          ></div>
          <div>
            <h2 className="m-0 text-base font-semibold text-[var(--workbench-text)]">
              {t('preview.health')}
            </h2>
            <p className="mt-2 text-xs font-medium leading-normal text-[var(--workbench-muted)]">
              {t('preview.healthText')}
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${panelCardClass} p-[18px]`}>
      <span className="text-xs font-medium text-[var(--workbench-muted)]">{label}</span>
      <strong className="mt-2 block text-app-preview-stat text-[var(--workbench-text)]">
        {value}
      </strong>
    </div>
  )
}
