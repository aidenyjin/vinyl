#!/usr/bin/env node
// Vinyl's local helper. It serves the turntable page and tells it what your Mac
// is playing. Run it with `npm start`, then open http://localhost:4747.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS, ACTIONS, PermissionError, artwork, command, readApp, trackId } from './players.js';

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const IS_MAC = process.platform === 'darwin';
const POLL_MS = 1000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

// ---------- now playing ----------

let state = IS_MAC
  ? { ok: true, available: true, status: 'idle', source: null, track: null }
  : { ok: true, available: false, status: 'unsupported', message: 'Live mode needs macOS.' };
let lastSource = null;
const arts = new Map(); // id -> Promise<{type, data} | null>

function pick(infos) {
  const withTrack = infos.filter((i) => i && i.track);
  const playing = withTrack.filter((i) => i.status === 'playing');
  const pool = playing.length ? playing : withTrack;
  return pool.find((i) => i.app === lastSource) || pool[0] || null;
}

function rememberArt(id, info) {
  if (arts.has(id)) return;
  arts.set(id, artwork(info).catch(() => null));
  if (arts.size > 40) arts.delete(arts.keys().next().value);
}

async function poll() {
  if (!IS_MAC) return state;
  try {
    const infos = await Promise.all([readApp('music'), readApp('spotify')]);
    const info = pick(infos);
    if (!info) {
      const open = infos.some(Boolean);
      state = { ok: true, available: true, status: 'idle', source: open ? lastSource : null, track: null };
    } else {
      lastSource = info.app;
      const id = trackId(info.app, info.track);
      rememberArt(id, info);
      state = {
        ok: true,
        available: true,
        status: info.status,
        source: info.app,
        sourceLabel: APPS[info.app].label,
        track: { id, ...info.track, art: `api/artwork/${id}` },
        position: info.position,
        volume: info.volume,
      };
    }
  } catch (err) {
    state = err instanceof PermissionError
      ? { ok: true, available: true, status: 'permission', track: null, message: err.message }
      : { ok: true, available: true, status: 'error', track: null, message: String(err.message || err) };
  }
  state.at = Date.now();
  return state;
}

// ---------- live updates ----------

const clients = new Set();
let timer = null;

function broadcast() {
  const msg = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(msg);
}

async function tick() {
  await poll();
  broadcast();
  timer = clients.size ? setTimeout(tick, POLL_MS) : null;
}

function subscribe(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write(`retry: 2000\ndata: ${JSON.stringify(state)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
  if (!timer) tick();
}

// ---------- http ----------

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) {
        reject(new Error('Body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Only answer to our own page, so other websites can't skip your songs.
function trustedHost(req) {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') return true;
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

async function control(req, res) {
  if (req.headers['x-vinyl'] !== '1') return send(res, 403, { error: 'Missing x-vinyl header.' });
  if (!IS_MAC) return send(res, 409, { error: 'Live mode needs macOS.' });
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: 'Send JSON like {"action":"next"}.' });
  }
  if (!ACTIONS.includes(body.action)) return send(res, 400, { error: `Unknown action. Use one of: ${ACTIONS.join(', ')}.` });
  const source = state.source || lastSource;
  if (!source) return send(res, 409, { error: 'Nothing is playing in Music or Spotify.' });
  try {
    await command(source, body.action, body.value);
  } catch (err) {
    const code = err instanceof PermissionError ? 403 : 500;
    return send(res, code, { error: String(err.message || err) });
  }
  await new Promise((r) => setTimeout(r, 120));
  await poll();
  broadcast();
  send(res, 200, state);
}

async function serveArt(id, res) {
  const art = await (arts.get(id) || null);
  if (!art) return send(res, 404, { error: 'No artwork for this song.' });
  res.writeHead(200, { 'content-type': art.type, 'cache-control': 'private, max-age=86400' });
  res.end(art.data);
}

async function serveStatic(pathname, res) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return send(res, 400, 'Bad request', 'text/plain');
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  if (!trustedHost(req)) return send(res, 403, 'Forbidden', 'text/plain');
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/state' && req.method === 'GET') return send(res, 200, clients.size ? state : await poll());
    if (pathname === '/api/events' && req.method === 'GET') return subscribe(req, res);
    if (pathname === '/api/control' && req.method === 'POST') return await control(req, res);
    if (pathname.startsWith('/api/artwork/') && req.method === 'GET') return await serveArt(pathname.slice(13), res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(pathname, res);
    send(res, 405, 'Method not allowed', 'text/plain');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong in the helper.' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is busy. Is Vinyl already running? Try PORT=4848 npm start.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Vinyl is spinning at ${url}\n`);
  if (!IS_MAC) console.log('  This computer is not a Mac, so the page will play its demo playlist.\n');
  if (IS_MAC && !process.env.NO_OPEN) execFile('open', [url], () => {});
});
