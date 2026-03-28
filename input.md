# input.md — Fragile Balance of Power

## System Overview

A distributed, fault-tolerant seismic analysis platform built to provide continuous intelligence
to a command center operating under adversarial conditions. The system ingests real-time ground
vibration data from geographically distributed seismic sensors, performs frequency-domain
analysis to classify seismic events, persists detected events durably, and surfaces them on a
real-time dashboard — even when individual processing nodes are forcibly terminated.

**Team size:** 2 students  
**Expected user stories:** 15

---

## Actors

| Actor | Description |
|-------|-------------|
| **Military Analyst** | Primary dashboard user; monitors live alerts and history |
| **System Administrator** | Oversees replica health, deployment, and recovery |
| **Seismic Sensor** | Physical device; produces raw vibration readings at 20 Hz |
| **Processing Replica** | Automated service that classifies seismic signals |

---

## User Stories

### US-01 · Sensor Ingestion
**As a** system,  
**I want to** automatically discover all active seismic sensors at startup,  
**so that** no manual configuration is needed when new sensors are deployed.

**Acceptance criteria:**
- On startup, broker calls `GET /api/devices/` and connects to each sensor's WebSocket.
- If the simulator is temporarily unavailable, the broker retries every 5 seconds.

---

### US-02 · Real-Time Data Fan-Out
**As a** processing replica,  
**I want to** receive every raw sensor measurement from the broker,  
**so that** I can analyse the data without connecting directly to the simulator.

**Acceptance criteria:**
- Broker re-broadcasts each measurement (unchanged) to every connected replica.
- No data transformation or processing occurs inside the broker.

---

### US-03 · Sliding Window Analysis
**As a** processing replica,  
**I want to** accumulate the last N samples for each sensor in a sliding window,  
**so that** I always analyse the most recent signal segment.

**Acceptance criteria:**
- Window size is configurable via `WINDOW_SIZE` (default 64, must be power of 2).
- Older samples are dropped as new ones arrive once the window is full.

---

### US-04 · Frequency-Domain Analysis
**As a** processing replica,  
**I want to** apply an FFT on each full sliding window,  
**so that** I can identify the dominant frequency component of the seismic signal.

**Acceptance criteria:**
- FFT is performed using the `fft-js` library.
- Dominant frequency is computed as `(peak_bin_index × sampling_rate) / window_size`.

---

### US-05 · Event Classification
**As a** processing replica,  
**I want to** classify each analysed window into an event type,  
**so that** analysts can immediately understand the nature of the detected threat.

**Acceptance criteria:**

| Dominant Frequency | Event Type |
|-------------------|------------|
| 0.5 Hz ≤ f < 3.0 Hz | `EARTHQUAKE` |
| 3.0 Hz ≤ f < 8.0 Hz | `EXPLOSION` |
| f ≥ 8.0 Hz | `NUCLEAR` |

- Windows with dominant frequency below 0.5 Hz are not persisted.

---

### US-06 · Duplicate-Safe Event Persistence
**As a** system,  
**I want to** store detected events in MongoDB with a unique index on `(sensor_id, timestamp)`,  
**so that** replicas processing identical inputs do not create duplicate records.

**Acceptance criteria:**
- Duplicate key errors (code 11000) are silently discarded.
- All other write errors are logged.

---

### US-07 · Forced Shutdown Compliance
**As a** processing replica,  
**I want to** listen to the simulator's SSE control stream and terminate immediately on `SHUTDOWN`,  
**so that** the fault-tolerance simulation is accurate.

**Acceptance criteria:**
- Replica subscribes to `GET /api/control` on startup.
- On receiving `{"command":"SHUTDOWN"}`, logs "Shutdown received" and calls `process.exit(0)`.

---

### US-08 · Automatic Replica Recovery
**As a** system,  
**I want** Docker Compose to automatically restart a crashed processing replica,  
**so that** the platform self-heals without manual intervention.

**Acceptance criteria:**
- `restart: on-failure` is set for all processor services.
- A terminated replica is back online within seconds.

---

### US-09 · Health-Aware Load Balancing
**As a** dashboard user,  
**I want** the gateway to route requests only to healthy replicas,  
**so that** my queries never reach a dead node.

**Acceptance criteria:**
- Gateway polls each replica's `/health` endpoint every 5 seconds.
- Failed replicas are excluded from the round-robin pool instantly.
- Requests return `503` only if all replicas are simultaneously down.

