/**
 * Lampa History Transfer — Cloudflare Worker Backend
 *
 * Реализует:
 * - Независимую систему аккаунтов History Transfer (регистрация, вход, выход, профиль)
 * - Безопасное хеширование паролей (PBKDF2-SHA256, 100 000 итераций, случайная соль)
 * - Защиту от перебора паролей (rate limiting в D1)
 * - Полную изоляцию данных пользователей
 * - Защиту от повторной отправки запросов (X-Idempotency-Key)
 * - Ограничение размера загружаемых данных (MAX_BACKUP_BYTES)
 * - Проверку целостности резервных копий (SHA-256)
 */

const FORMAT_VERSION = '2.0.0';
const SUPPORTED_FORMAT_VERSIONS = ['1.0.0', '2.0.0'];
const PBKDF2_ITERATIONS = 100000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const REGISTER_MAX_PER_HOUR = 10;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

const PROFILE_LIST_KEYS = [
  'history',
  'book',
  'like',
  'wath',
  'look',
  'viewed',
  'scheduled',
  'continued',
  'thrown'
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '*';
  const allowed = env && env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS : '*';
  let allowOrigin = '*';
  if (allowed !== '*') {
    const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
    allowOrigin = list.includes(origin) ? origin : list[0] || '*';
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Idempotency-Key',
    'Access-Control-Max-Age': '86400'
  };
}

function getSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  };
}

function jsonResponse(data, status, request, env, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...getSecurityHeaders(),
      ...getCorsHeaders(request, env),
      ...extraHeaders
    }
  });
}

