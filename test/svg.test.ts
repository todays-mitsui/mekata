import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { handleWeightSvg } from "../src/index";
import { jstDayNumber, recentMonthsWindow } from "../src/jst";
import { axisTicks, movingAverages, renderWeightSvg } from "../src/svg";
import { upsertSamples } from "../src/sync";

const jst = (iso: string) => Date.parse(`${iso}+09:00`);
const row = (iso: string, kg: number) => ({ measuredAtMs: jst(iso), kg });

type XY = [number, number];
const polylines = (svg: string, className: string): XY[][] =>
  [...svg.matchAll(/<polyline points="([^"]+)" class="([^"]+)"/g)]
    .filter((m) => m[2] === className)
    .map((m) => m[1]!.split(" ").map((p) => p.split(",").map(Number) as XY));
/** 移動平均の濃い線。測定が続いている区間ごとの座標列。 */
const lines = (svg: string) => polylines(svg, "line");
/** 測定が7日以上空いた区間をつなぐ薄い線。 */
const bridges = (svg: string) => polylines(svg, "bridge");
/** 実測点。薄い点に続けて、強調した最新の点が最後に来る。 */
const dots = (svg: string): XY[] =>
  [...svg.matchAll(/<circle cx="([^"]+)" cy="([^"]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);

describe("recentMonthsWindow", () => {
  it("6か月前の同日0時から、今日の終わりまで（JST）", () => {
    expect(recentMonthsWindow(jst("2026-11-10T12:00:00"))).toEqual({
      startMs: jst("2026-05-10T00:00:00"),
      endMs: jst("2026-11-11T00:00:00"),
    });
  });

  it("月末は開始月の末日に丸める", () => {
    expect(recentMonthsWindow(jst("2026-08-31T12:00:00")).startMs).toBe(jst("2026-02-28T00:00:00"));
    expect(recentMonthsWindow(jst("2028-08-31T12:00:00")).startMs).toBe(jst("2028-02-29T00:00:00"));
  });

  it("年をまたぐ", () => {
    expect(recentMonthsWindow(jst("2027-03-15T12:00:00")).startMs).toBe(jst("2026-09-15T00:00:00"));
  });

  it("JSTの午前0時で日付が切り替わる", () => {
    expect(recentMonthsWindow(jst("2026-11-10T23:59:59")).endMs).toBe(jst("2026-11-11T00:00:00"));
    expect(recentMonthsWindow(jst("2026-11-11T00:00:00")).endMs).toBe(jst("2026-11-12T00:00:00"));
    expect(recentMonthsWindow(jst("2026-11-11T00:00:00")).startMs).toBe(jst("2026-05-11T00:00:00"));
  });
});

describe("movingAverages", () => {
  it("当日と過去6暦日のうち、記録がある日だけを平均する", () => {
    // 1日（最後の測定が91）と3日（89）→ 3日の平均は90。欠測の2日は分母に入れない
    expect(movingAverages([{ day: 1, kg: 91 }, { day: 3, kg: 89 }])).toEqual([91, 90]);
  });

  it("7日前の記録は窓に入れない", () => {
    expect(movingAverages([{ day: 1, kg: 90 }, { day: 7, kg: 92 }, { day: 8, kg: 94 }])).toEqual([90, 91, 93]);
  });

  it("窓内の測定日が1日だけなら、その日の値を平均とする", () => {
    expect(movingAverages([{ day: 1, kg: 90 }, { day: 8, kg: 92 }])).toEqual([90, 92]);
  });
});

describe("axisTicks", () => {
  it.each([
    [90, 92, [92, 91, 90]],
    [89, 93, [93, 92, 91, 90, 89]],
    [89, 94, [94, 92, 90, 88]],
    [86, 93, [94, 92, 90, 88, 86]],
    [84, 93, [95, 90, 85, 80]],
    [78, 92, [95, 90, 85, 80, 75]],
    [70, 93, [100, 90, 80, 70]],
  ])("%d〜%d kg の目盛りは %j", (minKg, maxKg, expected) => {
    expect(axisTicks(minKg, maxKg)).toEqual(expected);
  });
});

describe("renderWeightSvg", () => {
  it("目盛りごとに罫線とラベルを等間隔に描く", () => {
    // 88.3〜92.0 → 目盛りは 88・90・92・94
    const svg = renderWeightSvg([row("2026-11-09T07:00:00", 92.0), row("2026-11-10T07:00:00", 88.3)]);
    const ys = [...svg.matchAll(/<line [^>]*y1="([^"]+)"/g)].map((m) => Number(m[1]));
    expect(ys).toEqual([42, 60, 78, 96]);
    for (const label of [94, 92, 90, 88]) expect(svg).toContain(`>${label}<`);
  });

  it("ライトとダークの配色を持ち、要素には色を直接書かない", () => {
    const svg = renderWeightSvg([row("2026-11-09T07:00:00", 92), row("2026-11-10T07:00:00", 91)]);
    expect(svg).toContain("@media (prefers-color-scheme:dark)");
    const body = svg.slice(svg.indexOf("</style>"));
    expect(body).not.toMatch(/(fill|stroke)="#/);
    expect(body).toContain('<rect class="bg"');
  });

  it("0件なら案内文だけを出す", () => {
    const svg = renderWeightSvg([]);
    expect(svg).toContain("この期間の記録はありません");
    expect(lines(svg)).toEqual([]);
    expect(dots(svg)).toEqual([]);
  });

  it("表示開始より前の記録しかなければ0件として扱う", () => {
    const svg = renderWeightSvg([row("2026-05-09T07:00:00", 92)], jstDayNumber(jst("2026-05-10T00:00:00")));
    expect(svg).toContain("この期間の記録はありません");
  });

  it("1件なら点だけを描く", () => {
    const svg = renderWeightSvg([row("2026-11-10T07:15:00", 91.8)]);
    expect(lines(svg)).toEqual([]);
    expect(bridges(svg)).toEqual([]);
    expect(dots(svg)).toHaveLength(1);
    expect(dots(svg).flat().every(Number.isFinite)).toBe(true);
    expect(svg).toContain(">91.8</tspan>");
    expect(svg).toContain("11/10 測定");
  });

  it("体重が一定でも有効な座標になる", () => {
    const svg = renderWeightSvg([
      row("2026-11-08T07:00:00", 90),
      row("2026-11-09T07:00:00", 90),
      row("2026-11-10T07:00:00", 90),
    ]);
    expect(dots(svg)).toHaveLength(3);
    expect(lines(svg)).toHaveLength(1);
    expect([...dots(svg), ...lines(svg).flat()].flat().every(Number.isFinite)).toBe(true);
    expect(svg).not.toContain("NaN");
  });

  it("同じ日は最後の測定だけを使い、見出しは最新の実測値にする", () => {
    const svg = renderWeightSvg([
      row("2026-11-09T07:00:00", 92.0),
      row("2026-11-10T07:00:00", 91.9),
      row("2026-11-10T21:00:00", 91.4),
    ]);
    expect(dots(svg)).toHaveLength(2);
    expect(svg).toContain(">91.4</tspan>");
  });

  it("JSTの0時をまたぐ測定は別の日として扱う", () => {
    const svg = renderWeightSvg([row("2026-11-09T23:59:00", 92.0), row("2026-11-10T00:00:00", 91.9)]);
    expect(dots(svg)).toHaveLength(2);
    expect(svg).toContain(">11/9<");
    expect(svg).toContain("11/10 測定");
  });

  it("欠測日があっても横軸は経過日数に比例する", () => {
    const points = dots(
      renderWeightSvg([
        row("2026-10-31T07:00:00", 92),
        row("2026-11-01T07:00:00", 91.5), // 月末をまたいで1日後
        row("2026-11-10T07:00:00", 91), // さらに9日後
      ]),
    );
    const [x0, x1, x2] = points.map((p) => p[0]) as [number, number, number];
    expect((x2 - x1) / (x1 - x0)).toBeCloseTo(9, 1);
  });

  it("点は目盛りの範囲に収まり、軽いほど下に描かれる", () => {
    const svg = renderWeightSvg([row("2026-11-09T07:00:00", 92.0), row("2026-11-10T07:00:00", 88.3)]);
    const [[, yHeavy], [, yLight]] = dots(svg) as [XY, XY];
    expect(yHeavy).toBeLessThan(yLight);
    expect(yHeavy).toBeGreaterThanOrEqual(42);
    expect(yLight).toBeLessThanOrEqual(96);
    expect(svg).toContain(">94<");
    expect(svg).toContain(">88<");
  });

  it("平均線は実測点の平均の高さを通る", () => {
    // 平均は 11/1 → 92、11/2 → 91、11/3 → 90。縦軸は 86〜94 になる
    const svg = renderWeightSvg([
      row("2026-11-01T07:00:00", 92),
      row("2026-11-02T07:00:00", 90),
      row("2026-11-03T07:00:00", 88),
    ]);
    const y = (kg: number) => 96 - ((kg - 86) / 8) * 54;
    expect(lines(svg)).toHaveLength(1);
    expect(lines(svg)[0]!.map((p) => p[1])).toEqual([y(92), y(91), y(90)]);
    expect(dots(svg).map((p) => p[1])).toEqual([y(92), y(90), y(88)]);
  });

  it("測定が続く区間は濃い線、翌月の単独測定までは薄い線でつなぐ", () => {
    const svg = renderWeightSvg([
      row("2026-10-01T07:00:00", 91.5),
      row("2026-10-01T21:00:00", 91),
      row("2026-10-03T07:00:00", 89),
      row("2026-10-04T07:00:00", 90),
      row("2026-11-10T07:00:00", 88),
    ]);
    const all = dots(svg);
    expect(all).toHaveLength(4);
    // 濃い線は10/1〜10/4だけ
    expect(lines(svg).map((line) => line.map((p) => p[0]))).toEqual([all.slice(0, 3).map((p) => p[0])]);
    // 薄い線が10/4の平均から最新の点（11/10）までをつなぐ
    expect(bridges(svg)).toEqual([[lines(svg)[0]!.at(-1), all.at(-1)]]);
  });

  it("7日以上の空白ごとに濃い線を区切り、すべての区間を薄い線でつなぐ", () => {
    const svg = renderWeightSvg([
      row("2026-10-01T07:00:00", 92),
      row("2026-10-02T07:00:00", 92),
      row("2026-10-03T07:00:00", 92),
      row("2026-10-12T07:00:00", 91),
      row("2026-10-13T07:00:00", 91),
      row("2026-10-14T07:00:00", 91),
      row("2026-10-25T07:00:00", 90),
      row("2026-10-26T07:00:00", 90),
      row("2026-11-10T07:00:00", 89),
    ]);
    expect(dots(svg)).toHaveLength(9);
    expect(lines(svg).map((line) => line.length)).toEqual([3, 3, 2]);
    expect(bridges(svg)).toHaveLength(3);
    // 線全体が左端から最新の点まで途切れない
    const ordered = [...lines(svg), ...bridges(svg)].sort((a, b) => a[0]![0] - b[0]![0]);
    expect(ordered[0]![0]![0]).toBe(dots(svg)[0]![0]);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]![0]).toEqual(ordered[i - 1]!.at(-1));
    expect(ordered.at(-1)!.at(-1)).toEqual(dots(svg).at(-1));
  });

  it("6日以内の欠測では線を区切らない", () => {
    const svg = renderWeightSvg([row("2026-11-01T07:00:00", 92), row("2026-11-07T07:00:00", 91)]);
    expect(lines(svg)).toHaveLength(1);
    expect(bridges(svg)).toEqual([]);
  });

  it("表示開始前の記録は描かず、左端の平均の計算にだけ使う", () => {
    const start = jstDayNumber(jst("2026-05-10T00:00:00"));
    const svg = renderWeightSvg(
      [row("2026-05-09T07:00:00", 99), row("2026-05-10T07:00:00", 92), row("2026-05-11T07:00:00", 91)],
      start,
    );
    expect(dots(svg)).toHaveLength(2);
    expect(svg).toContain(">5/10<");
    expect(lines(svg)[0]!.map((p) => p[0])).toEqual(dots(svg).map((p) => p[0]));
    // 平均 (99+92)/2 = 95.5 が縦軸の範囲に入る
    expect(svg).toContain(">96<");
  });
});

describe("GET /weight.svg", () => {
  it("SVGとして返す", async () => {
    const res = await worker.fetch(new Request("https://example.com/weight.svg"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(await res.text()).toMatch(/^<svg [^>]*viewBox="0 0 240 120"/);
  });

  it("直近6暦月より前の記録と未来の記録は描かない", async () => {
    await upsertSamples(env.DB, [
      row("2026-05-03T23:59:00", 60), // 平均用の6日分よりも前
      row("2026-05-09T23:59:00", 99), // 期間の直前（平均の計算には使う）
      row("2026-05-10T00:00:00", 92), // 期間の最初
      row("2026-05-11T07:00:00", 92),
      row("2026-11-10T07:00:00", 91),
      row("2026-11-11T00:00:00", 50), // 明日
    ]);
    const svg = await (await handleWeightSvg(env, jst("2026-11-10T12:00:00"))).text();
    expect(dots(svg)).toHaveLength(3);
    expect(svg).toContain(">91.0</tspan>");
    expect(svg).toContain(">5/10<");
    // 5/10 の平均は (99+92)/2 = 95.5。5/3 の60が混ざれば下の目盛りが変わる
    expect(lines(svg)).toHaveLength(1);
    expect(bridges(svg)).toHaveLength(1);
    expect(svg).toContain(">96<");
    expect(svg).toContain(">90<");
  });

  it("未知のパスは404", async () => {
    expect((await worker.fetch(new Request("https://example.com/"), env)).status).toBe(404);
  });
});
