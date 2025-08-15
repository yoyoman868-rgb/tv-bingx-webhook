// server.mjs — CLEAN MINIMAL (test/live toggle)
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();

// Accept any content-type (TV may send text/plain)
app.use(express.text({ type: "*/*", limit: "1mb" }));
app.use((req, _res, next) => {
  try {
    if (typeof req.body === "string" && req.body.trim().startsWith("{")) {
      req.body = JSON.parse(req.body);
    }
  } catch {}
  next();
});

// ===== Env =====
const API_KEY       = process.env.BINGX_KEY || "";
const API_SECRET    = process.env.BINGX_SECRET || "";
const SUBACCOUNT    = process.env.BINGX_SUBACC || ""; // optional
const BASE_URL      = process.env.BINGX_BASE_URL || "https://open-api.bingx.com";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "apa_365fbca0b512294d47b2f9df"; // your token (change in Render if needed)
const POSITION_MODE = (process.env.POSITION_MODE || "ONE_WAY").toUpperCase(); // ONE_WAY or HEDGE
const DEFAULT_LEVER = parseInt(process.env.DEFAULT_LEVERAGE || "10", 10);
const RISK_USDT     = parseFloat(process.env.RISK_USDT || "50"); // risk budget per trade (example)
const ORDER_MODE    = (process.env.ORDER_MODE || "test").toLowerCase(); // "test" or "live"
const PORT          = parseInt(process.env.PORT || "3000", 10);

// ===== Helpers =====
function mapSymbol(tvSymbol) {
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
function sign(queryString) {
  return crypto.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
}
async function bxPost(path, params = {}) {
  const timestamp = Date.now();
  const fullParams = { ...params, timestamp };
  const query = new URLSearchParams(fullParams).toString();
  const signature = sign(query);
  const url = `${BASE_URL}${path}?${query}&signature=${signature}`;
  const headers = { "X-BX-APIKEY": API_KEY, "Content-Type": "application/json" };
  if (SUBACCOUNT) headers["X-BX-SUBACCOUNT"] = SUBACCOUNT;
  const res = await fetch(url, { method: "POST", headers });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

// ===== Minimal Health/Events =====
const _events = [];
function addEvent(e){ _events.push({ ts: Date.now(), ...e }); if (_events.length>200) _events.shift(); }
app.get("/health", (_req, res) => res.json({ ok:true, service:"tv-bingx-webhook", orderMode:ORDER_MODE }));
app.get("/last",   (_req, res) => res.json({ ok:true, last: _events[_events.length-1] || null }));

// ===== Webhook =====
app.post("/tv", async (req, res) => {
  try{
    const urlToken = (req.query.token || "").toString();
    const bodyToken = req.body && req.body.token ? String(req.body.token) : "";
    if (WEBHOOK_TOKEN && urlToken !== WEBHOOK_TOKEN && bodyToken !== WEBHOOK_TOKEN) {
      return res.status(401).json({ ok:false, error:"bad token" });
    }

    const p = req.body || {};
    const side = String(p.side || "").toUpperCase();
    const tvSymbol = p.symbol;
    const price = Number(p.price);
    const sl = Number(p.sl);
    const tp = Number(p.tp || 0);
    if (!side || !tvSymbol || !price || !sl) return res.status(400).json({ ok:false, error:"missing fields (side/symbol/price/sl)" });
    if (!API_KEY || !API_SECRET)         return res.status(500).json({ ok:false, error:"missing BINGX_KEY/SECRET" });

    const symbol = mapSymbol(tvSymbol);
    const leverage = DEFAULT_LEVER;
    const quantity = Number(p.quantity || calcQty({ price, sl, leverage }));

    addEvent({ type:"tv_signal_in", side, tvSymbol, symbol, price, sl, tp });

    // position mode
    if (POSITION_MODE === "ONE_WAY") await bxPost("/openApi/swap/v1/positionSide/dual", { dualSidePosition:false });
    else if (POSITION_MODE === "HEDGE") await bxPost("/openApi/swap/v1/positionSide/dual", { dualSidePosition:true });

    await bxPost("/openApi/swap/v2/trade/leverage", { symbol, leverage });

    const common = { symbol, side: side === "BUY" ? "BUY" : "SELL", type:"MARKET", quantity, recvWindow:5000 };

    const test = await bxPost("/openApi/swap/v2/trade/order/test", common);
    if (test.status !== 200 || (test.data && test.data.code && test.data.code !== 0)) {
      return res.status(500).json({ ok:false, stage:"order_test", resp:test.data });
    }

    if (ORDER_MODE === "live") {
      const live = await bxPost("/openApi/swap/v2/trade/order", common);
      addEvent({ type:"bx_order", mode:"live", symbol, side:common.side, quantity });
      return res.json({ ok:true, mode:"live", requested:{ symbol, side:common.side, quantity, price, sl, tp }, bingx: live.data });
    } else {
      addEvent({ type:"bx_order", mode:"test", symbol, side:common.side, quantity });
      return res.json({ ok:true, mode:"test", requested:{ symbol, side:common.side, quantity, price, sl, tp }, bingx_test: test.data });
    }
  }catch(e){
    return res.status(500).json({ ok:false, error: e.message || String(e) });
  }
});

app.listen(PORT, ()=> console.log(`Webhook on :${PORT}`));
