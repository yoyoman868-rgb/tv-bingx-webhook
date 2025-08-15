// server.mjs
import express from "express";
import crypto from "crypto";

const app = express();

// -------- middleware: JSON & error handling --------
app.use(express.json({ limit: "1mb" }));
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "invalid_json" });
  next();
});

// -------- config (env) --------
const ORDER_MODE = (process.env.ORDER_MODE ?? "test").toLowerCase();        // "paper" | "test" | "live"
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET ?? "").normalize().trim();

// BingX (live mode)
const BINGX_API_KEY    = process.env.BINGX_API_KEY ?? "";
const BINGX_API_SECRET = process.env.BINGX_API_SECRET ?? "";
const BINGX_BASE_URL   = process.env.BINGX_BASE_URL ?? "https://open-api.bingx.com";
const BINGX_SOURCE_KEY = process.env.BINGX_SOURCE_KEY ?? ""; // (可選) Broker 方案才需要
const BINGX_RECV_WINDOW= Number(process.env.BINGX_RECV_WINDOW ?? 5000);     // 毫秒

// -------- helpers --------
const sanitize = (obj = {}) => {
  const c = { ...obj };
  if ("passphrase" in c) c.passphrase = "***";
  if ("token" in c) c.token = "***";
  return c;
};
const normSymbol = (s) =>
  String(s || "")
    .replace(/^.*?:/, "")   // 去掉交易所前綴（如 BINANCE:）
    .replace(/\.P$/i, "")   // 去掉 .P（永續）
    .toUpperCase();

const toQuery = (obj) =>
  Object.keys(obj)
    .filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "")
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`)
    .join("&");

const signParams = (params, secret) =>
  crypto.createHmac("sha256", secret).update(toQuery(params)).digest("hex");

// 私有請求（BingX）
async function bingxPrivate(path, params, { method = "POST" } = {}) {
  if (!BINGX_API_KEY || !BINGX_API_SECRET) throw new Error("Missing BingX API key/secret");

  const baseParams = {
    ...params,
    timestamp: Date.now(),
    recvWindow: BINGX_RECV_WINDOW
  };
  const signature = signParams(baseParams, BINGX_API_SECRET);
  const qs = toQuery({ ...baseParams, signature });

  const url = `${BINGX_BASE_URL}${path}${method === "GET" ? `?${qs}` : ""}`;
  const headers = {
    "X-BX-APIKEY": BINGX_API_KEY,
    "Content-Type": "application/x-www-form-urlencoded"
  };
  if (BINGX_SOURCE_KEY) headers["X-SOURCE-KEY"] = BINGX_SOURCE_KEY;

  const resp = await fetch(url, { method, headers, body: method === "POST" ? qs : undefined });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// 去重（短時間重複訊息忽略）
const seen = new Set();
const maybePrune = () => { if (seen.size > 5000) seen.clear(); };

// -------- paper trading (內建模擬倉) --------
const PAPER = { positions: new Map(), orders: [] }; // symbol -> { qty, avg, realized }

function paperTrade(symbol, side, price, qty = 1) {
  symbol = normSymbol(symbol);
  side   = String(side || "").toUpperCase();
  price  = Number(price);
  qty    = Math.abs(Number(qty)) || 1;

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
  const newPos = { qty: newQty, avg, realized };
  PAPER.positions.set(symbol, newPos);
  return { order, position: newPos };
}

app.get("/paper/state", (_req, res) => {
  if (ORDER_MODE !== "paper") return res.status(400).json({ error: "not_in_paper_mode" });
  const positions = {}; for (const [sym, p] of PAPER.positions.entries()) positions[sym] = p;
  res.json({ positions, lastOrders: PAPER.orders.slice(-50) });
});

app.post("/paper/reset", (_req, res) => {
  if (ORDER_MODE !== "paper") return res.status(400).json({ error: "not_in_paper_mode" });
  PAPER.positions.clear(); PAPER.orders.length = 0;
  res.json({ ok: true });
});

// -------- liveness --------
app.get("/", (_req, res) => res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "tv-bingx-webhook", orderMode: ORDER_MODE }));

// -------- order processor --------
async function processSignal(data, traceId) {
  const symbol  = normSymbol(data.symbol);
  const side    = String(data.side || "").toUpperCase();        // BUY / SELL
  const qty     = Number(data.qty ?? data.size ?? 1);
  const type    = String(data.type ?? "MARKET").toUpperCase();  // MARKET / LIMIT
  const price   = data.price !== undefined ? Number(data.price) : undefined;
  const posSide = String(data.positionSide ?? (side === "BUY" ? "LONG" : "SHORT")).toUpperCase();
  const reduceOnly = Boolean(data.reduceOnly ?? false);

  if (ORDER_MODE === "paper") {
    const result = paperTrade(symbol, side, price ?? 0, qty);
    console.log(`[${traceId}] PAPER`, { symbol, side, price, qty, ...result });
    return;
  }

  if (ORDER_MODE === "test") {
    console.log(`[${traceId}] DRY-RUN`, { symbol, side, price, qty, type, posSide, reduceOnly });
    return;
  }

  // ---- LIVE: BingX 下單 ----
  // 端點: /openApi/swap/v2/trade/order  (永續合約)
  // 參數名稱在帳戶/產品線可能微調，這裡提供常見欄位；若你的帳戶需要 "volume" 請把 quantity 改為 volume。
  if (type === "LIMIT" && (price === undefined || Number.isNaN(price))) {
    console.error(`[${traceId}] LIMIT order missing price`);
    return;
  }

  const params = {
    symbol,
    side,                  // BUY / SELL
    type,                  // MARKET / LIMIT ...
    positionSide: posSide, // LONG / SHORT（單向倉可忽略）
    quantity: qty,         // 某些情況需使用 volume，請按實際需求調整
    price: type === "LIMIT" ? price : undefined,
    reduceOnly: reduceOnly ? "true" : undefined,
    // clientOrderId: data.id,  // 可選：自訂 ID
  };

  try {
    const { status, data } = await bingxPrivate("/openApi/swap/v2/trade/order", params, { method: "POST" });
    console.log(`[${traceId}] LIVE RESP`, status, data);
  } catch (e) {
    console.error(`[${traceId}] LIVE ERROR`, e);
  }
}

// -------- webhook --------
const webhook = (req, res) => {
  const data = req.body ?? {};
  const got  = String((data.passphrase ?? data.token ?? "")).normalize().trim();

  if (WEBHOOK_SECRET) {
    if (!got)       return res.status(401).json({ error: "missing passphrase" });
    if (got !== WEBHOOK_SECRET) return res.status(401).json({ error: "bad passphrase" });
  }

  const traceId = crypto.randomUUID();
  res.setHeader("X-Request-Id", traceId);

  const key = data.id ?? `${data.symbol ?? ""}|${data.side ?? ""}|${data.price ?? ""}|${Math.floor(Date.now() / 1000 / 5)}`;
  const duplicate = seen.has(key); if (!duplicate) { seen.add(key); maybePrune(); }

  res.json({ ok: true, duplicate, id: traceId, mode: ORDER_MODE, echo: sanitize(data) });

  setImmediate(() => {
    try {
      console.log(`[${traceId}] Webhook payload`, sanitize(data), `duplicate=${duplicate}`);
      if (!duplicate) processSignal(data, traceId);
    } catch (e) {
      console.error(`[${traceId}] handler error`, e);
    }
  });
};

app.post("/webhook", webhook);
app.post("/webhook/", webhook);
app.get("/webhook", (_req, res) => res.status(405).json({ hint: "use POST /webhook" }));

// -------- start server --------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
