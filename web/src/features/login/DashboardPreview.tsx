import { BrandMark } from '../../components/BrandMark'
import { createTranslator } from '../../i18n'

const panelCardClass =
  'rounded-lg border border-[rgba(222,230,240,0.9)] bg-white/90 shadow-[0_14px_30px_rgba(20,46,78,0.07)]'

type DashboardPreviewProps = {
  t: ReturnType<typeof createTranslator>
}

export function DashboardPreview({ t }: DashboardPreviewProps) {
  const progressRows = [
    { label: t('preview.project.website'), value: '74%', width: '74%' },
    { label: t('preview.project.mobile'), value: '48%', width: '48%' },
    { label: t('preview.project.release'), value: '31%', width: '31%' },
  ]

  return (
    <div
      className="grid min-h-[520px] w-[min(100%,820px)] grid-cols-[168px_minmax(0,1fr)] overflow-hidden rounded-lg border border-[rgba(202,216,232,0.82)] bg-white/85 shadow-[0_30px_70px_rgba(16,59,110,0.15)] backdrop-blur-[18px] max-[720px]:min-h-0 max-[720px]:grid-cols-1"
      aria-label={t('preview.aria')}
    >
      <aside className="border-r border-[rgba(214,225,238,0.82)] bg-[rgba(250,253,255,0.7)] px-4 py-6 max-[720px]:hidden">
        <div className="mb-[26px] inline-flex items-center gap-2 text-[15px] font-extrabold text-[var(--ink)]">
          <BrandMark small />
          <span>mukuroji</span>
        </div>
        <span className="mb-2 block rounded-lg bg-[#e8f2ff] px-3 py-2.5 text-[13px] font-bold text-[#0059db]">
          {t('preview.nav.dashboard')}
        </span>
        <span className="mb-2 block rounded-lg px-3 py-2.5 text-[13px] font-bold text-[#617086]">
          {t('preview.nav.projects')}
        </span>
        <span className="mb-2 block rounded-lg px-3 py-2.5 text-[13px] font-bold text-[#617086]">
          {t('preview.nav.tasks')}
        </span>
        <span className="mb-2 block rounded-lg px-3 py-2.5 text-[13px] font-bold text-[#617086]">
          {t('preview.nav.reports')}
        </span>
      </aside>

      <div className="min-w-0 p-[26px] max-[720px]:p-[18px]">
        <div className="flex items-center justify-between gap-4 text-[17px] font-extrabold text-[var(--ink)]">
          <span>{t('preview.heading')}</span>
          <span className="text-[13px] font-bold text-[#6a778a]">
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
          <h2 className="m-0 text-base font-extrabold text-[var(--ink)]">
            {t('preview.progress')}
          </h2>
          {progressRows.map((row) => (
            <div className="mt-[18px]" key={row.label}>
              <div className="flex justify-between gap-3">
                <span className="text-xs font-bold text-[#6b7788]">
                  {row.label}
                </span>
                <strong className="text-xs text-[#16233a]">{row.value}</strong>
              </div>
              <span className="mt-2 block h-[7px] overflow-hidden rounded-full bg-[#e7edf5]">
                <span
                  className="block h-full rounded-[inherit] bg-linear-to-r from-[#0064ee] to-[#2ed6a7]"
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
            className="h-[82px] w-[82px] flex-none rounded-full bg-[conic-gradient(#26bd86_0_56%,#0064ee_56%_86%,#f2b84b_86%_100%)] [-webkit-mask:radial-gradient(circle,transparent_0_48%,#000_50%)] [mask:radial-gradient(circle,transparent_0_48%,#000_50%)] max-[720px]:h-[62px] max-[720px]:w-[62px]"
            aria-hidden="true"
          ></div>
          <div>
            <h2 className="m-0 text-base font-extrabold text-[var(--ink)]">
              {t('preview.health')}
            </h2>
            <p className="mt-2 text-xs font-bold leading-normal text-[#6b7788]">
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
      <span className="text-xs font-bold text-[#6b7788]">{label}</span>
      <strong className="mt-2 block text-[26px] leading-none text-[var(--ink)]">
        {value}
      </strong>
    </div>
  )
}
