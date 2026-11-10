import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { parseMeasuredAt, parseSamples, upsertSamples } from "../src/sync";

const put = (body: unknown, token: string | null = "test-token") =>
  worker.fetch(
    new Request("https://example.com/api/weights", {
      method: "PUT",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );

const allRows = async () =>
  (await env.DB.prepare("SELECT measured_at_ms AS ms, kg FROM weights ORDER BY ms").all<{ ms: number; kg: number }>())
    .results;

const A = { measuredAt: "2026-11-09T07:10:00+09:00", kg: 92.0 };
const B = { measuredAt: "2026-11-10T07:15:00+09:00", kg: 91.8 };

describe("parseMeasuredAt", () => {
  it("タイムゾーン付きの日時をUTCエポックミリ秒にする", () => {
    expect(parseMeasuredAt("2026-11-10T07:15:00+09:00")).toBe(Date.UTC(2026, 10, 9, 22, 15));
    expect(parseMeasuredAt("2026-11-09T22:15:00Z")).toBe(Date.UTC(2026, 10, 9, 22, 15));
    expect(parseMeasuredAt("2026-11-09T17:15:00.500-05:00")).toBe(Date.UTC(2026, 10, 9, 22, 15, 0, 500));
  });

  it.each([
    "2026-11-10T07:15:00", // タイムゾーンなし
    "2026-11-10",
    "2026-02-30T07:15:00+09:00", // 存在しない日
    "2026-13-01T07:15:00+09:00",
    "2026-11-10T24:00:00+09:00",
    "2026-11-10 07:15:00+09:00",
    "",
  ])("%s を拒否する", (value) => {
    expect(parseMeasuredAt(value)).toBeNull();
  });
});

describe("parseSamples", () => {
  it.each([
    null,
    [],
    {},
    { samples: "x" },
    { samples: [{ measuredAt: A.measuredAt }] },
    { samples: [{ measuredAt: A.measuredAt, kg: 0 }] },
    { samples: [{ measuredAt: A.measuredAt, kg: -1 }] },
    { samples: [{ measuredAt: A.measuredAt, kg: "91.8" }] },
    { samples: [{ measuredAt: A.measuredAt, kg: Infinity }] },
    { samples: [A, { measuredAt: "2026-11-10T07:15:00", kg: 91 }] },
  ])("不正な本文 %j を拒否する", (body) => {
    expect(parseSamples(body)).toBeNull();
  });

  it("同じ測定時刻は後のものを採る", () => {
    expect(parseSamples({ samples: [A, { ...A, kg: 91.5 }] })).toEqual([
      { measuredAtMs: parseMeasuredAt(A.measuredAt), kg: 91.5 },
    ]);
  });
});

describe("PUT /api/weights", () => {
  it("同期し、再送しても行が増えない", async () => {
    const first = await put({ samples: [A, B] });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: 2, saved: 2 });

    const second = await put({ samples: [A, B] });
    expect(await second.json()).toEqual({ received: 2, saved: 0 });
    expect(await allRows()).toHaveLength(2);
  });

  it("同じ測定日時の体重を訂正し、送られなかった行は保持する", async () => {
    await put({ samples: [A, B] });
    const res = await put({ samples: [{ ...B, kg: 91.6 }] });
    expect(await res.json()).toEqual({ received: 1, saved: 1 });
    expect((await allRows()).map((r) => r.kg)).toEqual([92.0, 91.6]);
  });

  it("タイムゾーン表記が違っても同じ時刻なら同じ記録とみなす", async () => {
    await put({ samples: [B] });
    await put({ samples: [{ measuredAt: "2026-11-09T22:15:00Z", kg: 91.8 }] });
    expect(await allRows()).toHaveLength(1);
  });

  it("空配列は更新0件", async () => {
    await put({ samples: [A] });
    const res = await put({ samples: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 0, saved: 0 });
    expect(await allRows()).toHaveLength(1);
  });

  it.each([null, "wrong-token"])("トークン %s は401で、既存行は変わらない", async (token) => {
    await put({ samples: [A] });
    const res = await put({ samples: [{ ...A, kg: 80 }] }, token);
    expect(res.status).toBe(401);
    expect((await allRows()).map((r) => r.kg)).toEqual([92.0]);
  });

  it("SYNC_TOKEN が未設定なら常に401", async () => {
    const res = await worker.fetch(
      new Request("https://example.com/api/weights", {
        method: "PUT",
        headers: { Authorization: "Bearer " },
        body: "{}",
      }),
      { ...env, SYNC_TOKEN: "" },
    );
    expect(res.status).toBe(401);
  });

  it("1件でも不正なら400で、既存行は変わらない", async () => {
    await put({ samples: [A] });
    const res = await put({ samples: [{ ...A, kg: 80 }, { measuredAt: "bad", kg: 90 }] });
    expect(res.status).toBe(400);
    expect((await put("{not json")).status).toBe(400);
    expect((await allRows()).map((r) => r.kg)).toEqual([92.0]);
  });

  it("PUT以外は405", async () => {
    const res = await worker.fetch(new Request("https://example.com/api/weights"), env);
    expect(res.status).toBe(405);
  });
});

describe("upsertSamples", () => {
  it("50行を超えても全件保存する", async () => {
    const samples = Array.from({ length: 120 }, (_, i) => ({ measuredAtMs: 1_800_000_000_000 + i, kg: 90 }));
    expect(await upsertSamples(env.DB, samples)).toBe(120);
    expect(await allRows()).toHaveLength(120);
  });

  it("途中で書き込みに失敗したら、同じbatchの他の行も既存行も変わらない", async () => {
    await upsertSamples(env.DB, [{ measuredAtMs: 1, kg: 92 }]);
    const samples = Array.from({ length: 60 }, (_, i) => ({ measuredAtMs: i + 1, kg: 80 }));
    samples[59]!.kg = -1; // 2文目でCHECK制約に違反させる
    await expect(upsertSamples(env.DB, samples)).rejects.toThrow();
    expect(await allRows()).toEqual([{ ms: 1, kg: 92 }]);
  });
});
