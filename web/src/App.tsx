import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  createTranslator,
  getInitialLocale,
  localeOptions,
  setLocalePreference,
  type Locale,
} from './i18n'
import './App.css'

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </span>
  )
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.5h16v11H4z" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 10h11v9h-11z" />
      <path d="M8.5 10V7.8a3.5 3.5 0 0 1 7 0V10" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.8 12s3.4-5.2 9.2-5.2S21.2 12 21.2 12s-3.4 5.2-9.2 5.2S2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 12h16.4" />
      <path d="M12 3.5a13 13 0 0 1 0 17" />
      <path d="M12 3.5a13 13 0 0 0 0 17" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 9 5 5 5-5" />
    </svg>
  )
}

function DashboardPreview({ t }: { t: ReturnType<typeof createTranslator> }) {
  const progressRows = [
    { label: t('preview.project.website'), value: '74%', width: '74%' },
    { label: t('preview.project.mobile'), value: '48%', width: '48%' },
    { label: t('preview.project.release'), value: '31%', width: '31%' },
  ]

  return (
    <div className="preview-window" aria-label={t('preview.aria')}>
      <aside className="preview-sidebar">
        <div className="preview-mini-brand">
          <BrandMark />
          <span>mukuroji</span>
        </div>
        <span className="preview-nav active">{t('preview.nav.dashboard')}</span>
        <span className="preview-nav">{t('preview.nav.projects')}</span>
        <span className="preview-nav">{t('preview.nav.tasks')}</span>
        <span className="preview-nav">{t('preview.nav.reports')}</span>
      </aside>

      <div className="preview-content">
        <div className="preview-heading">
          <span>{t('preview.heading')}</span>
          <span>{t('preview.period')}</span>
        </div>

        <div className="preview-stats" aria-hidden="true">
          <div>
            <span>{t('preview.stat.projects')}</span>
            <strong>12</strong>
          </div>
          <div>
            <span>{t('preview.stat.completed')}</span>
            <strong>86</strong>
          </div>
          <div>
            <span>{t('preview.stat.blocked')}</span>
            <strong>3</strong>
          </div>
        </div>

        <section className="preview-progress">
          <h2>{t('preview.progress')}</h2>
          {progressRows.map((row) => (
            <div className="preview-row" key={row.label}>
              <div>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
              <span className="preview-bar">
                <span style={{ width: row.width }}></span>
              </span>
            </div>
          ))}
        </section>

        <section className="preview-chart">
          <div className="preview-donut" aria-hidden="true"></div>
          <div>
            <h2>{t('preview.health')}</h2>
            <p>{t('preview.healthText')}</p>
          </div>
        </section>
      </div>
    </div>
  )
}

function App() {
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const t = useMemo(() => createTranslator(locale), [locale])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = t('app.title')
  }, [locale, t])

  const handleLocaleChange = (value: string) => {
    const nextLocale = value === 'en' ? 'en' : 'ja'
    setLocale(nextLocale)
    setLocalePreference(nextLocale)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
  }

  return (
    <main className="login-page">
      <section className="auth-panel" aria-labelledby="login-title">
        <div className="language-control">
          <GlobeIcon />
          <select
            aria-label={t('language.aria')}
            value={locale}
            onChange={(event) => handleLocaleChange(event.target.value)}
          >
            {localeOptions.map((option) => (
              <option key={option.locale} value={option.locale}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronIcon />
        </div>

        <div className="auth-card">
          <div className="auth-brand">
            <BrandMark />
            <span>mukuroji</span>
          </div>

          <div className="auth-heading">
            <h1 id="login-title">{t('login.title')}</h1>
            <p>{t('login.subtitle')}</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="field-group">
              <label htmlFor="email">{t('login.email')}</label>
              <span className="text-field">
                <MailIcon />
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder={t('login.emailPlaceholder')}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </span>
            </div>

            <div className="field-group">
              <label htmlFor="password">{t('login.password')}</label>
              <span className="text-field">
                <LockIcon />
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder={t('login.passwordPlaceholder')}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={
                    showPassword
                      ? t('login.hidePassword')
                      : t('login.showPassword')
                  }
                  onClick={() => setShowPassword((current) => !current)}
                >
                  <EyeIcon />
                </button>
              </span>
            </div>

            <label className="remember-row">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>{t('login.remember')}</span>
            </label>

            <button className="submit-button" type="submit">
              {t('login.submit')}
            </button>

            <a className="forgot-link" href="/forgot-password">
              {t('login.forgotPassword')}
            </a>
          </form>
        </div>

        <footer className="auth-footer">
          <nav aria-label={t('footer.aria')}>
            <a href="/privacy">{t('footer.privacy')}</a>
            <a href="/terms">{t('footer.terms')}</a>
            <a href="/support">{t('footer.support')}</a>
          </nav>
          <p>{t('footer.copyright')}</p>
        </footer>
      </section>

      <section className="story-panel" aria-labelledby="story-title">
        <div className="brand-lockup">
          <BrandMark />
          <span>mukuroji</span>
        </div>

        <div className="story-copy">
          <h2 id="story-title">{t('story.title')}</h2>
          <p>{t('story.description')}</p>
        </div>

        <DashboardPreview t={t} />
      </section>
    </main>
  )
}

export default App
