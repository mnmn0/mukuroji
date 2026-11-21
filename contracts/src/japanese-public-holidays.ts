/** One Japanese national holiday or other statutory day off. */
export type JapanesePublicHoliday = {
  /** Local `YYYY-MM-DD` date in Japan. */
  date: string
  /** Japanese name of the day, such as `元日`; substitute holidays and bridge days are `休日`. */
  name: string
}

/**
 * Japanese national holidays bundled with the application, keyed by calendar year.
 *
 * Every day the Act on National Holidays (国民の祝日に関する法律) makes a day off is listed: the
 * national holidays of Article 2, substitute holidays (Article 3, paragraph 2), and days between two
 * holidays (Article 3, paragraph 3). The dates are facts derived from the Act; the vernal and
 * autumnal equinox days follow the 暦要項 the National Astronomical Observatory of Japan publishes
 * each February for the next year. No third-party holiday dataset is copied.
 *
 * Add the next year once its 暦要項 is published, as `docs/workspace-calendar-holidays.md` describes.
 */
export const JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR: Readonly<Record<number, readonly JapanesePublicHoliday[]>> = {
  2024: [
    { date: '2024-01-01', name: '元日' },
    { date: '2024-01-08', name: '成人の日' },
    { date: '2024-02-11', name: '建国記念の日' },
    { date: '2024-02-12', name: '休日' },
    { date: '2024-02-23', name: '天皇誕生日' },
    { date: '2024-03-20', name: '春分の日' },
    { date: '2024-04-29', name: '昭和の日' },
    { date: '2024-05-03', name: '憲法記念日' },
    { date: '2024-05-04', name: 'みどりの日' },
    { date: '2024-05-05', name: 'こどもの日' },
    { date: '2024-05-06', name: '休日' },
    { date: '2024-07-15', name: '海の日' },
    { date: '2024-08-11', name: '山の日' },
    { date: '2024-08-12', name: '休日' },
    { date: '2024-09-16', name: '敬老の日' },
    { date: '2024-09-22', name: '秋分の日' },
    { date: '2024-09-23', name: '休日' },
    { date: '2024-10-14', name: 'スポーツの日' },
    { date: '2024-11-03', name: '文化の日' },
    { date: '2024-11-04', name: '休日' },
    { date: '2024-11-23', name: '勤労感謝の日' },
  ],
  2025: [
    { date: '2025-01-01', name: '元日' },
    { date: '2025-01-13', name: '成人の日' },
    { date: '2025-02-11', name: '建国記念の日' },
    { date: '2025-02-23', name: '天皇誕生日' },
    { date: '2025-02-24', name: '休日' },
    { date: '2025-03-20', name: '春分の日' },
    { date: '2025-04-29', name: '昭和の日' },
    { date: '2025-05-03', name: '憲法記念日' },
    { date: '2025-05-04', name: 'みどりの日' },
    { date: '2025-05-05', name: 'こどもの日' },
    { date: '2025-05-06', name: '休日' },
    { date: '2025-07-21', name: '海の日' },
    { date: '2025-08-11', name: '山の日' },
    { date: '2025-09-15', name: '敬老の日' },
    { date: '2025-09-23', name: '秋分の日' },
    { date: '2025-10-13', name: 'スポーツの日' },
    { date: '2025-11-03', name: '文化の日' },
    { date: '2025-11-23', name: '勤労感謝の日' },
    { date: '2025-11-24', name: '休日' },
  ],
  2026: [
    { date: '2026-01-01', name: '元日' },
    { date: '2026-01-12', name: '成人の日' },
    { date: '2026-02-11', name: '建国記念の日' },
    { date: '2026-02-23', name: '天皇誕生日' },
    { date: '2026-03-20', name: '春分の日' },
    { date: '2026-04-29', name: '昭和の日' },
    { date: '2026-05-03', name: '憲法記念日' },
    { date: '2026-05-04', name: 'みどりの日' },
    { date: '2026-05-05', name: 'こどもの日' },
    { date: '2026-05-06', name: '休日' },
    { date: '2026-07-20', name: '海の日' },
    { date: '2026-08-11', name: '山の日' },
    { date: '2026-09-21', name: '敬老の日' },
    { date: '2026-09-22', name: '休日' },
    { date: '2026-09-23', name: '秋分の日' },
    { date: '2026-10-12', name: 'スポーツの日' },
    { date: '2026-11-03', name: '文化の日' },
    { date: '2026-11-23', name: '勤労感謝の日' },
  ],
  2027: [
    { date: '2027-01-01', name: '元日' },
    { date: '2027-01-11', name: '成人の日' },
    { date: '2027-02-11', name: '建国記念の日' },
    { date: '2027-02-23', name: '天皇誕生日' },
    { date: '2027-03-21', name: '春分の日' },
    { date: '2027-03-22', name: '休日' },
    { date: '2027-04-29', name: '昭和の日' },
    { date: '2027-05-03', name: '憲法記念日' },
    { date: '2027-05-04', name: 'みどりの日' },
    { date: '2027-05-05', name: 'こどもの日' },
    { date: '2027-07-19', name: '海の日' },
    { date: '2027-08-11', name: '山の日' },
    { date: '2027-09-20', name: '敬老の日' },
    { date: '2027-09-23', name: '秋分の日' },
    { date: '2027-10-11', name: 'スポーツの日' },
    { date: '2027-11-03', name: '文化の日' },
    { date: '2027-11-23', name: '勤労感謝の日' },
  ],
}

/**
 * Lists every bundled Japanese holiday in date order.
 *
 * @returns A new array of all bundled holidays, oldest first.
 */
export function listJapanesePublicHolidays(): JapanesePublicHoliday[] {
  return Object.keys(JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR)
    .map(Number)
    .sort((first, second) => first - second)
    .flatMap((year) => (JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR[year] ?? []).map((holiday) => ({ ...holiday })))
}

/**
 * Returns the calendar years the bundled Japanese holidays cover.
 *
 * @returns The first and last bundled years, inclusive.
 */
export function japanesePublicHolidayYears(): { first: number, last: number } {
  const years = Object.keys(JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR).map(Number)
  return { first: Math.min(...years), last: Math.max(...years) }
}
