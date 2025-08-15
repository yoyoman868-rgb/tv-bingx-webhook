// server.mjs
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();

// Accept any content-type: TV sometimes sends text/plain
app.use(express.text({ type: "*/*", limit: "1mb" }));
app.use((req, _res, next) => {
  try {
    if (typeof req.body === "string" && req.body.trim().startsWith("{")) {
      req.body = JSON.parse(req.body);
    }
  } catch (e) {}
  next();
});

// ===== Env =====
const API_KEY       = process.env.BINGX_KEY || "";
const API_SECRET    = process.env.BINGX_SECRET || "";
const SUBACCOUNT    = process.env.BINGX_SUBACC || ""; // optional
const BASE_URL      = process.env.BINGX_BASE_URL || "https://open-api.bingx.com";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || ""; // recommended
const POSITION_MODE = (process.env.POSITION_MODE || "ONE_WAY").toUpperCase(); // ONE_WAY or HEDGE
const DEFAULT_LEVER = parseInt(process.env.DEFAULT_LEVERAGE || "10", 10);
const RISK_USDT     = parseFloat(process.env.RISK_USDT || "50"); // per trade risk budget (example)
const PORT          = parseInt(process.env.PORT || "3000", 10);

// ===== Helpers =====
function mapSymbol(tvSymbol) {
  // Examples:
  // BINANCE:BTCUSDT.P -> BTCUSDT
  // BYBIT:ETHUSDT.P   -> ETHUSDT
  // BTCUSDT           -> BTCUSDT
  if (!tvSymbol) return tvSymbol;
  const upper = String(tvSymbol).toUpperCase();
  const m = upper.match(/[A-Z]{3,}USDT/);
  return m ? m[0] : upper.replace(/[^A-Z]/g, "");
}

function calcQty({ price, sl, riskUSDT = RISK_USDT, leverage = DEFAULT_LEVER }) {
  const riskPerUnit = Math.abs(price - sl);
  if (!riskPerUnit || riskPerUnit <= 0) return 0;
  const qty = (riskUSDT / riskPerUnit) * leverage;
  return Number(qty.toFixed(4));
}

function hmacSign(queryString) {
  return crypto.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
}

async function bxPost(path, params = {}) {
  const timestamp = Date.now();
  const fullParams = { ...params, timestamp };
  const query = new URLSearchParams(fullParams).toString();
  const signature = hmacSign(query);
  const url = `${BASE_URL}${path}?${query}&signature=${signature}`;
  const headers = {
    "X-BX-APIKEY": API_KEY,
    "Content-Type": "application/json",
  };
  if (SUBACCOUNT) headers["X-BX-SUBACCOUNT"] = SUBACCOUNT;
  const res = await fetch(url, { method: "POST", headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

// ===== Endpoints =====
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tv-bingx-webhook", mode: POSITION_MODE, version: 1 });
});

app.get("/symbols", (_req, res) => {
  res.json({ ok: true, examples: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] });
});

app.post("/tv", async (req, res) => {
  try {
    // Token check (either in URL ?token=... or payload.token)
    const urlToken = (req.query.token || "").toString();
    const bodyToken = req.body && req.body.token ? String(req.body.token) : "";
    if (WEBHOOK_TOKEN && urlToken !== WEBHOOK_TOKEN && bodyToken !== WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "bad token" });
    }

    // Parse payload
    const payload = req.body || {};
    // Accept either {event:'signal', ...} or raw fields
    const evt = payload.event || "signal";
    if (evt !== "signal") return res.status(400).json({ ok: false, error: "invalid event", payload });

    const side = String(payload.side || "").toUpperCase();
    const tvSymbol = payload.symbol;
    const price = Number(payload.price);
    const sl = Number(payload.sl);
    const tp = Number(payload.tp || 0);

    if (!side || !tvSymbol || !price || !sl) {
      return res.status(400).json({ ok: false, error: "missing fields (side/symbol/price/sl)" });
    }

    const symbol = mapSymbol(tvSymbol);
    const leverage = DEFAULT_LEVER;
    const quantity = Number(payload.quantity || calcQty({ price, sl, leverage }));

    if (!API_KEY || !API_SECRET) {
      return res.status(500).json({ ok: false, error: "missing BINGX_KEY/SECRET envs" });
    }

    // 1) Set position mode (optional but recommended)
    // dualSidePosition: true -> Hedge; false -> One-way
    if (POSITION_MODE === "ONE_WAY") {
      await bxPost("/openApi/swap/v1/positionSide/dual", { dualSidePosition: false });
    } else if (POSITION_MODE === "HEDGE") {
      await bxPost("/openApi/swap/v1/positionSide/dual", { dualSidePosition: true });
    }

    // 2) Set leverage (optional; some accounts require it per symbol)
    await bxPost("/openApi/swap/v2/trade/leverage", { symbol, leverage });

    // 3) Place test order first
    const common = {
      symbol,
      side: side === "BUY" ? "BUY" : "SELL",
      type: "MARKET",
      quantity,
      recvWindow: 5000,
    };

    const test = await bxPost("/openApi/swap/v2/trade/order/test", common);
    if (test.status !== 200 || (test.data && test.data.code && test.data.code !== 0)) {
      return res.status(500).json({ ok: false, stage: "order_test", resp: test.data });
    }

    // 4) Live order
    const live = await bxPost("/openApi/swap/v2/trade/order", common);

    // (Optional) You can submit TP/SL as subsequent orders; here we just echo back
    return res.json({ ok: true, requested: { symbol, side: common.side, quantity, price, sl, tp }, bingx: live.data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Webhook running on :${PORT}`);
});
