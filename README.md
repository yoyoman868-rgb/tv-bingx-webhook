# Minimal TV → BingX Webhook (Render)
Files:
- server.mjs
- package.json

Render Start Command:
```
node server.mjs
```

Env (Render → Environment):
```
WEBHOOK_TOKEN=apa_365fbca0b512294d47b2f9df
BINGX_KEY=YOUR_DEMO_OR_LIVE_KEY
BINGX_SECRET=YOUR_DEMO_OR_LIVE_SECRET
ORDER_MODE=test            # test or live
POSITION_MODE=ONE_WAY
DEFAULT_LEVERAGE=10
RISK_USDT=50
```

Health: `GET /health`  
Last event: `GET /last`

TradingView Webhook URL:
```
https://tv-bingx-webhook-5.onrender.com/tv?token=apa_365fbca0b512294d47b2f9df
```
