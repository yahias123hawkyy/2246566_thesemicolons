# Student_doc.md — Deployed System Specification

## Project: Fragile Balance of Power
**Course:** Laboratory of Advanced Programming 2025/2026  
**Exam:** Hackathon — March 28, 2026  
**Institution:** Sapienza Università di Roma  

---

## 1. Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Node.js 20 (ES Modules) | Native async I/O, excellent WebSocket/SSE support |
| FFT library | `fft-js` ^0.0.12 | Lightweight, pure-JS, no native bindings required |
| Database driver | `mongodb` ^6.6.0 | Official driver with full duplicate-key error semantics |
| HTTP client | Built-in `node:http` | No external dependency for health checks and proxying |
| WebSocket | `ws` ^8.17.0 | Industry-standard for Node.js WebSocket server/client |
| SSE client | `eventsource` ^2.0.2 | Standards-compliant SSE client (replaces `EventSource` polyfill) |
| Database | MongoDB 7 | Schema-flexible, horizontal-friendly, atomic index enforcement |
| Containerisation | Docker + Compose v2 | Single-command reproducibility |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                  NEUTRAL REGION (no processing)                 │
│                                                                 │
│  ┌──────────────┐   ┌──────────────────────────────────────┐   │
│  │   Simulator  │──▶│   Broker  (fan-out WS :9000)         │   │
│  │  :8080       │   │   • Discovers devices                │   │
│  │  WS sensors  │   │   • Connects to all sensor WS feeds  │   │
│  │  SSE control │   │   • Broadcasts raw msgs to replicas  │   │
│  └──────────────┘   └──────────┬───────────────────────────┘   │
│         │                      │ WebSocket fan-out              │
│         │ SSE /api/control      ▼                               │
└─────────┼─────────────────────────────────────────────────────-┘
          │         ┌────────────────────────────────────┐
          │         │  Processing Replicas (3×)          │
          ├────────▶│  processor1  processor2  processor3│
          │         │  :3001       :3001       :3001     │
          │         │  • Sliding window per sensor       │
          │         │  • FFT + classification            │
          │         │  • Idempotent MongoDB write        │
          │         │  • /health  /events  /events/stream│
          │         └────────────────┬───────────────────┘
          │                          │ writes (unique index)
          │                   ┌──────▼──────┐
          │                   │  MongoDB 7  │
          │                   │  events col │
          │                   └─────────────┘
          │
          │         ┌─────────────────────────────────────┐
          │         │  Gateway  :8000                     │
          │         │  • Round-robin load balancer        │
          │         │  • Health-aware routing             │
          │         │  • Serves static dashboard          │
          │         │  • Proxies /api/* to live replicas  │
          │         └───────────────┬─────────────────────┘
          │                         │ HTTP
          │                  ┌──────▼──────┐
          │                  │  Browser    │
          │                  │  Dashboard  │
          │                  └─────────────┘
```

---

## 3. Component Descriptions

### 3.1 Simulator (provided)
Pre-built Docker image. Exposes:
- `GET /api/devices/` — device list
- `WS /api/device/{id}/ws` — per-sensor 20 Hz measurement stream
- `GET /api/control` — SSE control stream (emits `SHUTDOWN` commands)

### 3.2 Broker
The only component permitted in the neutral region.

**Key design decisions:**
- Implements a WebSocket *server* (port 9000) that processing replicas connect to.
- Implements WebSocket *clients* toward each simulator sensor.
- Zero data transformation: raw JSON bytes are forwarded byte-for-byte.
- Sensor disconnection triggers exponential-style reconnect with 5 s fixed backoff.
- Replica disconnection is handled gracefully (client removed from broadcast set).

### 3.3 Processing Service (replicated ×3)
Each replica is a stateful microservice:

| Concern | Implementation |
|---------|---------------|
| Sliding window | `Map<sensor_id, {samples: number[], timestamps: string[]}>` in memory |
| FFT | `fft-js` — operates on copy of window array (non-destructive) |
| Dominant bin | Peak magnitude index in positive-frequency half (bins 1 … N/2-1) |
| Frequency resolution | `Δf = sampling_rate / window_size = 20/64 ≈ 0.3125 Hz` |
| Idempotency | `insertOne` wrapped in try/catch; error code 11000 silently ignored |
| SSE push | Replica maintains a `Set<ServerResponse>` for live dashboard consumers |
| Sensor ID source | `SensorMeasurement` has no `sensor_id`; broker injects it from `SensorSummary.id` |

### 3.4 Gateway
Single entry point. No state beyond replica health flags.

**Routing rules:**
1. `GET /gateway/health` — gateway own liveness
2. `GET /gateway/replicas` — JSON list of replicas with health status
3. `GET|POST /admin/*` — proxied to simulator admin endpoints (shutdown, event injection, device list)
4. `GET /api/*` — proxied round-robin to a healthy replica (strips `/api` prefix)
5. Everything else — served from `public/` directory (dashboard SPA)

The simulator exposes three SSE event types on `GET /api/control`: `control-open` (fired once on connect, carries `controlStreamConnections`), `heartbeat` (periodic keepalive), and `command` (carries `{"command":"SHUTDOWN"}`). Only `command` triggers `process.exit(0)`.

**Health check loop:** runs every 5 s; calls `GET /health` on each replica with 3 s timeout.

### 3.5 MongoDB
Single instance (assumed reliable per spec). The unique compound index:

```js
{ sensor_id: 1, timestamp: 1 }  // unique: true
```

This is the sole mechanism ensuring that when multiple replicas receive and FFT the same sensor window, only one event document survives — the first writer wins, subsequent inserts are silently rejected.

### 3.6 Dashboard
Single-page application served by the gateway. Purely client-side JavaScript (no framework dependency). Three live data sources:
1. `GET /api/events?limit=100` — initial history load on page open.
2. `GET /api/events/stream` (SSE) — incremental live push for new events.
3. `GET /gateway/replicas` — polled every 5 s for replica status panel.

---

## 4. Fault Tolerance: The Forced Shutdown Flow

This is the most operationally critical behaviour in the system.

### 4.1 Shutdown sequence (step-by-step)

```
Simulator control stream
        │
        │  SSE event: data: {"command":"SHUTDOWN"}
        ▼
Processor replica (one random listener)
        │
        │  1. eventsource library fires 'command' event handler
        │  2. JSON.parse(e.data).command === 'SHUTDOWN' → true
        │  3. console.log("Shutdown received")
        │  4. process.exit(0)   ← immediate, no cleanup
        ▼
Docker Engine
        │  5. Detects container exit (code 0)
        │  6. restart: on-failure  →  does NOT restart on exit 0
        │     (clean exit is treated as intentional)
```

> **Note on restart policy:** The spec says a shutdown means the replica must *terminate itself*. Using `restart: on-failure` means a clean `process.exit(0)` will **not** be automatically restarted. This accurately simulates a destroyed data center node. If recovery is desired for demo purposes, change the policy to `restart: always`.

### 4.2 Gateway response to shutdown

Within the next health-check cycle (≤ 5 s):
1. Gateway's `healthLoop()` detects the now-dead container.
2. `replica.healthy` is set to `false`.
3. `nextHealthy()` excludes it from the round-robin pool.
4. All subsequent API requests are served by the two remaining replicas.
5. The dashboard's replica status panel reflects OFFLINE within the same poll interval.

### 4.3 Broker resilience

The broker's WebSocket server continues to broadcast to the two surviving replicas. The closed connection from the terminated replica is automatically removed from `wss.clients` by the `ws` library.

### 4.4 Idempotency under replica reduction

If replicas 1 and 2 both process the same sensor window after replica 3 goes down, the `(sensor_id, timestamp)` unique index still guarantees exactly one event document persists. The first `insertOne` succeeds; the second throws `MongoServerError: E11000` which is caught and discarded.

---

## 5. Data Flow Diagram (per measurement)

```
Sensor (20 Hz)
    │ raw JSON: { sensor_id, timestamp, value }
    ▼
Broker WebSocket server
    │ broadcast to all connected replicas
    ├──────────────────────────────────┐
    ▼                                  ▼
Replica 1                         Replica 2  (Replica 3 if alive)
    │ push value to sliding window     │
    │ if window full:                  │
    │   FFT → dominant freq            │
    │   classify → event_type          │
    │   insertOne(event)               │
    │     ├─ success → push SSE        │
    │     └─ E11000  → discard         │
    ▼                                  ▼
MongoDB events collection (shared)
    │ unique index prevents duplicates
    ▼
Gateway /api/events/stream (SSE)
    ▼
Dashboard (browser)
```

---

## 6. Environment Variables

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| `SIMULATOR_HTTP` | broker | `http://simulator:8080` | Simulator base URL |
| `SIMULATOR_WS` | broker | `ws://simulator:8080` | Simulator WS base URL |
| `BROKER_PORT` | broker | `9000` | Fan-out WS listen port |
| `RETRY_INTERVAL_MS` | broker | `5000` | Reconnect delay |
| `BROKER_WS` | processor | `ws://broker:9000` | Broker address |
| `MONGO_URI` | processor | `mongodb://mongo:27017/seismic` | MongoDB connection |
| `PORT` | processor | `3001` | HTTP listen port |
| `SAMPLING_RATE_HZ` | processor | `20` | Must match simulator |
| `WINDOW_SIZE` | processor | `64` | FFT window (power of 2) |
| `REPLICA_ID` | processor | `proc-<PID>` | Replica identifier |
| `PROCESSOR_URLS` | gateway | `http://processor1:3001,...` | Comma-separated replica list |
| `HEALTH_INTERVAL_MS` | gateway | `5000` | Health check frequency |
| `PORT` | gateway | `8000` | Dashboard/API listen port |

---

## 7. How to Run

```bash
# Step 1 — Load the simulator image (provided separately)
docker load -i seismic-signal-simulator-oci.tar

# Step 2 — Build and start everything
docker compose up --build

# Dashboard
open http://localhost:8000

# Simulator API docs
open http://localhost:8080/docs

# Trigger a manual shutdown (for testing)
curl -X POST http://localhost:8080/api/control/shutdown
```

---

## 8. Repository Structure

```
.
├── input.md
├── Student_doc.md
├── docker-compose.yml
├── source/
│   ├── broker/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── index.js
│   ├── processor/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── index.js
│   └── gateway/
│       ├── Dockerfile
│       ├── package.json
│       ├── index.js
│       └── public/
│           └── index.html
└── booklets/
    └── architecture-diagram.md
```
