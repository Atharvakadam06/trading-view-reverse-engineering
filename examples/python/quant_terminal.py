#!/usr/bin/env python3
"""Drive Quant Terminal's local API from Python. Standard library only, nothing to install.

    python3 examples/python/quant_terminal.py            # bars, a backtest with quant checks, an alert
    python3 examples/python/quant_terminal.py --listen   # then print each alert as it fires

Quant Terminal must be running (npm start). Set QT_URL if it isn't on http://127.0.0.1:3777.
The API is documented in docs/api.md.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("QT_URL", "http://127.0.0.1:3777").rstrip("/")


def call(method, path, body=None):
    """One request. Writes carry the x-qt header the app requires."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    if method != "GET":
        headers["x-qt"] = "1"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raise SystemExit(
            f"{method} {path} failed ({e.code}): {json.loads(e.read() or b'{}').get('error')}"
        )
    except urllib.error.URLError as e:
        raise SystemExit(
            f"Can't reach Quant Terminal at {BASE} ({e.reason}). Start it with npm start, or set QT_URL."
        )


def candles(symbol, tf="1D", limit=500):
    return call(
        "GET", f"/api/candles?symbol={urllib.parse.quote(symbol)}&tf={tf}&limit={limit}"
    )


def backtest(symbol, strategy, tf="1D", limit=1500, quant_checks=False):
    return call(
        "POST",
        "/api/backtest",
        {
            "symbol": symbol,
            "tf": tf,
            "limit": limit,
            "strategy": strategy,
            "quantChecks": quant_checks,
        },
    )


def add_alert(alert):
    return call("POST", "/api/alerts", alert)


def listen():
    """Print each alert as it fires, from the app's live event stream."""
    req = urllib.request.Request(BASE + "/api/events")
    with urllib.request.urlopen(req) as stream:
        event = None
        for raw in stream:
            line = raw.decode().strip()
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:") and event == "alert":
                a = json.loads(line[5:])
                print(f"{a['at']}  {a['symbol']} {a['tf']}  {a['text']}", flush=True)


if __name__ == "__main__":
    health = call("GET", "/api/health")
    print(
        f"Quant Terminal {health['version']} is running. Your own data keys: {health.get('feeds') or 'none'}"
    )

    r = candles("BTCUSDT", "1h", 10)  # the API sends at least 10 bars
    print(f"\nLast 3 hourly BTC bars from {r['provider']}:")
    for c in r["candles"][-3:]:
        print(f"  {c['time']}  open {c['open']:.2f}  close {c['close']:.2f}")

    ema_cross = {
        "indicators": {
            "fast": {"id": "ema", "params": {"length": 9}},
            "slow": {"id": "ema", "params": {"length": 21}},
        },
        "entryLong": [{"left": "fast", "op": "crossesAbove", "right": "slow"}],
        "exitLong": [{"left": "fast", "op": "crossesBelow", "right": "slow"}],
        "feePct": 0.1,
        "slippagePct": 0.05,
    }
    bt = backtest("BTCUSDT", ema_cross, quant_checks=True)
    s = bt["stats"]
    print(
        f"\nEMA 9/21 cross on {bt['symbol']} {bt['tf']}, {bt['bars']} bars: {s['totalTrades']} trades, "
        f"net {s['netProfitPct']}%, buy and hold {s['buyHoldPct']}%, worst drop {s['maxDrawdownPct']}%"
    )
    q = bt["quantChecks"]
    print(f"Quant checks: passed {q['passed']} of {q['total']}")
    for g in q["gates"]:
        print(f"  {'PASS' if g['pass'] else 'FAIL'}  {g['label']}: {g['value']}")

    alert = add_alert(
        {
            "symbol": "BINANCE:BTCUSDT",
            "tf": "1h",
            "conditions": [{"left": "close", "op": ">", "right": 0}],
            "trigger": "once",
            "message": "Python example: test alert",
            # "webhook": "https://your-server.example/hook",  # the app POSTs here when it fires
        }
    )
    call("POST", "/api/alerts/check")
    fired = [e for e in call("GET", "/api/alerts/log") if e["alertId"] == alert["id"]]
    print(f"\nAdded alert {alert['id']}, it fired {len(fired)} time(s). Deleting it.")
    call("DELETE", f"/api/alerts/{alert['id']}")

    if "--listen" in sys.argv:
        print("\nListening for alerts (Ctrl+C to stop)...")
        listen()
