'use strict';

if (!globalThis.crypto) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../plugin/history-transfer.js');

/**
 * Полноценный in-memory мок Cloudflare D1 для интеграционного тестирования worker.js
 */
function createMockD1() {
  const tables = {
    users: new Map(),
    sessions: new Map(),
    backups: new Map(),
    rate_limits: new Map(),
    idempotency_keys: new Map()
  };

  function prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    let params = [];

    const stmt = {
      bind(...args) {
        params = args;
        return stmt;
      },
      async first() {
        if (normalized.startsWith('SELECT key, count, window_start, blocked_until FROM rate_limits')) {
          return tables.rate_limits.get(params[0]) || null;
        }
        if (normalized.startsWith('SELECT key, count, window_start FROM rate_limits')) {
          return tables.rate_limits.get(params[0]) || null;
        }
        if (normalized.startsWith('SELECT id FROM users WHERE username = ?')) {
          for (const u of tables.users.values()) {
            if (u.username === params[0]) return { id: u.id };
          }
          return null;
        }
        if (normalized.startsWith('SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = ?')) {
          for (const u of tables.users.values()) {
            if (u.username === params[0]) return { ...u };
          }
          return null;
        }
        if (normalized.includes('FROM sessions s JOIN users u ON u.id = s.user_id')) {
          for (const s of tables.sessions.values()) {
            if (s.token_hash === params[0]) {
              const u = tables.users.get(s.user_id);
              if (!u) return null;
              return {
                session_id: s.id,
                expires_at: s.expires_at,
                user_id: u.id,
                username: u.username,
                display_name: u.display_name,
                created_at: u.created_at,
                last_login_at: u.last_login_at
              };
            }
          }
          return null;
        }
        if (normalized.startsWith('SELECT COUNT(*) AS backups_count, MAX(created_at) AS last_backup_at FROM backups')) {
          let count = 0;
          let maxDate = null;
          for (const b of tables.backups.values()) {
            if (b.user_id === params[0]) {
              count++;
              if (!maxDate || b.created_at > maxDate) maxDate = b.created_at;
            }
          }
          return { backups_count: count, last_backup_at: maxDate };
        }
        if (normalized.startsWith('SELECT COUNT(*) AS cnt FROM backups WHERE user_id = ?')) {
          let cnt = 0;
          for (const b of tables.backups.values()) {
            if (b.user_id === params[0]) cnt++;
          }
          return { cnt };
        }
        if (normalized.startsWith('SELECT response_json FROM idempotency_keys')) {
          const row = tables.idempotency_keys.get(params[0]);
          if (row && row.user_id === params[1]) return { response_json: row.response_json };
          return null;
        }
        if (normalized.includes('FROM backups WHERE id = ? AND user_id = ?')) {
          const b = tables.backups.get(params[0]);
          if (b && b.user_id === params[1]) return { ...b };
          return null;
        }
        throw new Error('Unhandled first() SQL: ' + normalized);
      },
      async all() {
        if (normalized.includes('FROM backups WHERE user_id = ? ORDER BY created_at DESC')) {
          const list = [];
          for (const b of tables.backups.values()) {
            if (b.user_id === params[0]) list.push({ ...b });
          }
          list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          return { results: list };
        }
        throw new Error('Unhandled all() SQL: ' + normalized);
      },
      async run() {
        if (normalized.startsWith('INSERT INTO rate_limits')) {
          tables.rate_limits.set(params[0], {
            key: params[0],
            count: 1,
            window_start: params[1],
            blocked_until: 0
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('UPDATE rate_limits SET count = count + 1')) {
          const row = tables.rate_limits.get(params[0]);
          if (row) row.count += 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (normalized.startsWith('UPDATE rate_limits SET blocked_until = ?')) {
          const row = tables.rate_limits.get(params[1]);
          if (row) row.blocked_until = params[0];
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (normalized.startsWith('DELETE FROM rate_limits')) {
          tables.rate_limits.delete(params[0]);
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('INSERT INTO users')) {
          tables.users.set(params[0], {
            id: params[0],
            username: params[1],
            display_name: params[2],
            password_hash: params[3],
            created_at: params[4],
            last_login_at: params[5]
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('UPDATE users SET last_login_at')) {
          const u = tables.users.get(params[1]);
          if (u) u.last_login_at = params[0];
          return { meta: { changes: u ? 1 : 0 } };
        }
        if (normalized.startsWith('INSERT INTO sessions')) {
          tables.sessions.set(params[0], {
            id: params[0],
            user_id: params[1],
            token_hash: params[2],
            expires_at: params[3],
            created_at: params[4]
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('DELETE FROM sessions')) {
          const existed = tables.sessions.delete(params[0]);
          return { meta: { changes: existed ? 1 : 0 } };
        }
        if (normalized.startsWith('INSERT INTO backups')) {
          tables.backups.set(params[0], {
            id: params[0],
            user_id: params[1],
            name: params[2],
            format_version: params[3],
            cards_count: params[4],
            movies_count: params[5],
            series_count: params[6],
            history_count: params[7],
            book_count: params[8],
            viewed_count: params[9],
            timeline_count: params[10],
            size_bytes: params[11],
            checksum_sha256: params[12],
            payload_json: params[13],
            created_at: params[14]
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('INSERT OR IGNORE INTO idempotency_keys')) {
          if (!tables.idempotency_keys.has(params[0])) {
            tables.idempotency_keys.set(params[0], {
              key: params[0],
              user_id: params[1],
              backup_id: params[2],
              response_json: params[3],
              created_at: params[4]
            });
          }
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('DELETE FROM backups WHERE id = ? AND user_id = ?')) {
          const b = tables.backups.get(params[0]);
          if (b && b.user_id === params[1]) {
            tables.backups.delete(params[0]);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        throw new Error('Unhandled run() SQL: ' + normalized);
      }
    };
    return stmt;
  }

  return { prepare, _tables: tables };
}

async function loadWorker() {
  return await import('../server/worker.js');
}

function makeEnv(db, overrides = {}) {
  return {
    DB: db,
    MAX_BACKUP_BYTES: '1048576',
    SESSION_TTL_DAYS: '30',
    MAX_BACKUPS_PER_USER: '5',
    ALLOWED_ORIGINS: '*',
    TOKEN_PEPPER: 'test-pepper',
    ...overrides
  };
}

test('API: health check, регистрация, вход, изоляция пользователей, идемпотентность и целостность', async () => {
  const worker = await loadWorker();
  const db = createMockD1();
  const env = makeEnv(db);

  // 1. Health
  const healthRes = await worker.handleRequest(new Request('https://example.workers.dev/api/health'), env);
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.ok, true);

  // 2. Регистрация User A
  const regA = await worker.handleRequest(
    new Request('https://example.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ username: 'user_alpha', password: 'StrongPassword123' })
    }),
    env
  );
  assert.equal(regA.status, 201);
  const regAData = await regA.json();
  assert.ok(regAData.token);

  // 3. Регистрация User B
  const regB = await worker.handleRequest(
    new Request('https://example.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '5.6.7.8' },
      body: JSON.stringify({ username: 'user_beta', password: 'StrongPassword456' })
    }),
    env
  );
  assert.equal(regB.status, 201);
  const regBData = await regB.json();

  // 4. Загрузка резервной копии User A с X-Idempotency-Key
  const sampleBackup = Core.buildBackupPayload({
    name: 'Test Backup 1',
    profile: {
      card: [{ id: 550, title: 'Fight Club' }],
      history: [550],
      book: [550],
      like: [],
      wath: [],
      viewed: [550],
      scheduled: [],
      continued: [],
      thrown: []
    },
    timeline: {
      t1: { duration: 1000, time: 500, percent: 50, updated: 1700000000, card: 'movie_550' }
    }
  });

  const createRes1 = await worker.handleRequest(
    new Request('https://example.workers.dev/api/backups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regAData.token}`,
        'X-Idempotency-Key': 'idem-key-1'
      },
      body: JSON.stringify(sampleBackup)
    }),
    env
  );
  assert.equal(createRes1.status, 201);
  const created1 = await createRes1.json();
  const backupId = created1.backup.id;

  // Повторный запрос с тем же X-Idempotency-Key не создаёт вторую копию
  const createRes2 = await worker.handleRequest(
    new Request('https://example.workers.dev/api/backups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regAData.token}`,
        'X-Idempotency-Key': 'idem-key-1'
      },
      body: JSON.stringify(sampleBackup)
    }),
    env
  );
  assert.equal(createRes2.status, 200);
  const created2 = await createRes2.json();
  assert.equal(created2.backup.id, backupId);

  // 5. Изоляция: User B не может получить или удалить копию User A
  const getByB = await worker.handleRequest(
    new Request(`https://example.workers.dev/api/backups/${backupId}`, {
      headers: { Authorization: `Bearer ${regBData.token}` }
    }),
    env
  );
  assert.equal(getByB.status, 404);

  const delByB = await worker.handleRequest(
    new Request(`https://example.workers.dev/api/backups/${backupId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${regBData.token}` }
    }),
    env
  );
  assert.equal(delByB.status, 404);

  // 6. User A успешно получает свою копию
  const getByA = await worker.handleRequest(
    new Request(`https://example.workers.dev/api/backups/${backupId}`, {
      headers: { Authorization: `Bearer ${regAData.token}` }
    }),
    env
  );
  assert.equal(getByA.status, 200);
  const loadedA = await getByA.json();
  assert.equal(loadedA.backup.profile.history[0], 550);
  assert.equal(loadedA.backup.timeline.t1.percent, 50);

  // 7. Проверка целостности: подмена payload_json в БД вызывает 500 INTEGRITY_ERROR
  const stored = db._tables.backups.get(backupId);
  const originalJson = stored.payload_json;
  stored.payload_json = originalJson.replace('Fight Club', 'Tampered');
  const tamperedRes = await worker.handleRequest(
    new Request(`https://example.workers.dev/api/backups/${backupId}`, {
      headers: { Authorization: `Bearer ${regAData.token}` }
    }),
    env
  );
  assert.equal(tamperedRes.status, 500);
  stored.payload_json = originalJson;

  // 8. Удаление копии User A
  const delByA = await worker.handleRequest(
    new Request(`https://example.workers.dev/api/backups/${backupId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${regAData.token}` }
    }),
    env
  );
  assert.equal(delByA.status, 200);
});

