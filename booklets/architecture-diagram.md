# Architecture Diagram — Fragile Balance of Power

## Full System Architecture

```
╔══════════════════════════════════════════════════════════════════════╗
║                        NEUTRAL REGION                               ║
║   (only forwarding/routing services permitted here)                 ║
║                                                                     ║
║  ┌─────────────────────────┐    ┌──────────────────────────────┐    ║
║  │      SIMULATOR          │    │         BROKER               │    ║
║  │   seismic-signal-       │    │      (fan-out only)          │    ║
║  │   simulator:multiarch   │    │   node:20-slim  :9000        │    ║
║  │                         │    │                              │    ║
║  │  GET /api/devices/      │───▶│  ① fetch device list         │    ║
║  │  WS  /api/device/{id}/ws│───▶│  ② open WS per sensor        │    ║
║  │  GET /api/control (SSE) │    │  ③ broadcast to replicas     │    ║
║  │                         │    │                              │    ║
║  │  SAMPLING_RATE_HZ=20    │    │  No processing allowed.      │    ║
║  └─────────────┬───────────┘    └───────────────┬──────────────┘    ║
║                │                                │                   ║
╚════════════════╪════════════════════════════════╪═══════════════════╝
                 │ SSE control stream              │ WS fan-out
                 │ (shutdown commands)             │ (raw measurements)
                 │         ┌───────────────────────┤
                 │         │                       │
                 ▼         ▼                       ▼
       ┌─────────────────────────────────────────────────┐
       │           PROCESSING REPLICAS  (×3)             │
       │                                                 │
       │  ┌────────────┐ ┌────────────┐ ┌────────────┐  │
       │  │ processor1 │ │ processor2 │ │ processor3 │  │
       │  │  :3001     │ │  :3001     │ │  :3001     │  │
       │  │            │ │            │ │            │  │
       │  │ sliding    │ │ sliding    │ │ sliding    │  │
       │  │ window     │ │ window     │ │ window     │  │
       │  │    ↓       │ │    ↓       │ │    ↓       │  │
       │  │  fft-js    │ │  fft-js    │ │  fft-js    │  │
       │  │    ↓       │ │    ↓       │ │    ↓       │  │
       │  │ classify   │ │ classify   │ │ classify   │  │
       │  │    ↓       │ │    ↓       │ │    ↓       │  │
       │  │ /health    │ │ /health    │ │ /health    │  │
       │  │ /events    │ │ /events    │ │ /events    │  │
       │  │ /events/   │ │ /events/   │ │ /events/   │  │
       │  │  stream    │ │  stream    │ │  stream    │  │
       │  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘  │
       └────────┼──────────────┼──────────────┼──────────┘
                │              │              │
                └──────────────┼──────────────┘
                               │ insertOne()
                               │ unique index: (sensor_id, timestamp)
                               ▼
                     ┌─────────────────┐
                     │   MONGODB 7     │
                     │                 │
                     │  db: seismic    │
                     │  col: events    │
                     │                 │
                     │  {              │
                     │   sensor_id,   │
                     │   timestamp,   │
                     │   event_type,  │
                     │   dominant_    │
                     │    frequency,  │
                     │   replica_id,  │
                     │   detected_at  │
                     │  }             │
                     └─────────────────┘

       ┌────────────────────────────────────────┐
       │              GATEWAY  :8000            │
       │                                        │
       │  Health check loop (every 5s)          │
       │    GET processor{1,2,3}:3001/health    │
       │      → mark replica healthy/unhealthy  │
       │                                        │
       │  Round-robin load balancer             │
       │    /api/* → next healthy replica       │
       │                                        │
       │  Static file server                    │
       │    /* → public/index.html (SPA)        │
       │                                        │
       │  Replica status endpoint               │
       │    GET /gateway/replicas               │
       └────────────────┬───────────────────────┘
                        │ HTTP
                        ▼
              ┌──────────────────┐
              │    DASHBOARD     │
              │  (browser SPA)   │
              │                  │
              │  SSE live feed   │
              │  History table   │
              │  Replica status  │
              │  Event filters   │
              │  Stats panel     │
              └──────────────────┘
```

## Fault Tolerance Flow

```
Simulator                Replica N               Gateway              Dashboard
    │                       │                       │                     │
    │── SSE SHUTDOWN ───────▶│                       │                     │
    │                       │ log "Shutdown received"│                     │
    │                       │ process.exit(0)        │                     │
    │                       ✖ (container exits)      │                     │
    │                       │                       │                     │
    │                       │         (5s later)    │                     │
    │                       │                  health check fails          │
    │                       │                  replica.healthy = false     │
    │                       │                       │                     │
    │                       │                  round-robin skips N        │
    │                       │                       │                     │
    │                       │                  GET /gateway/replicas      │
    │                       │                       │─────────────────────▶│
    │                       │                       │  {healthy: false}    │
    │                       │                       │◀─────────────────────│
    │                       │                       │ render OFFLINE badge │
```

## Event Classification Rule Model

```
Raw measurement (mm/s) at 20 Hz
          │
          ▼
  Sliding window (64 samples)
          │
          │  window not full → discard
          │
          ▼
    FFT (fft-js)
    magnitudes[0..31]
          │
          ▼
  dominant_freq = peak_bin × 20 / 64
          │
          ├─── f < 0.5 Hz  ──────────────▶ DISCARD (noise)
          │
          ├─── 0.5 ≤ f < 3.0 Hz ─────────▶ EARTHQUAKE 🟡
          │
          ├─── 3.0 ≤ f < 8.0 Hz ─────────▶ EXPLOSION 🔴
          │
          └─── f ≥ 8.0 Hz ────────────────▶ NUCLEAR 🟣
                    │
                    ▼
          MongoDB insertOne()
          (sensor_id, timestamp) unique index
          duplicate? → silent discard
```
