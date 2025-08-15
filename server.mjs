import express from "express";
const app = express();
app.use(express.json());

const ORDER_MODE = process.env.ORDER_MODE ?? "test";

app.get("/", (_req, res) =>
  res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE })
);
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE })
);

const seen = new Set(); // 簡易防重複(短暫)
const cleanup = () => { if (seen.size > 5000) seen.clear(); };

const webhook = (req, res) => {
  const data = req.body || {};
  const secret = process.env.WEBHOOK_SECRET ?? "";
  if (secret && data.passphrase !== secret) return res.status(401).json({ error: "bad passphrase" });

  // 基本欄位檢查
  const { id, event, symbol, side, price } = data;
  if (event !== "signal") return res.status(400).json({ error: "bad event" });
  if (!symbol || !side || typeof price !== "number") return res.status(400).json({ error: "bad payload" });

  // 防短時間重送
  const k = id || `${symbol}|${side}|${price}|${Math.floor(Date.now()/1000/5)}`;
  if (seen.has(k)) return res.json({ ok: true, duplicate: true });
  seen.add(k); cleanup();

  // 立刻回 200，後面再做下單（非阻塞）
  res.json({ ok: true, echo: data });

  // TODO: 這裡接你的實際下單流程（排隊/非同步）
  console.log("Webhook payload:", data);
};
app.post("/webhook", webhook);
app.post("/webhook/", webhook);

};

};
app.post("/webhook", webhook);
app.post("/webhook/", webhook); // 防「多一個斜線」造成 404

// (選擇性) GET 到 /webhook 回 405，避免誤會 404
app.get("/webhook", (_req, res) => res.status(405).json({ hint: "use POST /webhook" }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
