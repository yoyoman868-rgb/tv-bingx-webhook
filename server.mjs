// server.mjs
import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "invalid_json" });
  next();
});

// --- config ---
const ORDER_MODE = (process.env.ORDER_MODE ?? "test").toLowerCase(); // "paper" | "test" | "live"
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET ?? "").normalize().trim();

// --- helpers ---
const sanitize = (obj = {}) => { const c = { ...obj }; if ("passphrase" in c) c.passphrase = "***"; if ("token" in c) c.token = "***"; return c; };
const normSymbol = (s) => String(s || "").replace(/^.*?:/, "").replace(/\.P$/i, "").toUpperCase();
const seen = new Set(); const maybePrune = () => { if (seen.size > 5000) seen.clear(); };

// --- paper trading store & endpoints ---
const PAPER = { positions: new Map(), orders: [] }; // symbol -> { qty, avg, realized }
function paperTrade(symbol, side, price, qty = 1) {
  symbol = normSymbol(symbol);
  side = String(side || "").toUpperCase();
  price = Number(price);
  qty = Math.abs(Number(qty)) || 1;

  let pos = PAPER.positions.get(symbol) || { qty: 0, avg: 0, realized: 0 };
  const isBuy = side === "BUY";
  const delta = isBuy ? qty : -qty;
  let newQty = pos.qty + delta;
  let avg = pos.avg, realized = pos.realized, pnlDelta = 0;

  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(delta)) {
    const oldAbs = Math.abs(pos.qty);
    avg = (oldAbs * pos.avg + qty * price) / (oldAbs + qty);
  } else {
    const closeQty = Math.min(Math.abs(pos.qty), qty);
    pnlDelta = (pos.qty > 0) ? (price - pos.avg) * closeQty : (pos.avg - price) * closeQty;
    realized += pnlDelta;
    if (Math.abs(delta) > Math.abs(pos.qty)) { // flip
      const extra = Math.abs(delta) - Math.abs(pos.qty);
      newQty = Math.sign(delta) * extra; avg = price;
    } else if (newQty === 0) { avg = 0; }
  }

  const order = { id: "paper-" + Date.now().toString(36), ts: Date.now(), symbol, side, price, qty, pnlDelta };
  PAPER.orders.push(order); if (PAPER.orders.length > 5000) PAPER.orders.shift();
  const newPos = { qty: newQty, avg, realized }; PAPER.positions.set(symbol, newPos);
  return { order, position: newPos };
}
app.get("/paper/state", (_req, res) => {
  const positions = {}; for (const [sym, p] of PAPER.positions.entries()) positions[sym] = p;
  res.json({ positions, lastOrders: PAPER.orders.slice(-50) });
});
app.post("/paper/reset", (_req, res) => { PAPER.positions.clear(); PAPER.orders.length = 0; res.json({ ok: true }); });

// --- liveness ---
app.get("/", (_req, res) => res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE }));

// --- order processor ---
async function processSignal(data, traceId) {
  const symbol = normSymbol(data.symbol);
  const side = String(data.side || "").toUpperCase();
  const price = Number(data.price ?? 0);
  const qty = Number(data.qty ?? data.size ?? 1);

  if (ORDER_MODE === "paper") {
    const result = paperTrade(symbol, side, price, qty);
    console.log(`[${traceId}] PAPER`, { symbol, side, price, qty, ...result });
    return;
  }
  if (ORDER_MODE === "test") {
    console.log(`[${traceId}] DRY-RUN`, { symbol, side, price, qty });
    return;
  }
  // TODO: live: call exchange API here (BingX)
  console.log(`[${traceId}] LIVE - TODO place order`, { symbol, side, price, qty });
}

// --- webhook ---
const webhook = (req, res) => {
  const data = req.body ?? {};
  const got = String((data.passphrase ?? data.token ?? "")).normalize().trim();
  if (WEBHOOK_SECRET) {
    if (!got) return res.status(401).json({ error: "missing passphrase" });
    if (got !== WEBHOOK_SECRET) return res.status(401).json({ error: "bad passphrase" });
  }
  const traceId = randomUUID();
  res.setHeader("X-Request-Id", traceId);

  const key = data.id ?? `${data.symbol ?? ""}|${data.side ?? ""}|${data.price ?? ""}|${Math.floor(Date.now()/1000/5)}`;
  const duplicate = seen.has(key); if (!duplicate) { seen.add(key); maybePrune(); }

  res.json({ ok: true, duplicate, id: traceId, echo: sanitize(data) });

  setImmediate(() => {
    try {
      console.log(`[${traceId}] Webhook payload`, sanitize(data), `duplicate=${duplicate}`);
      if (!duplicate) processSignal(data, traceId);
    } catch (e) { console.error(`[${traceId}] handler error`, e); }
  });
};
app.post("/webhook", webhook);
app.post("/webhook/", webhook);
app.get("/webhook", (_req, res) => res.status(405).json({ hint: "use POST /webhook" }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