---

### US-10 · Single Entry Point
**As a** military analyst,  
**I want** a single URL to access all system features,  
**so that** I do not need to know the internal topology.

**Acceptance criteria:**
- All API calls go through `http://localhost:8000/api/*`.
- The dashboard is served at `http://localhost:8000/`.

---

### US-11 · Live Alert Feed
**As a** military analyst,  
**I want** to see new seismic events appear on the dashboard in real time without refreshing,  
**so that** I can react to threats immediately.

**Acceptance criteria:**
- Dashboard subscribes to `/api/events/stream` (SSE).
- Each new event card appears at the top of the alert feed within 2 seconds of detection.

---

### US-12 · Historical Event Inspection
**As a** military analyst,  
**I want** to browse the full history of detected events in a table,  
**so that** I can investigate patterns over time.

**Acceptance criteria:**
- Dashboard calls `GET /api/events?limit=100` on load.
- History table shows: timestamp, sensor ID, event type, dominant frequency, replica ID.

---

### US-13 · Event Filtering
**As a** military analyst,  
**I want** to filter the live alert feed by event type,  
**so that** I can focus on the most critical threats (e.g., NUCLEAR only).

**Acceptance criteria:**
- Filter buttons: ALL, EARTHQUAKE, EXPLOSION, NUCLEAR.
- Switching filters immediately re-renders the visible alert cards without a server round-trip.

---

### US-14 · Replica Status Panel
**As a** system administrator,  
**I want** to see the health status of each processing node on the dashboard,  
**so that** I know when a replica has been shut down by the simulator.

**Acceptance criteria:**
- Dashboard polls `GET /gateway/replicas` every 5 seconds.
- Each node shows: hostname, ONLINE / OFFLINE status.

---

### US-15 · Infrastructure-as-Code Deployment
**As a** system administrator,  
**I want** the entire platform to start with a single command,  
**so that** deployment is reproducible on any machine.

**Acceptance criteria:**
- After `docker load -i seismic-signal-simulator-oci.tar`, running `docker compose up --build` starts all services.
- No manual steps are required after that command.

---

## Standard Event Schema

### Simulator wire format (`SensorMeasurement`)
The simulator WebSocket emits messages **without** a sensor identifier:
```json
{ "timestamp": "2026-03-25T00:00:00.000000+00:00", "value": 0.123456 }
```
The broker enriches each message with `sensor_id` (from `SensorSummary.id`) before broadcasting:
```json
{ "sensor_id": "sensor-08", "timestamp": "2026-03-25T00:00:00.000000+00:00", "value": 0.123456 }
```

### Persisted event document (MongoDB collection: `events`)
```json
{
  "_id":                "<ObjectId — auto-generated by MongoDB>",
  "sensor_id":          "<string — matches SensorSummary.id>",
  "timestamp":          "<ISODate — last sample timestamp in the window>",
  "dominant_frequency": "<number — Hz, rounded to 4 decimal places>",
  "event_type":         "<string — EARTHQUAKE | EXPLOSION | NUCLEAR>",
  "replica_id":         "<string — identifies which replica wrote the document>",
  "detected_at":        "<ISODate — wall-clock time of detection>"
}
```

**Unique index:** `{ sensor_id: 1, timestamp: 1 }` (idempotency guarantee)

---

## Rule Model

| Rule ID | Condition | Action |
|---------|-----------|--------|
| R-01 | Window is full (`samples.length === WINDOW_SIZE`) | Trigger FFT analysis |
| R-02 | `dominant_frequency < 0.5 Hz` | Discard — not classified |
| R-03 | `0.5 ≤ dominant_frequency < 3.0` | Classify as `EARTHQUAKE` |
| R-04 | `3.0 ≤ dominant_frequency < 8.0` | Classify as `EXPLOSION` |
| R-05 | `dominant_frequency ≥ 8.0` | Classify as `NUCLEAR` |
| R-06 | MongoDB duplicate key error (code 11000) | Silently discard duplicate |
| R-07 | Control stream emits `{"command":"SHUTDOWN"}` | `process.exit(0)` immediately |
| R-08 | Replica `/health` returns non-200 or times out | Exclude from routing pool |
| R-09 | Excluded replica's `/health` returns 200 | Re-include in routing pool |
