//! Drive Quant Terminal's local API from Rust. Standard library only, so it builds offline.
//!
//!     cargo run --release              # bars, a backtest with quant checks, an alert
//!     cargo run --release -- --listen  # then print each alert as it fires
//!
//! Quant Terminal must be running (npm start). Set QT_URL if it isn't on http://127.0.0.1:3777.
//! The API is documented in docs/api.md. Responses are JSON; for real work, parse them with serde_json.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

struct Api {
    host: String, // "127.0.0.1:3777"
}

impl Api {
    fn from_env() -> Api {
        let url = std::env::var("QT_URL").unwrap_or_else(|_| "http://127.0.0.1:3777".into());
        let host = url.trim_start_matches("http://").trim_end_matches('/').to_string();
        Api { host }
    }

    fn connect(&self) -> TcpStream {
        TcpStream::connect(&self.host).unwrap_or_else(|e| {
            eprintln!("Can't reach Quant Terminal at {} ({e}). Start it with npm start, or set QT_URL.", self.host);
            std::process::exit(1)
        })
    }

    /// One request. Writes carry the x-qt header the app requires. Returns (status, body).
    fn call(&self, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
        let mut s = self.connect();
        s.set_read_timeout(Some(Duration::from_secs(120))).ok();
        let body = body.unwrap_or("");
        let mut req = format!("{method} {path} HTTP/1.0\r\nHost: {}\r\nAccept: application/json\r\n", self.host);
        if method != "GET" {
            req += &format!("x-qt: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", body.len());
        }
        req += "\r\n";
        req += body;
        s.write_all(req.as_bytes()).expect("send request");
        let mut raw = String::new();
        s.read_to_string(&mut raw).expect("read response");
        let (head, payload) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
        let status = head.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        if status >= 400 {
            eprintln!("{method} {path} failed ({status}): {payload}");
            std::process::exit(1);
        }
        (status, payload.to_string())
    }

    fn get(&self, path: &str) -> String {
        self.call("GET", path, None).1
    }
    fn post(&self, path: &str, body: &str) -> String {
        self.call("POST", path, Some(body)).1
    }

    /// Print each alert as it fires, from the app's live event stream.
    fn listen(&self) {
        let mut s = self.connect();
        write!(s, "GET /api/events HTTP/1.0\r\nHost: {}\r\n\r\n", self.host).expect("send request");
        let mut event = String::new();
        for line in BufReader::new(s).lines().map_while(Result::ok) {
            if let Some(e) = line.strip_prefix("event:") {
                event = e.trim().to_string();
            } else if let Some(data) = line.strip_prefix("data:") {
                if event == "alert" {
                    println!("{}", field(data, "text").unwrap_or_else(|| data.to_string()));
                }
            }
        }
    }
}

/// The value of a "key": in a JSON object, good enough for an example's printout.
fn field(json: &str, key: &str) -> Option<String> {
    let start = json.find(&format!("\"{key}\":"))? + key.len() + 3;
    let rest = json[start..].trim_start();
    if let Some(r) = rest.strip_prefix('"') {
        return r.find('"').map(|e| r[..e].to_string());
    }
    let end = rest.find([',', '}', ']']).unwrap_or(rest.len());
    Some(rest[..end].trim().to_string())
}

fn main() {
    let api = Api::from_env();

    let health = api.get("/api/health");
    println!("Quant Terminal {} is running.", field(&health, "version").unwrap_or_default());

    let bars = api.get("/api/candles?symbol=BTCUSDT&tf=1h&limit=10"); // the API sends at least 10 bars
    println!("\nLast 3 hourly BTC bars from {}:", field(&bars, "provider").unwrap_or_default());
    let list = bars.split("\"candles\":[").nth(1).unwrap_or("").split(']').next().unwrap_or("");
    let chunks: Vec<&str> = list.split("},").collect();
    for c in &chunks[chunks.len().saturating_sub(3)..] {
        println!("  time {}  close {}", field(c, "time").unwrap_or_default(), field(c, "close").unwrap_or_default());
    }

    let strategy = r#"{
        "indicators": { "fast": { "id": "ema", "params": { "length": 9 } }, "slow": { "id": "ema", "params": { "length": 21 } } },
        "entryLong": [{ "left": "fast", "op": "crossesAbove", "right": "slow" }],
        "exitLong": [{ "left": "fast", "op": "crossesBelow", "right": "slow" }],
        "feePct": 0.1, "slippagePct": 0.05
    }"#;
    let bt = api.post(
        "/api/backtest",
        &format!(r#"{{ "symbol": "BTCUSDT", "tf": "1D", "limit": 1500, "strategy": {strategy}, "quantChecks": true }}"#),
    );
    let stats = bt.split("\"stats\":").nth(1).unwrap_or("");
    println!(
        "\nEMA 9/21 cross on BTCUSDT 1D: {} trades, net {}%, worst drop {}%",
        field(stats, "totalTrades").unwrap_or_default(),
        field(stats, "netProfitPct").unwrap_or_default(),
        field(stats, "maxDrawdownPct").unwrap_or_default()
    );
    let quant = bt.split("\"quantChecks\":").nth(1).unwrap_or("");
    println!(
        "Quant checks: passed {} of {}",
        field(quant, "passed").unwrap_or_default(),
        field(quant, "total").unwrap_or_default()
    );

    let alert = api.post(
        "/api/alerts",
        r#"{ "symbol": "BINANCE:BTCUSDT", "tf": "1h", "conditions": [{ "left": "close", "op": ">", "right": 0 }],
             "trigger": "once", "message": "Rust example: test alert" }"#,
    );
    let id = field(&alert, "id").expect("alert id");
    api.post("/api/alerts/check", "{}");
    let fired = api.get("/api/alerts/log").matches(&format!("\"alertId\":\"{id}\"")).count();
    println!("\nAdded alert {id}, it fired {fired} time(s). Deleting it.");
    api.call("DELETE", &format!("/api/alerts/{id}"), None);

    if std::env::args().any(|a| a == "--listen") {
        println!("\nListening for alerts (Ctrl+C to stop)...");
        api.listen();
    }
}
