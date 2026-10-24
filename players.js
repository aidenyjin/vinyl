// Talks to Apple Music and Spotify through AppleScript.
// Every function here is safe to call when an app is closed: we check that the
// process is running first, so we never launch an app just by looking at it.

import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const SEP = '\x1f';

export const APPS = {
  music: { name: 'Music', label: 'Apple Music' },
  spotify: { name: 'Spotify', label: 'Spotify' },
};

export class PermissionError extends Error {}

function run(file, args, input, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve(String(stdout).replace(/\n$/, ''));
    });
    if (input != null) child.stdin.end(input);
  });
}

async function osascript(script) {
  try {
    return await run('osascript', ['-'], script);
  } catch (err) {
    // -1743: the user has not allowed Terminal (or whatever runs node) to control the app.
    if (/-1743|not authori[sz]ed/i.test(err.stderr)) throw new PermissionError(err.stderr.trim());
    throw err;
  }
}

async function isRunning(app) {
  try {
    await run('pgrep', ['-x', APPS[app].name], null, 2000);
    return true;
  } catch {
    return false;
  }
}

const num = (s) => {
  const n = parseFloat(String(s ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

// Spotify sometimes answers with raw four-letter codes instead of words.
function normaliseState(s) {
  const v = String(s || '').trim();
  if (/kPSP/.test(v)) return 'playing';
  if (/kPSp/.test(v)) return 'paused';
  if (/kPSS/.test(v)) return 'stopped';
  if (v === 'fast forwarding' || v === 'rewinding') return 'playing';
  return v || 'stopped';
}

const MUSIC_STATUS = `
set sep to character id 31
tell application "Music"
  set st to player state as text
  if st is "stopped" then return "stopped"
  try
    set t to current track
  on error
    return "stopped"
  end try
  set nm to ""
  set ar to ""
  set al to ""
  set du to 0
  set po to 0
  set ac to 0
  try
    set nm to name of t
  end try
  try
    set ar to artist of t
  end try
  try
    set al to album of t
  end try
  try
    set du to round ((duration of t) * 1000)
  end try
  try
    set po to round ((player position) * 1000)
  end try
  try
    set ac to count of artworks of t
  end try
  if nm is "" then
    try
      set nm to current stream title
    end try
  end if
  set vo to sound volume
  return st & sep & nm & sep & ar & sep & al & sep & du & sep & po & sep & vo & sep & ac
end tell`;

const SPOTIFY_STATUS = `
set sep to character id 31
tell application "Spotify"
  set st to player state as text
  if st is "stopped" then return "stopped"
  try
    set t to current track
  on error
    return "stopped"
  end try
  set nm to name of t
  set ar to artist of t
  set al to album of t
  set du to duration of t
  set po to round ((player position) * 1000)
  set vo to sound volume
  set au to ""
  try
    set au to artwork url of t
  end try
  return st & sep & nm & sep & ar & sep & al & sep & du & sep & po & sep & vo & sep & au
end tell`;

function parseStatus(app, out) {
  const parts = out.split(SEP);
  const status = normaliseState(parts[0]);
  if (status === 'stopped' || parts.length < 8) return { app, status: 'stopped', track: null };
  const [, title, artist, album, duration, position, volume, extra] = parts;
  return {
    app,
    status,
    track: {
      title: title || 'Untitled',
      artist: artist || '',
      album: album || '',
      duration: num(duration) / 1000,
    },
    position: num(position) / 1000,
    volume: Math.round(num(volume)),
    artCount: app === 'music' ? num(extra) : 0,
    artUrl: app === 'spotify' ? extra : '',
  };
}

export async function readApp(app) {
  if (!(await isRunning(app))) return null;
  const out = await osascript(app === 'music' ? MUSIC_STATUS : SPOTIFY_STATUS);
  return parseStatus(app, out);
}

export function trackId(app, track) {
  return createHash('sha1')
    .update([app, track.title, track.artist, track.album].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

// ---------- commands ----------

const COMMANDS = {
  playpause: () => 'playpause',
  play: () => 'play',
  pause: () => 'pause',
  next: () => 'next track',
  previous: () => 'previous track',
  seek: (v) => `set player position to ${Math.max(0, Number(v) || 0).toFixed(2)}`,
  volume: (v) => `set sound volume to ${Math.round(Math.min(100, Math.max(0, Number(v) || 0)))}`,
};

export const ACTIONS = Object.keys(COMMANDS);

export async function command(app, action, value) {
  const make = COMMANDS[action];
  if (!make) throw new Error(`Unknown action: ${action}`);
  await osascript(`tell application "${APPS[app].name}" to ${make(value)}`);
}

// ---------- artwork ----------

const SNIFF = [
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0x47, 0x49, 0x46], 'image/gif'],
  [[0x52, 0x49, 0x46, 0x46], 'image/webp'],
];

function sniff(buf) {
  for (const [magic, type] of SNIFF) if (magic.every((b, i) => buf[i] === b)) return type;
  // Music sometimes hands back a TIFF wrapped picture; browsers can't show those.
  return null;
}

async function musicArtwork(expectedTitle) {
  const file = path.join(os.tmpdir(), `vinyl-art-${process.pid}-${Date.now()}`);
  const quoted = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
tell application "Music"
  set t to current track
  set nm to name of t
  set d to raw data of artwork 1 of t
end tell
set f to open for access (POSIX file "${quoted}") with write permission
try
  set eof of f to 0
  write d to f
  close access f
on error m
  try
    close access f
  end try
  error m
end try
return nm`;
  try {
    const name = await osascript(script);
    if (expectedTitle && name !== expectedTitle) return null; // the song changed under us
    const data = await readFile(file);
    const type = sniff(data);
    return type ? { type, data } : null;
  } catch (err) {
    if (err instanceof PermissionError) throw err;
    return null;
  } finally {
    unlink(file).catch(() => {});
  }
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = Buffer.from(await res.arrayBuffer());
  const type = sniff(data);
  return type ? { type, data } : null;
}

// Apple's public search API has artwork for most commercial releases.
async function searchArtwork(track) {
  const term = [track.artist, track.album || track.title].filter(Boolean).join(' ');
  if (!term) return null;
  const url = `https://itunes.apple.com/search?media=music&entity=album&limit=1&term=${encodeURIComponent(term)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const hit = (await res.json()).results?.[0];
  if (!hit?.artworkUrl100) return null;
  return download(hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/800x800bb.'));
}

export async function artwork(info) {
  let art = null;
  try {
    if (info.app === 'music' && info.artCount > 0) art = await musicArtwork(info.track.title);
    if (info.app === 'spotify' && info.artUrl) art = await download(info.artUrl);
  } catch (err) {
    if (err instanceof PermissionError) throw err;
  }
  if (!art) art = await searchArtwork(info.track).catch(() => null);
  return art;
}
