// The cover's depth. macOS finds the subject of the cover (subject.swift) and the page lifts
// it a little off the sleeve. The helper is built with the Xcode command line tools the first
// time it's needed and kept in ~/Library/Caches/Vinyl. Without those tools covers stay flat.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'subject.swift');
const CACHE = path.join(os.homedir(), 'Library', 'Caches', 'Vinyl');
const HELPER = path.join(CACHE, 'subject');

const run = (file, args, timeout) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout }, (err) => (err ? reject(err) : resolve()));
});

let built = null;
export function buildHelper() {
  built ??= (async () => {
    try {
      if ((await stat(HELPER)).mtimeMs >= (await stat(SOURCE)).mtimeMs) return HELPER;
    } catch {}
    // Asking for swiftc without the tools opens an installer dialog, so check first.
    await run('/usr/bin/xcode-select', ['-p'], 5000);
    await mkdir(CACHE, { recursive: true });
    await run('/usr/bin/xcrun', ['swiftc', '-O', SOURCE, '-o', HELPER], 180000);
    return HELPER;
  })().catch(() => null);
  return built;
}

// art is { type, data } from players.js; the result is a PNG mask, or null when there's no subject.
export async function subjectMask(art) {
  const helper = await buildHelper();
  if (!helper || !art) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vinyl-'));
  try {
    const cover = path.join(dir, 'cover'), mask = path.join(dir, 'mask.png');
    await writeFile(cover, art.data);
    await run(helper, [cover, mask], 20000);
    return await readFile(mask);
  } catch {
    return null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
