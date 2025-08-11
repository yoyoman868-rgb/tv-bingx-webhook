from flask import Flask, request, jsonify
import os, time, hmac, hashlib, requests
@app.get("/")
def index():
    return {"msg": "OK. Use /health and POST /webhook"}

app = Flask(__name__)

API_KEY    = os.getenv("eopvf1s6k36mPyohOX5aPJ0eacp4Na8K0Wgr6031C6CZmf4d9WN9MWEYt9VUCefHhL75kvoAQBWWKRGL7OQ", "")
SECRET_KEY = os.getenv("ciqEPjpIb74DJleZHUHjzixA6oI3Ir6CWjBlMGVWjwXMBYUORi6bIsgVnN1QwnLjrhMpnp1QvAnDqGSKSQg", "")
# 模擬盤 Base URL（若日後上真倉再改）
BASE_URL   = os.getenv("BINGX_BASE_URL", "https://open-api-vst.bingx.com")

# 簽名
def sign(params: dict) -> str:
    qs = "&".join([f"{k}={params[k]}" for k in sorted(params)])
    return hmac.new(SECRET_KEY.encode(), qs.encode(), hashlib.sha256).hexdigest()

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/webhook")
def webhook():
    data = request.get_json(force=True)
    # 例：{"symbol":"BTC-USDT","side":"BUY","type":"MARKET","qty":0.01, "note":"tv"}
    print("TV signal:", data)

    # --- 組參數（以現貨下單為例；合約請改用相應端點與參數）---
    params = {
        "symbol":   data["symbol"],
        "side":     data["side"],     # BUY / SELL
        "type":     data["type"],     # MARKET / LIMIT
        "quantity": str(data["qty"]),
        "timestamp": int(time.time() * 1000),
        "recvWindow": 5000
    }
    if data.get("price"):            # 若 LIMIT 單
        params["price"] = str(data["price"])

    params["signature"] = sign(params)
    headers = {"X-BX-APIKEY": API_KEY}

    # 模擬盤下單端點（現貨示例）；若用合約，請改成合約下單 API
    url = f"{BASE_URL}/openApi/spot/v1/trade/order"
    r = requests.post(url, headers=headers, data=params, timeout=10)
    print("BingX resp:", r.text)

    return jsonify({"status":"ok","exchange":r.json()}), r.status_code if r.status_code<500 else 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)))

