# TV → BingX Webhook (Render Ready)

A minimal Express server that receives TradingView alerts (via `alert()` + webhook) and places orders on **BingX Perpetuals**.

## 1) Deploy (Render)
- New Web Service → Node 18+
- Build Command: *(empty)*
- Start Command: `node server.mjs`
- Set **Environment Variables**:
  - `WEBHOOK_TOKEN` = your secret (e.g., `mysecret123`)
  - `BINGX_KEY`, `BINGX_SECRET` (and optional `BINGX_SUBACC`)
  - `POSITION_MODE` = `ONE_WAY` or `HEDGE`
  - `DEFAULT_LEVERAGE` (e.g., 10)
  - `RISK_USDT` (e.g., 50)

## 2) Health Check
`GET /health` → `{ ok: true, ... }`

## 3) Webhook URL (TradingView)
Use:
```
https://YOUR-RENDER.onrender.com/tv?token=YOUR_WEBHOOK_TOKEN
```

## 4) TradingView Pine (inside your strategy)
Use `alert()` to send JSON (do **not** use `alertcondition()` for webhooks).

```pinescript
f_send_alert(_side, _sl, _tp) =>
    if barstate.isconfirmed
        string payload = '{"event":"signal","symbol":"' + syminfo.ticker +
                         '","side":"' + _side + '","price":' + str.tostring(close) +
                         ',"sl":' + str.tostring(_sl) + ',"tp":' + str.tostring(_tp) +
                         ',"time":' + str.tostring(time) +
                         ',"token":"YOUR_WEBHOOK_TOKEN"}'
        alert(payload, alert.freq_once_per_bar_close)

if buySig
    f_send_alert("BUY",  longSL,  longTP)
if sellSig
    f_send_alert("SELL", shortSL, shortTP)
```

> In the TradingView alert UI: **Condition** = your script → *Any alert() function call*; **Webhook URL** = the URL from step 3.

## 5) Local Test
```bash
curl -X POST "https://YOUR-RENDER.onrender.com/tv?token=YOUR_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event":"signal","symbol":"BINANCE:BTCUSDT.P","side":"BUY","price":60000,"sl":59500,"tp":61200}'
```

## 6) Notes
- This server first calls `/openApi/swap/v2/trade/order/test`, then the live `/order`.
- Ensure your account mode matches your strategy (ONE_WAY vs HEDGE) and symbols are enabled.
- Adjust `mapSymbol()` if your TradingView symbols differ (Bybit / Binance style).