function errorResponse(code, message, status, request, env, extra = {}) {
  return jsonResponse(
    {
      ok: false,
      error: {
        code,
        message,
        ...extra
      }
    },
    status,
    request,
    env
  );
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function fromHex(hex) {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function generateRandomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return toHex(digest);
}

async function hashPassword(password) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toHex(saltBytes)}$${toHex(derived)}`;
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }
  const iterations = parseInt(parts[1], 10);
  const saltBytes = fromHex(parts[2]);
  const expectedHex = parts[3];
  if (!iterations || !saltBytes.length || !expectedHex) {
    return false;
  }
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return constantTimeEqual(toHex(derived), expectedHex);
}

async function hashToken(rawToken, env) {
  const pepper = env && env.TOKEN_PEPPER ? String(env.TOKEN_PEPPER) : '';
  return sha256Hex(`${pepper}:${rawToken}`);
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function checkRateLimit(db, key, maxAttempts, windowMs, blockMs) {
  const now = Date.now();
  const row = await db
    .prepare('SELECT key, count, window_start, blocked_until FROM rate_limits WHERE key = ?')
    .bind(key)
    .first();

  if (row && row.blocked_until > now) {
    const retryAfterSec = Math.ceil((row.blocked_until - now) / 1000);
    return { allowed: false, retryAfterSec };
  }

  if (row && now - row.window_start <= windowMs && row.count >= maxAttempts) {
    const blockedUntil = now + blockMs;
    await db
      .prepare('UPDATE rate_limits SET blocked_until = ? WHERE key = ?')
      .bind(blockedUntil, key)
      .run();
    return { allowed: false, retryAfterSec: Math.ceil(blockMs / 1000) };
  }

  return { allowed: true, retryAfterSec: 0 };
}

async function recordRateLimitHit(db, key, windowMs) {
  const now = Date.now();
  const row = await db
    .prepare('SELECT key, count, window_start FROM rate_limits WHERE key = ?')
    .bind(key)
    .first();

  if (!row || now - row.window_start > windowMs) {
    await db
      .prepare(
        'INSERT INTO rate_limits (key, count, window_start, blocked_until) VALUES (?, 1, ?, 0) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = ?, blocked_until = 0'
      )
      .bind(key, now, now)
      .run();
  } else {
    await db
      .prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?')
      .bind(key)
      .run();
  }
}

async function resetRateLimit(db, key) {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}

async function readJsonBody(request, maxBytes) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && Number(contentLength) > maxBytes) {
    return { error: { code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Превышен допустимый размер запроса' } };
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    return { error: { code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Превышен допустимый размер запроса' } };
  }

  const text = decoder.decode(buffer);
  if (!text) {
    return { error: { code: 'INVALID_JSON', status: 400, message: 'Пустое тело запроса' } };
  }

  try {
    const data = JSON.parse(text);
    return { data, byteLength: buffer.byteLength };
  } catch (e) {
    return { error: { code: 'INVALID_JSON', status: 400, message: 'Некорректный JSON в теле запроса' } };
  }
}

async function authenticateRequest(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }
  const rawToken = authHeader.slice(7).trim();
  if (!rawToken || rawToken.length < 32) {
    return null;
  }

  const tokenHash = await hashToken(rawToken, env);
  const nowIso = new Date().toISOString();

  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.username, u.display_name, u.created_at, u.last_login_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first();

  if (!row) {
    return null;
  }

  if (row.expires_at <= nowIso) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(row.session_id).run();
    return null;
  }

  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at
    }
  };
}

async function createSession(db, userId, env) {
  const rawToken = generateRandomHex(32);
  const tokenHash = await hashToken(rawToken, env);
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : generateRandomHex(16);
  const ttlDays = Math.max(1, parseInt(env.SESSION_TTL_DAYS || '30', 10));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  await db
    .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(sessionId, userId, tokenHash, expiresAt, now.toISOString())
    .run();

  return { token: rawToken, expiresAt };
}

function validateBackupPayload(body) {
  if (!body || typeof body !== 'object') {
    return 'Тело резервной копии должно быть JSON-объектом';
  }

  const formatVersion = String(body.formatVersion || '');
  if (!SUPPORTED_FORMAT_VERSIONS.includes(formatVersion)) {
    return `Несовместимый формат резервной копии: ${formatVersion || 'не указан'}`;
  }

  if (!body.profile || typeof body.profile !== 'object') {
    return 'Отсутствует объект profile в резервной копии';
  }

  if (!Array.isArray(body.profile.card)) {
    return 'Поле profile.card должно быть массивом';
  }

  const requiredLists = ['history', 'book', 'like', 'wath', 'viewed', 'scheduled', 'continued', 'thrown'];
  for (const key of requiredLists) {
    if (!Array.isArray(body.profile[key])) {
      return `Поле profile.${key} должно быть массивом`;
    }
  }

  if (body.profile.look !== undefined && !Array.isArray(body.profile.look)) {
    return 'Поле profile.look должно быть массивом';
  }

  if (body.timeline !== undefined && (typeof body.timeline !== 'object' || Array.isArray(body.timeline) || body.timeline === null)) {
    return 'Поле timeline должно быть объектом-словарём';
  }

  return null;
}

function computeBackupStats(body, sizeBytes) {
  const cards = body.profile.card || [];
  let moviesCount = 0;
  let seriesCount = 0;

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (!c || typeof c !== 'object') continue;
    if (c.original_name || c.first_air_date || c.number_of_seasons || c.name) {
      seriesCount++;
    } else {
      moviesCount++;
    }
  }

  const timeline = body.timeline && typeof body.timeline === 'object' ? body.timeline : {};
  const timelineKeys = Object.keys(timeline);

  return {
    cardsCount: cards.length,
    moviesCount,
    seriesCount,
    historyCount: (body.profile.history || []).length,
    bookCount: (body.profile.book || []).length,
    likeCount: (body.profile.like || []).length,
    wathCount: (body.profile.wath || []).length,
    lookCount: (body.profile.look || []).length,
    viewedCount: (body.profile.viewed || []).length,
    scheduledCount: (body.profile.scheduled || []).length,
    continuedCount: (body.profile.continued || []).length,
    thrownCount: (body.profile.thrown || []).length,
    timelineCount: timelineKeys.length,
    sizeBytes
  };
}

function normalizeStoredProfile(profile) {
  const out = {
    card: Array.isArray(profile.card) ? profile.card : []
  };
  for (const key of PROFILE_LIST_KEYS) {
    out[key] = Array.isArray(profile[key]) ? profile[key] : [];
  }
  return out;
}

async function handleRegister(request, env) {
  const ip = getClientIp(request);
  const ipLimit = await checkRateLimit(
    env.DB,
    `reg:${ip}`,
    REGISTER_MAX_PER_HOUR,
    REGISTER_WINDOW_MS,
    REGISTER_WINDOW_MS
  );
  if (!ipLimit.allowed) {
    return errorResponse(
      'RATE_LIMITED',
      'Слишком много попыток регистрации. Попробуйте позже.',
      429,
      request,
      env,
      { retryAfterSec: ipLimit.retryAfterSec }
    );
  }

  const parsed = await readJsonBody(request, 16384);
  if (parsed.error) {
    return errorResponse(parsed.error.code, parsed.error.message, parsed.error.status, request, env);
  }

  const rawUsername = String(parsed.data.username || '').trim();
  const password = String(parsed.data.password || '');

  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(rawUsername)) {
    return errorResponse(
      'INVALID_USERNAME',
      'Логин должен содержать 3–32 символа (латиница, цифры, _, ., -)',
      400,
      request,
      env
    );
  }

  if (password.length < 8 || password.length > 128) {
    return errorResponse(
      'INVALID_PASSWORD',
      'Пароль должен содержать от 8 до 128 символов',
      400,
      request,
      env
    );
  }

  const normalizedUsername = rawUsername.toLowerCase();
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(normalizedUsername)
    .first();
  if (existing) {
    return errorResponse('USER_EXISTS', 'Пользователь с таким логином уже существует', 409, request, env);
  }

  await recordRateLimitHit(env.DB, `reg:${ip}`, REGISTER_WINDOW_MS);

  const userId = crypto.randomUUID ? crypto.randomUUID() : generateRandomHex(16);
  const passwordHash = await hashPassword(password);
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(userId, normalizedUsername, rawUsername, passwordHash, nowIso, nowIso)
    .run();

  const session = await createSession(env.DB, userId, env);

  return jsonResponse(
    {
      ok: true,
      user: {
        id: userId,
        username: normalizedUsername,
        displayName: rawUsername,
        createdAt: nowIso
      },
      token: session.token,
      expiresAt: session.expiresAt
    },
    201,
    request,
    env
  );
}

async function handleLogin(request, env) {
  const ip = getClientIp(request);
  const parsed = await readJsonBody(request, 16384);
  if (parsed.error) {
    return errorResponse(parsed.error.code, parsed.error.message, parsed.error.status, request, env);
  }

  const rawUsername = String(parsed.data.username || '').trim().toLowerCase();
  const password = String(parsed.data.password || '');

  if (!rawUsername || !password) {
    return errorResponse('INVALID_CREDENTIALS', 'Укажите логин и пароль', 400, request, env);
  }

  const ipCheck = await checkRateLimit(
    env.DB,
    `login_ip:${ip}`,
    LOGIN_MAX_ATTEMPTS * 3,
    LOGIN_WINDOW_MS,
    LOGIN_BLOCK_MS
  );
  if (!ipCheck.allowed) {
    return errorResponse(
      'RATE_LIMITED',
      'Слишком много неудачных попыток входа. Повторите позже.',
      429,
      request,
      env,
      { retryAfterSec: ipCheck.retryAfterSec }
    );
  }

  const userKey = `login_user:${rawUsername}`;
  const userCheck = await checkRateLimit(
    env.DB,
    userKey,
    LOGIN_MAX_ATTEMPTS,
    LOGIN_WINDOW_MS,
    LOGIN_BLOCK_MS
  );
  if (!userCheck.allowed) {
    return errorResponse(
      'ACCOUNT_LOCKED',
      'Аккаунт временно заблокирован из-за неверных попыток входа. Повторите позже.',
      429,
      request,
      env,
      { retryAfterSec: userCheck.retryAfterSec }
    );
  }

  const user = await env.DB.prepare(
    'SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = ?'
  )
    .bind(rawUsername)
    .first();

  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!valid) {
    await recordRateLimitHit(env.DB, `login_ip:${ip}`, LOGIN_WINDOW_MS);
    await recordRateLimitHit(env.DB, userKey, LOGIN_WINDOW_MS);
    return errorResponse('AUTH_FAILED', 'Неверный логин или пароль', 401, request, env);
  }

  await resetRateLimit(env.DB, userKey);
  const nowIso = new Date().toISOString();
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(nowIso, user.id)
    .run();

  const session = await createSession(env.DB, user.id, env);

  return jsonResponse(
    {
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        createdAt: user.created_at,
        lastLoginAt: nowIso
      },
      token: session.token,
      expiresAt: session.expiresAt
    },
    200,
    request,
    env
  );
}

async function handleLogout(request, env, auth) {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(auth.sessionId).run();
  return jsonResponse({ ok: true }, 200, request, env);
}

async function handleMe(request, env, auth) {
  const agg = await env.DB.prepare(
    'SELECT COUNT(*) AS backups_count, MAX(created_at) AS last_backup_at FROM backups WHERE user_id = ?'
  )
    .bind(auth.user.id)
    .first();

  return jsonResponse(
    {
      ok: true,
      user: auth.user,
      backupsCount: agg ? Number(agg.backups_count) : 0,
      lastBackupAt: agg && agg.last_backup_at ? agg.last_backup_at : null
    },
    200,
    request,
    env
  );
}

async function handleListBackups(request, env, auth) {
  const result = await env.DB.prepare(
    `SELECT id, name, format_version, cards_count, movies_count, series_count,
            history_count, book_count, viewed_count, timeline_count, size_bytes,
            checksum_sha256, created_at
     FROM backups
     WHERE user_id = ?
     ORDER BY created_at DESC`
  )
    .bind(auth.user.id)
    .all();

  const rows = (result && result.results) || [];
  const backups = rows.map((r) => ({
    id: r.id,
    name: r.name,
    formatVersion: r.format_version,
    cardsCount: r.cards_count,
    moviesCount: r.movies_count,
    seriesCount: r.series_count,
    historyCount: r.history_count,
    bookCount: r.book_count,
    viewedCount: r.viewed_count,
    timelineCount: r.timeline_count,
    sizeBytes: r.size_bytes,
    checksumSha256: r.checksum_sha256,
    createdAt: r.created_at
  }));

  return jsonResponse(
    {
      ok: true,
      backups,
      lastBackupAt: backups.length > 0 ? backups[0].createdAt : null
    },
    200,
    request,
    env
  );
}

async function handleCreateBackup(request, env, auth) {
  const maxBytes = parseInt(env.MAX_BACKUP_BYTES || '10485760', 10);
  const maxBackups = parseInt(env.MAX_BACKUPS_PER_USER || '20', 10);

  const idempotencyKey = (request.headers.get('X-Idempotency-Key') || '').trim();
  if (idempotencyKey) {
    const scopedKey = `${auth.user.id}:${idempotencyKey}`;
    const existingIdem = await env.DB.prepare(
      'SELECT response_json FROM idempotency_keys WHERE key = ? AND user_id = ?'
    )
      .bind(scopedKey, auth.user.id)
      .first();
    if (existingIdem) {
      return jsonResponse(JSON.parse(existingIdem.response_json), 200, request, env);
    }
  }

  const parsed = await readJsonBody(request, maxBytes);
  if (parsed.error) {
    return errorResponse(parsed.error.code, parsed.error.message, parsed.error.status, request, env);
  }

  const body = parsed.data;
  const validationError = validateBackupPayload(body);
  if (validationError) {
    return errorResponse('INCOMPATIBLE_FORMAT', validationError, 400, request, env);
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM backups WHERE user_id = ?')
    .bind(auth.user.id)
    .first();
  if (countRow && Number(countRow.cnt) >= maxBackups) {
    return errorResponse(
      'BACKUP_LIMIT_REACHED',
      `Достигнут лимит резервных копий (${maxBackups}). Удалите старые копии.`,
      409,
      request,
      env
    );
  }

  const backupId = crypto.randomUUID ? crypto.randomUUID() : generateRandomHex(16);
  const createdAt = new Date().toISOString();
  const cleanName = String(body.name || `Резервная копия ${createdAt.slice(0, 16).replace('T', ' ')}`)
    .trim()
    .slice(0, 120);

  const canonicalPayload = {
    backupId,
    userId: auth.user.id,
    name: cleanName,
    createdAt,
    formatVersion: FORMAT_VERSION,
    sourceMeta: body.sourceMeta && typeof body.sourceMeta === 'object' ? body.sourceMeta : {},
    profile: normalizeStoredProfile(body.profile),
    timeline: body.timeline && typeof body.timeline === 'object' ? body.timeline : {}
  };

  const payloadJson = JSON.stringify(canonicalPayload);
  const sizeBytes = encoder.encode(payloadJson).byteLength;
  if (sizeBytes > maxBytes) {
    return errorResponse('PAYLOAD_TOO_LARGE', 'Превышен максимальный размер резервной копии', 413, request, env);
  }

  const stats = computeBackupStats(canonicalPayload, sizeBytes);
  const checksumSha256 = await sha256Hex(payloadJson);

  await env.DB.prepare(
    `INSERT INTO backups (
      id, user_id, name, format_version,
      cards_count, movies_count, series_count,
      history_count, book_count, viewed_count, timeline_count,
      size_bytes, checksum_sha256, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      backupId,
      auth.user.id,
      cleanName,
      FORMAT_VERSION,
      stats.cardsCount,
      stats.moviesCount,
      stats.seriesCount,
      stats.historyCount,
      stats.bookCount,
      stats.viewedCount,
      stats.timelineCount,
      sizeBytes,
      checksumSha256,
      payloadJson,
      createdAt
    )
    .run();

  const responseBody = {
    ok: true,
    backup: {
      id: backupId,
      userId: auth.user.id,
      name: cleanName,
      formatVersion: FORMAT_VERSION,
      createdAt,
      checksumSha256,
      stats
    }
  };

  if (idempotencyKey) {
    const scopedKey = `${auth.user.id}:${idempotencyKey}`;
    await env.DB.prepare(
      'INSERT OR IGNORE INTO idempotency_keys (key, user_id, backup_id, response_json, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(scopedKey, auth.user.id, backupId, JSON.stringify(responseBody), createdAt)
      .run();
  }

  return jsonResponse(responseBody, 201, request, env);
}

