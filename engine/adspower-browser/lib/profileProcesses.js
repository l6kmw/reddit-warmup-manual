'use strict';

/**
 * Profile-specific browser process inspection and last-resort cleanup.
 *
 * AdsPower can occasionally forget an open profile: /browser/active then says
 * Inactive and /browser/stop says "User_id is not open", while its SunBrowser
 * process and window are still alive. This module never scans by account name or
 * serial. It only matches the unique AdsPower user-data cache prefix for one
 * profile id, and callers must only use it for profiles they started themselves.
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);

function assertProfileId(profileId) {
  const value = String(profileId ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('profileId 含不支持的字符');
  }
  return value;
}

function parsePsOutput(stdout, profileId) {
  const id = assertProfileId(profileId);
  const markers = [`/cache/${id}_`, `\\cache\\${id}_`];
  const browserProcess = /(?:SunBrowser|chrome(?:\.exe)?|chromium|chrome_crashpad_handler)/i;
  const rows = [];

  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[3];
    if (!markers.some((marker) => command.includes(marker))) continue;
    if (!browserProcess.test(command)) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command });
  }
  return rows;
}

function createProfileProcessController({
  platform = process.platform,
  runPs = async () => (await execFileAsync('ps', ['ax', '-o', 'pid=,ppid=,command='], {
    maxBuffer: 8 * 1024 * 1024,
  })).stdout,
  kill = process.kill.bind(process),
  wait = sleep,
} = {}) {
  const supported = SUPPORTED_PLATFORMS.has(platform);

  async function list(profileId) {
    if (!supported) return null;
    return parsePsOutput(await runPs(), profileId);
  }

  async function isRunning(profileId) {
    const rows = await list(profileId);
    return rows == null ? null : rows.length > 0;
  }

  function signal(rows, signal) {
    for (const row of rows) {
      try {
        kill(row.pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  }

  async function waitUntilGone(profileId, attempts, intervalMs) {
    let rows = await list(profileId);
    for (let attempt = 0; rows?.length && attempt < attempts; attempt += 1) {
      await wait(intervalMs);
      rows = await list(profileId);
    }
    return rows;
  }

  async function terminate(profileId, {
    termAttempts = 10,
    killAttempts = 10,
    intervalMs = 250,
  } = {}) {
    let rows = await list(profileId);
    if (rows == null) return { supported: false, found: 0, remaining: null, forced: false };
    const found = rows.length;
    if (!found) return { supported: true, found: 0, remaining: 0, forced: false };

    // Signal roots first so Chromium can flush profile state. Helpers are only
    // signalled directly if the parent fails to reap them.
    const matchingPids = new Set(rows.map((row) => row.pid));
    const roots = rows.filter((row) => !matchingPids.has(row.ppid));
    signal(roots.length ? roots : rows, 'SIGTERM');
    rows = await waitUntilGone(profileId, termAttempts, intervalMs);

    if (rows?.length) {
      signal(rows, 'SIGTERM');
      rows = await waitUntilGone(profileId, termAttempts, intervalMs);
    }

    let forced = false;
    if (rows?.length) {
      forced = true;
      signal(rows, 'SIGKILL');
      rows = await waitUntilGone(profileId, killAttempts, intervalMs);
    }

    return {
      supported: true,
      found,
      remaining: rows?.length ?? null,
      forced,
    };
  }

  return { supported, list, isRunning, terminate };
}

const defaultController = createProfileProcessController();

module.exports = {
  ...defaultController,
  createProfileProcessController,
  parsePsOutput,
  assertProfileId,
};
