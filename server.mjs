// server.mjs (with per-symbol rules + usd/qty sizing + steps)
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "invalid_json" });
  next();
});

const ORDER_MODE    = (process.env.ORDER_MODE ?? "test").toLowerCase();
const WEBHOOK_SECRET= (process.env.WEBHOOK_SECRET ?? "").normalize().trim();

const DEFAULT_QTY   = Number(process.env.DEFAULT_QTY ?? 0.01);
const LOT_STEP_QTY  = Number(process.env.LOT_STEP ?? 0);
const LOT_STEP_USD  = Number(process.env.LOT_STEP_USD ?? 0);
const MIN_NOTIONAL  = Number(process.env.MIN_NOTIONAL ?? 0);
const MIN_QTY       = Number(process.env.MIN_QTY ?? 0);
const PRICE_TICK    = Number(process.env.PRICE_TICK ?? 0);

const RULES = {
  "ETHUSDT": { lot: 0.001, price: 0.01,  minNotional: 5 },
  "SOLUSDT": { lot: 0.1,   price: 0.001, minNotional: 5 },
  "BTCUSDT": { lot: 0.001, price: 0.1,   minNotional: 5 }
};
function applySymbolRules(sym, { qty, price }) {
  const r = RULES[sym] || {};
  let q = qty, p = price;
  if (r.lot && q)    q = Math.floor(q / r.lot) * r.lot;
  if (r.price && p)  p = Math.round(p / r.price) * r.price;
  return { qty: Number((q??0).toFixed(8)), price: p ? Number(p.toFixed(8)) : p, minNotional: r.minNotional || 0 };
}

const BINGX_API_KEY    = process.env.BINGX_API_KEY ?? "";
const BINGX_API_SECRET = process.env.BINGX_API_SECRET ?? "";
const BINGX_BASE_URL   = process.env.BINGX_BASE_URL ?? "https://open-api.bingx.com";
const BINGX_SOURCE_KEY = process.env.BINGX_SOURCE_KEY ?? "";
const BINGX_RECV_WINDOW= Number(process.env.BINGX_RECV_WINDOW ?? 5000);

