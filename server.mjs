// server.mjs
import express from "express";

const app = express();

// 解析 JSON（限制 1MB）
app.use(express.json({ limit: "1mb" }));

// 把 JSON 解析錯誤變成 400，而不是 500
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "invalid_json" });
  }
  next();
});

const ORDER_MODE = process.env.ORDER_MODE ?? "test";

// 基本存活檢查
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE })
);
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE })
);

// 簡易防重複（短時間同樣的 id 不重複處理）
const seen = new Set();
const maybePrune = () => { if (seen.size > 5000) seen.clear(); };

// Webhook 主處理
const webhook = (req, res) => {
  const data = req.body ?? {};
  const secret = process.env.WEBHOOK_SECRET ?? "";

  // 密碼驗證（支援 passphrase 或 token 欄位）
  if (secret) {
    const got = ((data.passphrase ?? data.token) ?? "").toString().trim();
    if (!got) return res.status(401).json({ error: "missing passphrase" });
    if (got !== secret) return res.status(401).json({ error: "bad passphrase" });
  }

  // 防重送：優先用 data.id；沒有就用符號+方向+價格+5秒桶
  const dedupeKey =
    data.id ??
    `${data.symbol ?? ""}|${data.side ?? ""}|${data.price ?? ""}|${Math.floor(Date.now() / 1000 / 5)}`;

  const duplicate = seen.has(dedupeKey);
  if (!duplicate) {
    seen.add(dedupeKey);
    maybePrune();
  }

  // 立刻回應 200，後續你可以把實際下單放到背景處理
  res.json({ ok: true, duplicate, echo: data });

  // TODO: 在這裡接你的下單/記錄流程（非阻塞）
  console.log("Webhook payload:", data, "duplicate:", duplicate);
};

// 支援有/無尾斜線
app.post("/webhook", webhook);
app.post("/webhook/", webhook);

// GET /webhook 時給提示，避免誤會 404
app.get("/webhook", (_req, res) =>
  res.status(405).json({ hint: "use POST /webhook" })
);

// 啟動
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