test('API: защита от перебора паролей (429) и ограничение размера запроса (413)', async () => {
  const worker = await loadWorker();
  const db = createMockD1();
  const env = makeEnv(db, { MAX_BACKUP_BYTES: '500' });

  const reg = await worker.handleRequest(
    new Request('https://example.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
      body: JSON.stringify({ username: 'bruteforce_user', password: 'ValidPassword1' })
    }),
    env
  );
  const { token } = await reg.json();

  // 5 неудачных попыток входа -> 6-я блокируется 429
  for (let i = 0; i < 5; i++) {
    const res = await worker.handleRequest(
      new Request('https://example.workers.dev/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
        body: JSON.stringify({ username: 'bruteforce_user', password: 'WrongPassword' })
      }),
      env
    );
    assert.equal(res.status, 401);
  }

  const lockedRes = await worker.handleRequest(
    new Request('https://example.workers.dev/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
      body: JSON.stringify({ username: 'bruteforce_user', password: 'ValidPassword1' })
    }),
    env
  );
  assert.equal(lockedRes.status, 429);

  // Превышение MAX_BACKUP_BYTES -> 413
  const bigBackup = Core.buildBackupPayload({
    name: 'Too Big',
    profile: { card: [{ id: 1, title: 'X'.repeat(800) }], history: [1] }
  });
  const bigRes = await worker.handleRequest(
    new Request('https://example.workers.dev/api/backups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(bigBackup)
    }),
    env
  );
  assert.equal(bigRes.status, 413);
});
