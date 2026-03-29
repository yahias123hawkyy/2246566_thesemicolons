# LoFi Mockups — Seismic Command Dashboard
*Laboratory of Advanced Programming 2025/2026 · Hackathon · Group of 2*

---

## US-11 — Live Alert Feed
> As a military analyst, I want to see new seismic events appear in real time without refreshing.

```
┌─────────────────────────────────────────────────────────┐
│ ⬡ Seismic Command Dashboard          ● LIVE  12:34:56 UTC│
├──────────┬─────────────┬─────────────┬─────────┬────────┤
│ Total    │ Earthquakes │ Explosions  │ Nuclear │Replicas│
│   42     │     18      │     14      │   10    │  3/3   │
├──────────┴─────────────┴─────────────┴─────────┴────────┤
│ LIVE ALERTS   [All ✓] [Earthquake] [Explosion] [Nuclear] │
├─────────────────────────────────────────────────────────┤
│ [NUCL]  sensor-03   9.41 Hz                    12:34:56 │
│ [EXPL]  sensor-07   5.12 Hz                    12:34:51 │
│ [EQKE]  sensor-01   1.88 Hz                    12:34:47 │
│                    … more events …                       │
└─────────────────────────────────────────────────────────┘
```

*NFR: Events must appear within 2 seconds of detection. Real-time delivery via SSE.*

---

## US-13 — Event Filtering
> As a military analyst, I want to filter the live alert feed by event type.

```
┌─────────────────────────────────────────────────────────┐
│ ⬡ Seismic Command Dashboard — Filter: NUCLEAR only       │
├─────────────────────────────────────────────────────────┤
│ LIVE ALERTS   [All] [Earthquake] [Explosion] [Nuclear ✓] │
├─────────────────────────────────────────────────────────┤
│ [NUCL]  sensor-03   10.22 Hz                   12:34:56 │
│ [NUCL]  sensor-11    8.75 Hz                   12:33:02 │
│         Showing 2 of 42 events (NUCLEAR filter active)  │
└─────────────────────────────────────────────────────────┘
```

*NFR: Filtering is purely client-side (no server round-trip). Must update instantly on click.*

---

## US-12 — Historical Event Inspection
> As a military analyst, I want to browse the full history of detected events in a table.

```
┌─────────────────────────────────────────────────────────┐
│ ⬡ Event History — 42 rows                                │
├─────────────────────┬──────────┬───────────┬────────┬───┤
│ Timestamp (UTC)     │ Sensor   │ Type      │Freq Hz │Rep│
├─────────────────────┼──────────┼───────────┼────────┼───┤
│ 2026-03-28 12:34:56 │ sensor-03│ NUCLEAR   │ 9.4100 │ 2 │
│ 2026-03-28 12:34:51 │ sensor-07│ EXPLOSION │ 5.1250 │ 1 │
│ 2026-03-28 12:34:47 │ sensor-01│ EARTHQUAKE│ 1.8750 │ 3 │
│                  … older events …                        │
└─────────────────────────────────────────────────────────┘
```

*NFR: Loads last 100 events from REST on page open. New events prepend automatically via SSE.*

---

## US-14 — Replica Status Panel
> As a system administrator, I want to see the health status of each processing node.

```
┌─────────────────────────────────────────────────────────┐
│ ⬡ Processor Nodes                                        │
├─────────────────────────────────────────────────────────┤
│  ● processor1   ONLINE                                   │
│  ● processor2   OFFLINE                                  │
│  ● processor3   ONLINE                                   │
└─────────────────────────────────────────────────────────┘
```

*NFR: Status refreshes every 5 seconds via GET /gateway/replicas. OFFLINE state shown within one poll cycle of shutdown.*

---

## US-07 — Forced Shutdown — Admin Trigger
> As a system administrator, I want to manually trigger a shutdown command to test fault tolerance.

```
┌─────────────────────────────────────────────────────────┐
│ ⬡ Admin Controls                                         │
├─────────────────────────────────────────────────────────┤
│  Trigger Shutdown                                        │
│  [ ▶ Send SHUTDOWN Command ]                             │
│  → Sends POST /api/admin/shutdown to simulator           │
│  ✓ Shutdown sent at 12:35:01                             │
└─────────────────────────────────────────────────────────┘
```

*NFR: Button calls POST /admin/shutdown on gateway which proxies to simulator. Response shown inline.*

---

## US-01 / US-02 — Sensor Injection Panel
> As a system administrator, I want to manually inject a seismic event on a specific sensor.

```
┌─────────────────────────────────────────────────────────┐
│ ⬡ Admin Controls — Inject Sensor Event                   │
├─────────────────────────────────────────────────────────┤
│  Sensor                                                  │
│  [ sensor-01 — Field North Alpha              ▼ ]        │
│    sensor-03 — DC West Perimeter                         │
│    sensor-08 — DC North Perimeter                        │
├─────────────────────────────────────────────────────────┤
│  Event Type                                              │
│  [ earthquake                                 ▼ ]        │
│    conventional_explosion                                │
│    nuclear_like                                          │
│    calibration_pulse                                     │
│    datacenter_shutdown_disturbance                       │
├─────────────────────────────────────────────────────────┤
│  [ ▶ Inject Event ]                                      │
│  ✓ earthquake injected on sensor-01                      │
└─────────────────────────────────────────────────────────┘
```

*NFR: Sensor list populated dynamically from GET /api/devices/ on load. Injection proxied to simulator admin endpoint.*

---

## US-09 / US-10 — System Log + Connection Status
> As a system administrator, I want a running log of system events and connection state visible at all times.

```
┌─────────────────────────────────────────────────────────┐
│ ⬡ Seismic Command Dashboard                      ● LIVE │
├─────────────────────────────────────────────────────────┤
│ SYSTEM LOG                                               │
├─────────────────────────────────────────────────────────┤
│ 12:35:01  Manual shutdown triggered                      │
│ 12:35:00  ✗ processor2 OFFLINE                           │
│ 12:34:56  NUCLEAR | sensor-03 | 9.41 Hz                  │
│ 12:34:51  EXPLOSION | sensor-07 | 5.12 Hz                │
│ 12:34:00  Loaded 42 historical events                    │
│ 12:33:58  Live stream connected                          │
│ 12:33:57  Connecting to live event stream…               │
└─────────────────────────────────────────────────────────┘
```

*NFR: Log is prepended in real time. Kept to last 80 entries to avoid memory growth. No persistence (in-memory only).*

---

## US-15 — One-Command Deployment
> As a system administrator, I want to start the entire platform with a single command after loading the simulator image.

```
┌─────────────────────────────────────────────────────────┐
│ ⬡ Terminal — Deployment                                  │
├─────────────────────────────────────────────────────────┤
│ $ docker load -i seismic-signal-simulator-oci.tar        │
│   Loaded image: seismic-signal-simulator:multiarch_v1   │
│                                                          │
│ $ docker compose up --build                              │
│   [+] Building 3/3 services…                             │
│   [+] Running 7/7 containers…                            │
│ ✓ simulator   Started                                    │
│ ✓ mongo       Started                                    │
│ ✓ broker      Started                                    │
│ ✓ processor1  Started                                    │
│ ✓ processor2  Started                                    │
│ ✓ processor3  Started                                    │
│ ✓ gateway     Started                                    │
│                                                          │
│ → Dashboard:  http://localhost:8000                      │
│ → Simulator:  http://localhost:8080/docs                 │
└─────────────────────────────────────────────────────────┘
```

*NFR: No manual steps after docker compose up. Health checks ensure services start in dependency order.*
