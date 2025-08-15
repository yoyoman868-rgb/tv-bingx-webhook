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

const webhook = (req, res) => {
  const data = req.body ?? {};
  const secret = process.env.WEBHOOK_SECRET ?? "";
  if (secret && data.passphrase !== secret)
    return res.status(401).json({ error: "bad passphrase" });
  return res.json({ ok: true, echo: data });
};
app.post("/webhook", webhook);
app.post("/webhook/", webhook); // 防「多一個斜線」造成 404

// (選擇性) GET 到 /webhook 回 405，避免誤會 404
app.get("/webhook", (_req, res) => res.status(405).json({ hint: "use POST /webhook" }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