async function handleGetBackup(request, env, auth, backupId) {
  const row = await env.DB.prepare(
    `SELECT id, user_id, name, format_version, cards_count, movies_count, series_count,
            history_count, book_count, viewed_count, timeline_count, size_bytes,
            checksum_sha256, payload_json, created_at
     FROM backups
     WHERE id = ? AND user_id = ?`
  )
    .bind(backupId, auth.user.id)
    .first();

  if (!row) {
    return errorResponse('BACKUP_NOT_FOUND', 'Резервная копия не найдена', 404, request, env);
  }

  const actualHash = await sha256Hex(row.payload_json);
  if (!constantTimeEqual(actualHash, row.checksum_sha256)) {
    return errorResponse(
      'INTEGRITY_ERROR',
      'Нарушена целостность резервной копии (несовпадение контрольной суммы)',
      500,
      request,
      env
    );
  }

  const parsedPayload = JSON.parse(row.payload_json);
  const stats = computeBackupStats(parsedPayload, row.size_bytes);

  return jsonResponse(
    {
      ok: true,
      backup: {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        formatVersion: row.format_version,
        createdAt: row.created_at,
        checksumSha256: row.checksum_sha256,
        stats,
        sourceMeta: parsedPayload.sourceMeta || {},
        profile: parsedPayload.profile,
        timeline: parsedPayload.timeline || {}
      }
    },
    200,
    request,
    env
  );
}

