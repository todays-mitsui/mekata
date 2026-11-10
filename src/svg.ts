import { formatMonthDay, jstDayNumber } from "./jst";

export interface WeightRow {
  measuredAtMs: number;
  kg: number;
}

const WIDTH = 240;
const HEIGHT = 120;
const PLOT = { left: 28, right: 232, top: 42, bottom: 96 };

// 色はブログ「無駄と文化」の背景・文字色に合わせ、ライト／ダークを <style> で切り替える。
// <img> で埋め込んだSVGでも prefers-color-scheme は効く。
const STYLE =
  `.bg{fill:#fcfcfc}.ink{fill:#222222}.sub{fill:#52514e}.grid{stroke:#e1e0d9}` +
  `.line{stroke:#2a78d6}.bridge{stroke:#86b6ef}.dot{fill:#86b6ef}.latest{fill:#2a78d6;stroke:#fcfcfc}` +
  `@media (prefers-color-scheme:dark){` +
  `.bg{fill:#282828}.ink{fill:#dddddd}.sub{fill:#a0a0a0}.grid{stroke:#444444}` +
  `.line{stroke:#3987e5}.bridge{stroke:#1c5cab}.dot{fill:#1c5cab}.latest{fill:#3987e5;stroke:#282828}}`;
const AVERAGE_DAYS = 7;
const MAX_TICK_INTERVALS = 4;
const FONT = `system-ui, -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif`;

const coord = (n: number) => String(Math.round(n * 100) / 100);

function wrap(inner: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" ` +
    `aria-label="直近6か月の体重推移" font-family="${FONT}">` +
    `<title>直近6か月の体重推移</title><style>${STYLE}</style>` +
    `<rect class="bg" width="${WIDTH}" height="${HEIGHT}"/>${inner}</svg>`
  );
}

export interface DailyPoint {
  day: number;
  kg: number;
}

/** 同じJST日付の測定は最後の1件だけ残す。 */
function lastPerDay(rows: WeightRow[]): DailyPoint[] {
  const byDay = new Map<number, number>();
  for (const row of rows) byDay.set(jstDayNumber(row.measuredAtMs), row.kg);
  return [...byDay].map(([day, kg]) => ({ day, kg }));
}

/**
 * 各測定日を終点とする7日移動平均。当日と過去6暦日のうち記録がある日だけを平均する。
 * 窓内の記録が当日だけなら、その日の値がそのまま平均になる。`daily` は日付の昇順。
 */
export function movingAverages(daily: DailyPoint[]): number[] {
  return daily.map((point, i) => {
    let sum = 0;
    let count = 0;
    for (let j = i; j >= 0 && daily[j]!.day > point.day - AVERAGE_DAYS; j--) {
      sum += daily[j]!.kg;
      count++;
    }
    return sum / count;
  });
}

/** 平均の点列を、測定が7日以上空いたところで区切る。 */
function splitAtGaps(points: DailyPoint[]): DailyPoint[][] {
  const runs: DailyPoint[][] = [];
  for (const point of points) {
    const run = runs.at(-1);
    if (run && point.day - run.at(-1)!.day < AVERAGE_DAYS) run.push(point);
    else runs.push([point]);
  }
  return runs;
}

/**
 * 縦軸の目盛り（降順）。1・2・5・10 kg…のうち、範囲を刻みの倍数に広げても
 * 間隔が4つ以内に収まる最小の刻みを選ぶ。両端も刻みの倍数になり、等間隔に並ぶ。
 */
export function axisTicks(minKg: number, maxKg: number): number[] {
  for (const step of [1, 2, 5, 10, 20, 50, 100]) {
    const lo = Math.floor(minKg / step) * step;
    const hi = Math.ceil(maxKg / step) * step;
    if ((hi - lo) / step <= MAX_TICK_INTERVALS) {
      const ticks: number[] = [];
      for (let v = hi; v >= lo; v -= step) ticks.push(v);
      return ticks;
    }
  }
  return [Math.ceil(maxKg), Math.floor(minKg)];
}

/**
 * 測定行からSVGを組み立てる。DBには触れない。
 * `startDay`（JSTの通し日数）より前の行は描かず、左端の移動平均の計算にだけ使う。
 */
