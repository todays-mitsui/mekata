import { jstDayNumber, recentMonthsWindow } from "./jst";
import { renderWeightSvg, type WeightRow } from "./svg";
import { parseSamples, upsertSamples } from "./sync";

const MAX_BODY_CHARS = 1_000_000;
// 左端の7日移動平均に使う、表示開始前の日数
const LOOKBACK_MS = 6 * 24 * 60 * 60 * 1000;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

async function isAuthorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  // 長さの違いを漏らさないよう、ハッシュ同士を定数時間で比べる
  const encoder = new TextEncoder();
  const [given, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
  ]);
  return crypto.subtle.timingSafeEqual(given, expected);
}

async function handleSync(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env.SYNC_TOKEN))) {
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return json({ error: "payload too large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const samples = parseSamples(body);
  if (!samples) return json({ error: "invalid samples" }, 400);

  const saved = await upsertSamples(env.DB, samples);
  return json({ received: samples.length, saved });
}

export async function handleWeightSvg(env: Env, nowMs: number): Promise<Response> {
  const { startMs, endMs } = recentMonthsWindow(nowMs);
  const { results } = await env.DB.prepare(
    `SELECT measured_at_ms AS measuredAtMs, kg FROM weights
     WHERE measured_at_ms >= ? AND measured_at_ms < ? ORDER BY measured_at_ms`,
  )
    .bind(startMs - LOOKBACK_MS, endMs)
    .all<WeightRow>();

  return new Response(renderWeightSvg(results, jstDayNumber(startMs)), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api/weights") {
        if (request.method !== "PUT") return json({ error: "method not allowed" }, 405, { Allow: "PUT" });
        return await handleSync(request, env);
      }
      if (pathname === "/weight.svg") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json({ error: "method not allowed" }, 405, { Allow: "GET, HEAD" });
        }
        return await handleWeightSvg(env, Date.now());
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      // 実測値や送信本文を残さないよう、エラーの種類だけを記録する
      console.error("request failed:", error instanceof Error ? error.name : "unknown");
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
