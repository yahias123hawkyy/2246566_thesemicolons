/**
 * BROKER SERVICE — "The Forwarder"
 * Neutral Region component: no data processing, pure fan-out only.
 *
 * The simulator's SensorMeasurement DTO is: { timestamp, value }
 * It does NOT include sensor_id. The broker enriches each message with
 * the sensor_id before forwarding, so processors know which sensor it came from.
 *
 * Forwarded message schema: { sensor_id, timestamp, value }
 */

import { WebSocketServer, WebSocket } from 'ws';
import fetch from 'node-fetch';

const SIMULATOR_HTTP = process.env.SIMULATOR_HTTP || 'http://simulator:8080';
const SIMULATOR_WS   = process.env.SIMULATOR_WS   || 'ws://simulator:8080';
const BROKER_PORT    = parseInt(process.env.BROKER_PORT || '9000', 10);
const RETRY_INTERVAL = parseInt(process.env.RETRY_INTERVAL_MS || '5000', 10);

// ── Internal fan-out WebSocket server ────────────────────────────────────────
const wss = new WebSocketServer({ port: BROKER_PORT });
console.log(`[broker] Fan-out WS server listening on :${BROKER_PORT}`);

/** Broadcast a string payload to every connected processor replica. */
function broadcast(payload) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws, req) => {
  const addr = req.socket.remoteAddress;
  console.log(`[broker] Processor connected from ${addr}. Total: ${wss.clients.size}`);
  ws.on('close', () =>
    console.log(`[broker] Processor disconnected. Total: ${wss.clients.size}`)
  );
  ws.on('error', (err) =>
    console.error(`[broker] Client socket error: ${err.message}`)
  );
});

// ── Device discovery ──────────────────────────────────────────────────────────
// Returns array of SensorSummary objects:
// { id, name, category, region, coordinates, measurement_unit,
//   sampling_rate_hz, websocket_url }
async function fetchDevices() {
  const res = await fetch(`${SIMULATOR_HTTP}/api/devices/`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── Per-sensor WebSocket connection ───────────────────────────────────────────
function connectSensor(device) {
  // Use the websocket_url field from SensorSummary, but swap scheme to ws://
  // websocket_url is a path like /api/device/sensor-08/ws
  const wsPath = device.websocket_url;
  const url    = `${SIMULATOR_WS}${wsPath}`;
  const sid    = device.id;

  console.log(`[broker] Connecting to sensor ${sid} (${device.name}) at ${url}`);
  const ws = new WebSocket(url);

  ws.on('open',  () => console.log(`[broker] Sensor ${sid} stream open`));
  ws.on('error', (err) => console.error(`[broker] Sensor ${sid} error: ${err.message}`));
  ws.on('close', (code) => {
    console.warn(`[broker] Sensor ${sid} closed (${code}). Reconnecting in ${RETRY_INTERVAL}ms…`);
    setTimeout(() => connectSensor(device), RETRY_INTERVAL);
  });

  ws.on('message', (raw) => {
    // SensorMeasurement from simulator: { timestamp, value }
    // We enrich with sensor_id before broadcasting to processors.
    try {
      const measurement = JSON.parse(raw.toString());
      const enriched = JSON.stringify({
        sensor_id: sid,
        timestamp: measurement.timestamp,
        value:     measurement.value,
      });
      broadcast(enriched);
    } catch (err) {
      console.error(`[broker] Failed to parse measurement from ${sid}: ${err.message}`);
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  let devices = [];
  while (devices.length === 0) {
    try {
      devices = await fetchDevices();
      console.log(`[broker] Discovered ${devices.length} sensor(s):`);
      for (const d of devices) {
        console.log(`  - ${d.id} | ${d.name} | category=${d.category} | region=${d.region}`);
      }
    } catch (err) {
      console.error(`[broker] Could not reach simulator (${err.message}). Retrying in ${RETRY_INTERVAL}ms…`);
      await new Promise(r => setTimeout(r, RETRY_INTERVAL));
    }
  }

  for (const device of devices) {
    connectSensor(device);
  }
}

start();
