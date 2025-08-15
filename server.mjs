// server.mjs
import express from "express";
import { randomUUID } from "crypto";

const app = express();

// Parse JSON (limit 1MB) and return 400 on bad JSON instead of 500
app.use(express.json({ limit: "1mb" }));
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "invalid_json" });
  }
  next();
});

// --- config ---
const ORDER_MODE = process.env.ORDER_MODE ?? "test";          // "test" | "live"
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET ?? "").normalize().trim();

// --- helpers ---
const sanitize = (obj = {}) => {
  const c = { ...obj };
  if ("passphrase" in c) c.passphrase = "***";
  if ("token" in c) c.token = "***";
  return c;
};
const normSymbol = (s) =>
  String(s || "")
    .replace(/^.*?:/, "")     // drop exchange prefix like BINANCE:
    .replace(/\.P$/i, "")     // drop .P (perp) suffix if present
    .toUpperCase();

// simple dedupe (keep last ~5000 keys)
const seen = new Set();
const maybePrune = () => { if (seen.size > 5000) seen.clear(); };

// --- liveness ---
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE })
);
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE })
);

// --- webhook handler ---
async function processSignal(data, traceId) {
  const symbol = normSymbol(data.symbol);
  const side = String(data.side || "").toUpperCase(); // BUY/SELL
  const price = Number(data.price ?? 0);

  // TODO: map to your exchange payload here
  // e.g., build order params, sign, and call exchange HTTP API.
  // For now we just log a dry-run / live intent.
  if (ORDER_MODE === "test") {
    console.log(`[${traceId}] DRY-RUN`, { symbol, side, price });
  } else {
    console.log(`[${traceId}] LIVE - TODO place order`, { symbol, side, price });
    // try {
    //   const resp = await fetch("https://api.your-exchange.com/orders", {...});
    //   console.log(`[${traceId}] order result`, await resp.json());
    // } catch (e) {
    //   console.error(`[${traceId}] order error`, e);
    // }
  }
}

const webhook = (req, res) => {
  const data = req.body ?? {};
  const got = String((data.passphrase ?? data.token ?? "")).normalize().trim();

  // auth
  if (WEBHOOK_SECRET) {
    if (!got) return res.status(401).json({ error: "missing passphrase" });
    if (got !== WEBHOOK_SECRET) return res.status(401).json({ error: "bad passphrase" });
  }

  const traceId = randomUUID();
  res.setHeader("X-Request-Id", traceId);

  // dedupe key: prefer client-provided id, else a 5s bucket fallback
  const key =
    data.id ??
    `${data.symbol ?? ""}|${data.side ?? ""}|${data.price ?? ""}|${Math.floor(Date.now() / 1000 / 5)}`;
  const duplicate = seen.has(key);
  if (!duplicate) { seen.add(key); maybePrune(); }

  // immediate response (sanitized)
  const safeEcho = sanitize(data);
  res.json({ ok: true, duplicate, id: traceId, echo: safeEcho });

  // background processing (non-blocking)
  setImmediate(() => {
    try {
      console.log(`[${traceId}] Webhook payload`, sanitize(data), `duplicate=${duplicate}`);
      if (!duplicate) processSignal(data, traceId);
    } catch (e) {
      console.error(`[${traceId}] handler error`, e);
    }
  });
};

// routes (support with/without trailing slash; GET hints 405)
app.post("/webhook", webhook);
app.post("/webhook/", webhook);
app.get("/webhook", (_req, res) => res.status(405).json({ hint: "use POST /webhook" }));

// start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