export function renderWeightSvg(rows: WeightRow[], startDay = -Infinity): string {
  const sorted = [...rows].sort((a, b) => a.measuredAtMs - b.measuredAtMs);
  const latest = sorted.at(-1);
  if (!latest || jstDayNumber(latest.measuredAtMs) < startDay) {
    return wrap(
      `<text x="${WIDTH / 2}" y="${HEIGHT / 2 + 4}" text-anchor="middle" font-size="11" ` +
        `class="sub">この期間の記録はありません</text>`,
    );
  }

  const daily = lastPerDay(sorted);
  const points = daily.filter((p) => p.day >= startDay);
  const averages = movingAverages(daily)
    .map((kg, i) => ({ day: daily[i]!.day, kg }))
    .filter((p) => p.day >= startDay);
  const runs = splitAtGaps(averages);
  const firstDay = points[0]!.day;
  const lastDay = points.at(-1)!.day;
  const kgs = [...points, ...averages].map((p) => p.kg);
  // 縦軸: 実測点と平均線の最小・最大に余白を足し、切りのよい目盛りに広げる
  let minKg = Math.floor(Math.min(...kgs) - 0.1);
  let maxKg = Math.ceil(Math.max(...kgs) + 0.1);
  if (maxKg - minKg < 1) {
    minKg -= 1;
    maxKg += 1;
  }
  const ticks = axisTicks(minKg, maxKg);
  const hi = ticks[0]!;
  const lo = ticks.at(-1)!;

  const plotWidth = PLOT.right - PLOT.left;
  const plotHeight = PLOT.bottom - PLOT.top;
  const span = lastDay - firstDay;
  const x = (day: number) =>
    span === 0 ? PLOT.left + plotWidth / 2 : PLOT.left + ((day - firstDay) / span) * plotWidth;
  const y = (kg: number) => PLOT.bottom - ((kg - lo) / (hi - lo)) * plotHeight;

  const parts: string[] = [];

  // 見出し: 最新の実測値と測定日
  parts.push(
    `<text x="2" y="24" class="ink"><tspan font-size="22" font-weight="700">` +
      `${latest.kg.toFixed(1)}</tspan><tspan font-size="11" dx="3">kg</tspan></text>`,
    `<text x="${WIDTH - 2}" y="24" text-anchor="end" font-size="10" class="sub">` +
      `${formatMonthDay(jstDayNumber(latest.measuredAtMs))} 測定</text>`,
  );

  // 行方向の罫線とkgの目盛り
  for (const value of ticks) {
    const py = coord(y(value));
    parts.push(
      `<line x1="${PLOT.left}" x2="${WIDTH - 2}" y1="${py}" y2="${py}" class="grid" stroke-width="1"/>`,
      `<text x="${PLOT.left - 5}" y="${coord(y(value) + 3.5)}" text-anchor="end" font-size="10" ` +
        `class="sub">${value}</text>`,
    );
  }

  // 日付ラベル（両端）
  if (span === 0) {
    parts.push(
      `<text x="${coord(x(lastDay))}" y="112" text-anchor="middle" font-size="10" ` +
        `class="sub">${formatMonthDay(lastDay)}</text>`,
    );
  } else {
    parts.push(
      `<text x="${PLOT.left}" y="112" font-size="10" class="sub">${formatMonthDay(firstDay)}</text>`,
      `<text x="${PLOT.right}" y="112" text-anchor="end" font-size="10" class="sub">` +
        `${formatMonthDay(lastDay)}</text>`,
    );
  }

  // 実測点（薄い点）。最新の点は後で強調するので除く
  for (const p of points.slice(0, -1)) {
    parts.push(`<circle cx="${coord(x(p.day))}" cy="${coord(y(p.kg))}" r="1.5" class="dot"/>`);
  }

  // 7日移動平均。測定が続いている区間は濃い線、7日以上空いた区間は薄い線でつなぐ
  const polyline = (line: DailyPoint[], className: string) =>
    `<polyline points="${line.map((p) => `${coord(x(p.day))},${coord(y(p.kg))}`).join(" ")}" ` +
    `class="${className}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  for (let i = 1; i < runs.length; i++) {
    parts.push(polyline([runs[i - 1]!.at(-1)!, runs[i]![0]!], "bridge"));
  }
  for (const run of runs) {
    if (run.length >= 2) parts.push(polyline(run, "line"));
  }

  const end = points.at(-1)!;
  parts.push(
    `<circle cx="${coord(x(end.day))}" cy="${coord(y(end.kg))}" r="4" class="latest" ` +
      `stroke-width="2"/>`,
  );

  return wrap(parts.join(""));
}
