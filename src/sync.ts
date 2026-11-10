export interface Sample {
  measuredAtMs: number;
  kg: number;
}

const MAX_SAMPLES = 10_000;
// D1は1文あたりのバインド変数が100個まで。1行2個なので50行ずつにまとめる。
const ROWS_PER_STATEMENT = 50;

const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** タイムゾーン付きISO 8601をUTCエポックミリ秒にする。不正なら null。 */
export function parseMeasuredAt(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO_WITH_ZONE.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number, number, number, number, number,
  ];
  const second = Number(m[6] ?? 0);
  const milli = Number((m[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const offsetHour = Number(m[9] ?? 0);
  const offsetMinute = Number(m[10] ?? 0);
  if (year < 2000 || year > 2100) return null;
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;

  const local = Date.UTC(year, month - 1, day, hour, minute, second, milli);
  // Date.UTC は 2/30 のような日付を繰り上げてしまうので、往復して確かめる
  const check = new Date(local);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;

  const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000 * (m[8] === "-" ? -1 : 1);
  return local - offsetMs;
}

/**
 * リクエスト本文を検証する。1件でも不正なら全体を null にする。
 * 同じ測定時刻が重複していれば後のものを採る。
 */
export function parseSamples(body: unknown): Sample[] | null {
  if (typeof body !== "object" || body === null) return null;
  const samples = (body as { samples?: unknown }).samples;
  if (!Array.isArray(samples) || samples.length > MAX_SAMPLES) return null;

  const byTime = new Map<number, number>();
  for (const item of samples) {
    if (typeof item !== "object" || item === null) return null;
    const { measuredAt, kg } = item as { measuredAt?: unknown; kg?: unknown };
    const measuredAtMs = parseMeasuredAt(measuredAt);
    if (measuredAtMs === null) return null;
    if (typeof kg !== "number" || !Number.isFinite(kg) || kg <= 0) return null;
    byTime.set(measuredAtMs, kg);
  }
  return [...byTime].map(([measuredAtMs, kg]) => ({ measuredAtMs, kg }));
}

/** 全行を一つのbatch（＝一つのトランザクション）でUPSERTし、書き込んだ行数を返す。 */
export async function upsertSamples(db: D1Database, samples: Sample[]): Promise<number> {
  if (samples.length === 0) return 0;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < samples.length; i += ROWS_PER_STATEMENT) {
    const chunk = samples.slice(i, i + ROWS_PER_STATEMENT);
    statements.push(
      db
        .prepare(
          `INSERT INTO weights (measured_at_ms, kg) VALUES ${chunk.map(() => "(?, ?)").join(", ")}
           ON CONFLICT(measured_at_ms) DO UPDATE SET kg = excluded.kg
           WHERE weights.kg <> excluded.kg`,
        )
        .bind(...chunk.flatMap((s) => [s.measuredAtMs, s.kg])),
    );
  }
  const results = await db.batch(statements);
  return results.reduce((sum, r) => sum + r.meta.changes, 0);
}
