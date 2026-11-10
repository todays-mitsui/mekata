# mekata

直近6か月の体重推移を1枚のSVGで返す Cloudflare Worker。
ブログ「[無駄と文化](https://blog.mudatobunka.org)」のサイドバーに貼るために作った。

![直近6か月の体重推移](https://mekata.todays-mitsui.workers.dev/weight.svg)

## しくみ

1. iPhoneのショートカットがヘルスケアから体重を読み、`PUT /api/weights` に送る。
2. Worker が検証して D1 に保存する。
3. `GET /weight.svg` が D1 を読み、TypeScript で SVG を組み立てて返す。

## エンドポイント

### `PUT /api/weights`

過去6か月分の測定をまとめて送る。同じ測定時刻は同じ記録として扱うので、何度送っても重複しない。

```http
PUT /api/weights
Authorization: Bearer <SYNC_TOKEN>
Content-Type: application/json

{"samples":[{"measuredAt":"2026-11-10T07:15:00+09:00","kg":91.8}]}
```

- `measuredAt` はタイムゾーン付きの ISO 8601、`kg` は正の数値。1件でも不正なら全体を 400 で拒否する。
- 成功すると `{"received": 受信件数, "saved": 書き込んだ行数}` を返す。
- 送られなかった記録は消さない。端末で削除した測定は D1 から手動で消す。

### `GET /weight.svg`

- 見出しに最新の実測値と測定日を出す。
- 薄い点は各日の最後の測定、濃い線は7日移動平均。測定が7日以上空いた区間は薄い線でつなぐ。
- `prefers-color-scheme` でライト／ダークの配色を切り替える。
- 5分間キャッシュされる。

## ブログへの設置

```html
<img
  src="https://mekata.todays-mitsui.workers.dev/weight.svg"
  alt="今日の三井君の直近6か月の体重推移"
  width="240"
  height="120"
  style="display:block;width:100%;height:auto;color-scheme:light dark"
>
```

## 開発

```sh
npm install
cp .dev.vars.example .dev.vars   # ローカル用のトークン
npm run migrate:local
npm run dev
```

```sh
npm test            # Workers ランタイム上でのテスト
npm run typecheck
```

`wrangler.jsonc` を変えたら `npm run types` で `worker-configuration.d.ts` を作り直す。

## デプロイ

初回だけ D1 を作り、出力された ID を `wrangler.jsonc` の `database_id` に入れる。

```sh
npx wrangler d1 create mekata
npm run migrate:remote
npx wrangler secret put SYNC_TOKEN   # openssl rand -base64 32 などで作った値
npm run deploy
```

## ファイル構成

| パス | 内容 |
|---|---|
| `src/index.ts` | ルーティング、認証、D1 の読み出し |
| `src/sync.ts` | 入力の検証と UPSERT |
| `src/svg.ts` | SVG の組み立て（DB に依存しない） |
| `src/jst.ts` | JST の日付計算 |
| `migrations/` | D1 のマイグレーション |
| `test/` | テスト |
| `PLAN.md` | 仕様の詳細と完了の確認 |