const sanitize = (obj = {}) => { const c = { ...obj }; if ("passphrase" in c) c.passphrase = "***"; if ("token" in c) c.token = "***"; return c; };
const normSymbol = (s) => String(s || "").replace(/^.*?:/, "").replace(/\.P$/i, "").toUpperCase();
const toQuery = (obj) => Object.keys(obj).filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "").sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`).join("&");
const signParams = (params, secret) => crypto.createHmac("sha256", secret).update(toQuery(params)).digest("hex");

async function bingxPrivate(path, params, { method = "POST" } = {}) {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) throw new Error("Missing BingX API key/secret");
  const baseParams = { ...params, timestamp: Date.now(), recvWindow: BINGX_RECV_WINDOW };
  const signature = signParams(baseParams, BINGX_API_SECRET);
  const qs = toQuery({ ...baseParams, signature });
  const url = `${BINGX_BASE_URL}${path}${method === "GET" ? `?${qs}` : ""}`;
  const headers = { "X-BX-APIKEY": BINGX_API_KEY, "Content-Type": "application/x-www-form-urlencoded" };
  if (BINGX_SOURCE_KEY) headers["X-SOURCE-KEY"] = BINGX_SOURCE_KEY;
  const resp = await fetch(url, { method, headers, body: method === "POST" ? qs : undefined });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

const PAPER = { positions: new Map(), orders: [] };
function paperTrade(symbol, side, price, qty = 1) {
  symbol = normSymbol(symbol); side = String(side || "").toUpperCase();
  price  = Number(price); qty = Math.abs(Number(qty)) || 1;
  let pos = PAPER.positions.get(symbol) || { qty: 0, avg: 0, realized: 0 };
  const isBuy = side === "BUY"; const delta = isBuy ? qty : -qty;
  let newQty = pos.qty + delta; let avg = pos.avg, realized = pos.realized, pnlDelta = 0;
  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(delta)) {
    const oldAbs = Math.abs(pos.qty); avg = (oldAbs * pos.avg + qty * price) / (oldAbs + qty);
  } else {
    const closeQty = Math.min(Math.abs(pos.qty), qty);
    pnlDelta = (pos.qty > 0) ? (price - pos.avg) * closeQty : (pos.avg - price) * closeQty;
    realized += pnlDelta;
    if (Math.abs(delta) > Math.abs(pos.qty)) { const extra = Math.abs(delta) - Math.abs(pos.qty); newQty = Math.sign(delta) * extra; avg = price; }
    else if (newQty === 0) { avg = 0; }
  }
  const order = { id: "paper-" + Date.now().toString(36), ts: Date.now(), symbol, side, price, qty, pnlDelta };
  PAPER.orders.push(order); if (PAPER.orders.length > 5000) PAPER.orders.shift();
  const newPos = { qty: newQty, avg, realized }; PAPER.positions.set(symbol, newPos);
  return { order, position: newPos };
}

app.get("/paper/state", (_req, res) => { if (ORDER_MODE !== "paper") return res.status(400).json({ error: "not_in_paper_mode" });
  const positions = {}; for (const [sym, p] of PAPER.positions.entries()) positions[sym] = p; res.json({ positions, lastOrders: PAPER.orders.slice(-50) }); });
app.post("/paper/reset", (_req, res) => { if (ORDER_MODE !== "paper") return res.status(400).json({ error: "not_in_paper_mode" }); PAPER.positions.clear(); PAPER.orders.length = 0; res.json({ ok: true }); });

app.get("/", (_req, res) => res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE }));

async function processSignal(data, traceId) {
  const symbol  = normSymbol(data.symbol);
  const side    = String(data.side || "").toUpperCase();
  const type    = String(data.type ?? "MARKET").toUpperCase();
  let   price   = data.price !== undefined ? Number(data.price) : undefined;
  const posSide = String(data.positionSide ?? (side === "BUY" ? "LONG" : "SHORT")).toUpperCase();
  const reduceOnly = Boolean(data.reduceOnly ?? false);

  let qty  = Number(data.qty ?? data.size ?? 0);
  let usd  = Number(data.usd ?? data.usdt ?? 0);
  if (usd && LOT_STEP_USD > 0) usd = Math.floor(usd / LOT_STEP_USD) * LOT_STEP_USD;
  if (!qty && usd) { if (!price || !isFinite(price)) { console.error(`[${traceId}] usd sizing requires price`); return; } qty = usd / price; }
  if (!qty) qty = DEFAULT_QTY;
  if (LOT_STEP_QTY > 0) { qty = Math.floor(qty / LOT_STEP_QTY) * LOT_STEP_QTY; qty = Number(qty.toFixed(8)); }

  // per symbol
  const adj = applySymbolRules(symbol, { qty, price }); qty = adj.qty; price = adj.price ?? price;
  const minNotional = adj.minNotional || MIN_NOTIONAL;

  if (MIN_QTY > 0 && qty < MIN_QTY) { console.warn(`[${traceId}] qty below MIN_QTY: ${qty} < ${MIN_QTY}`); return; }
  if (minNotional > 0 && price && qty * price < minNotional) { console.warn(`[${traceId}] notional below minNotional: ${qty*price} < ${minNotional}`); return; }

  if (type === "LIMIT" && PRICE_TICK > 0 && isFinite(price)) { price = Math.round(price / PRICE_TICK) * PRICE_TICK; price = Number(price.toFixed(8)); }

  if (ORDER_MODE === "paper") { const result = paperTrade(symbol, side, price ?? 0, qty); console.log(`[${traceId}] PAPER`, { symbol, side, price, qty, result }); return; }
  if (ORDER_MODE === "test")  { console.log(`[${traceId}] DRY-RUN`, { symbol, side, price, qty, type, posSide, reduceOnly }); return; }

  if (type === "LIMIT" && (price === undefined || Number.isNaN(price))) { console.error(`[${traceId}] LIMIT order missing/invalid price`); return; }
  const params = { symbol, side, type, positionSide: posSide, quantity: qty, price: type === "LIMIT" ? price : undefined, reduceOnly: reduceOnly ? "true" : undefined };
  try { const { status, data: resp } = await bingxPrivate("/openApi/swap/v2/trade/order", params, { method: "POST" }); console.log(`[${traceId}] LIVE RESP`, status, resp); }
  catch (e) { console.error(`[${traceId}] LIVE ERROR`, e); }
}

const seen = new Set();
const maybePrune = () => { if (seen.size > 5000) seen.clear(); };
const webhook = (req, res) => {
  const data = req.body ?? {}; const got  = String((data.passphrase ?? data.token ?? "")).normalize().trim();
  if (WEBHOOK_SECRET) { if (!got) return res.status(401).json({ error: "missing passphrase" }); if (got !== WEBHOOK_SECRET) return res.status(401).json({ error: "bad passphrase" }); }
  const traceId = crypto.randomUUID(); res.setHeader("X-Request-Id", traceId);
  const key = data.id ?? `${data.symbol ?? ""}|${data.side ?? ""}|${data.price ?? ""}|${Math.floor(Date.now() / 1000 / 5)}`;
  const duplicate = seen.has(key); if (!duplicate) { seen.add(key); maybePrune(); }
  res.json({ ok: true, duplicate, id: traceId, mode: ORDER_MODE });
  setImmediate(() => { try { if (!duplicate) processSignal(data, traceId); } catch (e) { console.error(`[${traceId}] handler error`, e); } });
};
app.post("/webhook", webhook);
app.post("/webhook/", webhook);
app.get("/webhook", (_req, res) => res.status(405).json({ hint: "use POST /webhook" }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
