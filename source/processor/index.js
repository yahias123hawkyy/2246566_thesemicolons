/**
 * PROCESSING SERVICE — "The Brain"
 * Replicated; subject to forced shutdown from the simulator control stream.
 *
 * Responsibilities:
 *  1. Connect to the Broker fan-out WS and receive raw measurements.
 *  2. Listen to the simulator SSE control stream; obey SHUTDOWN commands.
 *  3. Maintain per-sensor sliding windows.
 *  4. Run FFT on each window fill and classify the dominant frequency.
 *  5. Persist detected events to MongoDB (idempotent via unique index).
 *  6. Expose a /health and /events HTTP endpoint for the Gateway.
 *  7. Expose an SSE endpoint /events/stream for real-time push to Gateway.
 */

import http from 'http';
import { WebSocket } from 'ws';
import { MongoClient } from 'mongodb';
import EventSource from 'eventsource';
import FFT from 'fft-js';

// ── Configuration ─────────────────────────────────────────────────────────────
const BROKER_WS       = process.env.BROKER_WS      || 'ws://broker:9000';
const SIMULATOR_HTTP  = process.env.SIMULATOR_HTTP || 'http://simulator:8080';
const MONGO_URI       = process.env.MONGO_URI      || 'mongodb://mongo:27017/seismic';
const PORT            = parseInt(process.env.PORT  || '3001', 10);
const SAMPLING_RATE   = parseInt(process.env.SAMPLING_RATE_HZ || '20', 10);
const WINDOW_SIZE     = parseInt(process.env.WINDOW_SIZE || '64', 10); // must be power of 2
const REPLICA_ID      = process.env.REPLICA_ID     || `proc-${process.pid}`;

console.log(`[processor:${REPLICA_ID}] Starting on port ${PORT}`);

// ── MongoDB setup ─────────────────────────────────────────────────────────────
let eventsCollection;

async function connectDB() {
  while (true) {
    try {
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      const db = client.db();
      eventsCollection = db.collection('events');
      // Unique compound index → idempotent duplicate prevention
      await eventsCollection.createIndex(
        { sensor_id: 1, timestamp: 1 },
        { unique: true, name: 'sensor_ts_unique' }
      );
      console.log(`[processor:${REPLICA_ID}] MongoDB connected`);
      return;
    } catch (err) {
      console.error(`[processor:${REPLICA_ID}] MongoDB error: ${err.message}. Retrying…`);
      await sleep(3000);
    }
  }
}

// ── Sliding windows ───────────────────────────────────────────────────────────
// Map<sensorId, { samples: number[], timestamps: number[] }>
const windows = new Map();

function getWindow(sensorId) {
  if (!windows.has(sensorId)) {
    windows.set(sensorId, { samples: [], timestamps: [] });
  }
  return windows.get(sensorId);
}

// ── FFT + Classification ──────────────────────────────────────────────────────
function classifyDominantFreq(f) {
  if (f >= 0.5 && f < 3.0)  return 'EARTHQUAKE';
  if (f >= 3.0 && f < 8.0)  return 'EXPLOSION';
  if (f >= 8.0)              return 'NUCLEAR';
  return null; // below 0.5 Hz → not classified
}

/**
 * Runs FFT on `samples` (length must be power of 2).
 * Returns the dominant frequency in Hz.
 */
function dominantFrequency(samples, samplingRate) {
  const phasors = FFT.fft(samples);
  const magnitudes = FFT.util.fftMag(phasors);
  // Only look at positive frequencies (first half)
  const half = Math.floor(magnitudes.length / 2);
  let maxMag = -Infinity;
  let maxIdx = 0;
  for (let i = 1; i < half; i++) {
    if (magnitudes[i] > maxMag) {
      maxMag = magnitudes[i];
      maxIdx = i;
    }
  }
  // frequency resolution = samplingRate / N
  return (maxIdx * samplingRate) / samples.length;
}

// ── SSE subscribers for real-time push ───────────────────────────────────────
const sseClients = new Set();