async function handleDeleteBackup(request, env, auth, backupId) {
  const res = await env.DB.prepare('DELETE FROM backups WHERE id = ? AND user_id = ?')
    .bind(backupId, auth.user.id)
    .run();

  const changes = res && res.meta ? res.meta.changes : 0;
  if (!changes) {
    return errorResponse('BACKUP_NOT_FOUND', 'Резервная копия не найдена', 404, request, env);
  }

  return jsonResponse({ ok: true, deletedId: backupId }, 200, request, env);
}

export async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...getSecurityHeaders(),
        ...getCorsHeaders(request, env)
      }
    });
  }

  const url = new URL(request.url);
  if (
    env &&
    env.REQUIRE_HTTPS === 'true' &&
    url.protocol !== 'https:' &&
    url.hostname !== 'localhost' &&
    url.hostname !== '127.0.0.1'
  ) {
    return errorResponse('HTTPS_REQUIRED', 'Требуется защищённое соединение HTTPS', 426, request, env);
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (request.method === 'GET' && path === '/api/health') {
      return jsonResponse(
        {
          ok: true,
          service: 'lampa-history-transfer',
          version: FORMAT_VERSION,
          timestamp: new Date().toISOString()
        },
        200,
        request,
        env
      );
    }

    if (request.method === 'POST' && path === '/api/auth/register') {
      return await handleRegister(request, env);
    }

    if (request.method === 'POST' && path === '/api/auth/login') {
      return await handleLogin(request, env);
    }

    const auth = await authenticateRequest(request, env);
    if (!auth) {
      return errorResponse('UNAUTHORIZED', 'Требуется авторизация в History Transfer', 401, request, env);
    }

    if (request.method === 'POST' && path === '/api/auth/logout') {
      return await handleLogout(request, env, auth);
    }

    if (request.method === 'GET' && path === '/api/auth/me') {
      return await handleMe(request, env, auth);
    }

    if (request.method === 'GET' && path === '/api/backups') {
      return await handleListBackups(request, env, auth);
    }

    if (request.method === 'POST' && path === '/api/backups') {
      return await handleCreateBackup(request, env, auth);
    }

    const backupMatch = path.match(/^\/api\/backups\/([a-zA-Z0-9_-]+)$/);
    if (backupMatch) {
      const backupId = backupMatch[1];
      if (request.method === 'GET') {
        return await handleGetBackup(request, env, auth, backupId);
      }
      if (request.method === 'DELETE') {
        return await handleDeleteBackup(request, env, auth, backupId);
      }
    }

    return errorResponse('NOT_FOUND', 'Маршрут не найден', 404, request, env);
  } catch (err) {
    return errorResponse('INTERNAL_ERROR', 'Внутренняя ошибка сервера', 500, request, env, env && env.DEBUG_ERRORS === 'true' ? { detail: String(err && err.stack || err) } : {});
  }
}

export default {
  fetch: handleRequest
};
