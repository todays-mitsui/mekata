const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTCエポックミリ秒を、JSTの暦日を表す通し日数に変換する。 */
export function jstDayNumber(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
}

export function formatMonthDay(dayNumber: number): string {
  const d = new Date(dayNumber * DAY_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * JSTの今日を終端とする直近 `months` 暦月の範囲 [startMs, endMs)。
 * 開始は `months` か月前の同日0時。その日が存在しなければ月末に丸める（8/31 → 2月末）。
 */
export function recentMonthsWindow(
  nowMs: number,
  months = 6,
): { startMs: number; endMs: number } {
  const today = jstDayNumber(nowMs);
  const d = new Date(today * DAY_MS);
  const year = d.getUTCFullYear();
  const startMonth = d.getUTCMonth() - months;
  const lastDayOfStartMonth = new Date(Date.UTC(year, startMonth + 1, 0)).getUTCDate();
  const startDay = Math.min(d.getUTCDate(), lastDayOfStartMonth);
  return {
    startMs: Date.UTC(year, startMonth, startDay) - JST_OFFSET_MS,
    endMs: (today + 1) * DAY_MS - JST_OFFSET_MS,
  };
}