function pushEvent(eventDoc) {
  const data = `data: ${JSON.stringify(eventDoc)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch (_) { sseClients.delete(res); }
  }
}

// ── Process a raw measurement ─────────────────────────────────────────────────
// Incoming message (enriched by broker): { sensor_id, timestamp, value }
// sensor_id: string (e.g. "sensor-08")
// timestamp: ISO-8601 string e.g. "2026-03-25T00:00:00.000000+00:00"
// value: number (mm/s)
async function processMeasurement(msg) {
  let parsed;
  try { parsed = JSON.parse(msg); } catch { return; }

  const { sensor_id, timestamp, value } = parsed;
  if (sensor_id === undefined || timestamp === undefined || value === undefined) return;

  const win = getWindow(sensor_id);
  win.samples.push(value);
  win.timestamps.push(timestamp);

  // Keep window at fixed size (sliding)
  if (win.samples.length > WINDOW_SIZE) {
    win.samples.shift();
    win.timestamps.shift();
  }

  // Only analyse when we have a full window
  if (win.samples.length < WINDOW_SIZE) return;

  const domFreq  = dominantFrequency([...win.samples], SAMPLING_RATE);
  const eventType = classifyDominantFreq(domFreq);
  if (!eventType) return;

  // Use the timestamp of the LAST sample in the window as the event timestamp.
  // new Date() correctly parses ISO-8601 with timezone offset.
  const eventTimestamp = new Date(timestamp);

  const eventDoc = {
    sensor_id,
    timestamp:          eventTimestamp,
    dominant_frequency: parseFloat(domFreq.toFixed(4)),
    event_type:         eventType,
    replica_id:         REPLICA_ID,
    detected_at:        new Date(),
  };

  // Idempotent insert — E11000 duplicate key → silently discard
  try {
    await eventsCollection.insertOne(eventDoc);
    console.log(`[processor:${REPLICA_ID}] ${eventType} @ ${domFreq.toFixed(2)} Hz (sensor ${sensor_id})`);
    pushEvent(eventDoc);
  } catch (err) {
    if (err.code !== 11000) {
      console.error(`[processor:${REPLICA_ID}] DB insert error: ${err.message}`);
    }
  }
}

// ── Broker WebSocket connection ───────────────────────────────────────────────
function connectBroker() {
  console.log(`[processor:${REPLICA_ID}] Connecting to broker at ${BROKER_WS}`);
  const ws = new WebSocket(BROKER_WS);

  ws.on('open',    () => console.log(`[processor:${REPLICA_ID}] Broker WS open`));
  ws.on('message', (raw) => processMeasurement(raw.toString()));
  ws.on('error',   (err) => console.error(`[processor:${REPLICA_ID}] Broker error: ${err.message}`));
  ws.on('close',   (code) => {
    console.warn(`[processor:${REPLICA_ID}] Broker closed (${code}). Reconnecting…`);
    setTimeout(connectBroker, 3000);
  });
}

// ── Control stream (SSE from simulator) ──────────────────────────────────────
// SSE event types per API contract: control-open, heartbeat, command
function connectControlStream() {
  const url = `${SIMULATOR_HTTP}/api/control`;
  console.log(`[processor:${REPLICA_ID}] Listening to control stream at ${url}`);
  const es = new EventSource(url);

  // Fired once when the stream is first established
  es.addEventListener('control-open', (e) => {
    try {
      const payload = JSON.parse(e.data);
      console.log(`[processor:${REPLICA_ID}] Control stream open. Total listeners: ${payload.controlStreamConnections}`);
    } catch { /* ignore */ }
  });

  // Periodic keepalive — just log at debug level
  es.addEventListener('heartbeat', (e) => {
    try {
      const payload = JSON.parse(e.data);
      console.log(`[processor:${REPLICA_ID}] ♥ heartbeat. Listeners: ${payload.controlStreamConnections}`);
    } catch { /* ignore */ }
  });

  // The shutdown command — exactly one listener receives this
  es.addEventListener('command', (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.command === 'SHUTDOWN') {
        console.log(`[processor:${REPLICA_ID}] Shutdown received`);
        process.exit(0);
      }
    } catch { /* ignore malformed */ }
  });

  es.onerror = (err) => {
    console.error(`[processor:${REPLICA_ID}] Control SSE error:`, err.message ?? err);
  };
}

// ── HTTP server (health + events REST + events SSE) ──────────────────────────
function startHTTP() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // CORS for dashboard
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', replica: REPLICA_ID }));
      return;
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      // REST: recent events with optional filters
      const filter = {};
      if (url.searchParams.get('sensor_id')) filter.sensor_id = url.searchParams.get('sensor_id');
      if (url.searchParams.get('event_type')) filter.event_type = url.searchParams.get('event_type');
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      try {
        const docs = await eventsCollection
          .find(filter)
          .sort({ detected_at: -1 })
          .limit(limit)
          .toArray();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(docs));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === '/events/stream') {
      // SSE real-time push
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, () =>
    console.log(`[processor:${REPLICA_ID}] HTTP on :${PORT}`)
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Boot ──────────────────────────────────────────────────────────────────────
await connectDB();
startHTTP();
connectBroker();
connectControlStream();
