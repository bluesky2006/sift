'use strict';
// Authentication, copied from Switchboard's lib/auth.js (itself lifted from JotScribe:
// scrypt + HMAC-signed cookie), because that scheme is already proven on this box.
// Sift has its own auth.json and cookie name, so its password is its own.

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const AUTH_FILE = process.env.SIFT_AUTH_FILE || path.join(__dirname, '..', 'auth.json');
const SESSION_DAYS = 30;
const COOKIE = 'sift_sid';

// Only a missing file means "not set up yet". Anything else (unreadable, half-written, bad
// JSON) throws, so a damaged auth.json never reopens first-visit setup to the tailnet.
async function loadAuth() {
  let text;
  try { text = await fs.readFile(AUTH_FILE, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(text);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function setPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const auth = {
    salt,
    hash: hashPassword(password, salt),
    secret: crypto.randomBytes(32).toString('hex'),
  };
  // written whole under a temporary name, then linked into place: link() fails if auth.json
  // already exists, so of two setups at once only the first wins (the other gets null)
  const tmp = `${AUTH_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  try { await fs.link(tmp, AUTH_FILE); }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  finally { await fs.unlink(tmp).catch(() => {}); }
  return auth;
}

// Constant-time. A length mismatch short-circuits, but both sides are always
// scrypt output of a fixed size, so that leaks nothing.
function verifyPassword(password, auth) {
  if (!auth) return false;
  const got = Buffer.from(hashPassword(password, auth.salt), 'hex');
  const want = Buffer.from(auth.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeSession(auth) {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + SESSION_DAYS * 86400000,
    iat: Date.now(),
  })).toString('base64url');
  return payload + '.' + sign(payload, auth.secret);
}

function validSession(cookieValue, auth) {
  if (!cookieValue || !auth) return false;
  const [payload, mac] = String(cookieValue).split('.');
  if (!payload || !mac) return false;
  const expected = sign(payload, auth.secret);
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp, iat } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // signing out moves valid_after on, which ends every session issued before it
    return exp > Date.now() && (!auth.valid_after || iat > auth.valid_after);
  } catch { return false; }
}

async function endSessions(auth) {
  const next = { ...auth, valid_after: Date.now() };
  const tmp = AUTH_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(tmp, AUTH_FILE);
}

// Double-submit CSRF, derived from the session so it needs no server state.
// SameSite=Strict would probably be enough on its own; this is the belt to its
// braces, because a browser on the tailnet can reach us by IP.
function csrfFor(cookieValue, auth) {
  if (!cookieValue || !auth) return null;
  const payload = String(cookieValue).split('.')[0];
  if (!payload) return null;
  return sign('csrf:' + payload, auth.secret);
}

function validCsrf(token, cookieValue, auth) {
  const expected = csrfFor(cookieValue, auth);
  if (!expected || !token) return false;
  const a = Buffer.from(String(token)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

// Failed-login throttle. Constant delay on every attempt so a wrong password
// costs the same as a right one, plus a lockout so the tailnet cannot be used
// to grind the password down.
const attempts = [];
const LOCKOUT_MAX = 10;
const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;

function lockedOut() {
  const cutoff = Date.now() - LOCKOUT_WINDOW_MS;
  while (attempts.length && attempts[0] < cutoff) attempts.shift();
  return attempts.length >= LOCKOUT_MAX;
}
function recordFailure() { attempts.push(Date.now()); }
// Counted before the slow check, not after it, so guesses sent all at once can't slip past
// the limit while the first ones are still being checked. A right password clears them.
function startAttempt() {
  if (lockedOut()) return false;
  recordFailure();
  return true;
}
function clearFailures() { attempts.length = 0; }

module.exports = {
  AUTH_FILE, COOKIE, SESSION_DAYS,
  loadAuth, setPassword, verifyPassword,
  makeSession, validSession, csrfFor, validCsrf, readCookie,
  lockedOut, recordFailure, clearFailures, startAttempt, endSessions,
};
