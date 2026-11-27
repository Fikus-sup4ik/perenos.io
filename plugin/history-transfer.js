/**
 * Lampa History Transfer — Универсальный плагин переноса истории и профиля Lampa/CUB
 * Версия: 2.0.0
 * Совместимость: ES5 (Smart TV WebOS / Tizen / Android TV / Desktop / Mobile) + Node.js (тесты)
 *
 * Основано на реальной структуре Lampa (yumata/lampa-source):
 * - Lampa.Favorite (src/core/favorite.js): card, history, book, like, wath, look, viewed, scheduled, continued, thrown
 * - Lampa.Account.Bookmarks (src/core/account/bookmarks.js): GET bookmarks/dump, POST bookmarks/add, POST bookmarks/clear
 * - Lampa.Timeline & Account.Timeline (src/interaction/timeline.js, src/core/account/timeline.js):
 *   GET timeline/dump, POST timeline/import (multipart timelines.json), POST timeline/update
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.LampaHistoryTransferCore = api;
    if (typeof window !== 'undefined' && window.Lampa) {
      api.initLampaPlugin(window.Lampa);
    } else if (typeof document !== 'undefined') {
      document.addEventListener('DOMContentLoaded', function () {
        if (window.Lampa) {
          api.initLampaPlugin(window.Lampa);
        }
      });
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PLUGIN_ID = 'lampa_history_transfer';
  var PLUGIN_VERSION = '2.0.0';
  var FORMAT_VERSION = '2.0.0';
  var SUPPORTED_FORMATS = ['1.0.0', '2.0.0'];

  // Реальные категории Lampa.Favorite (src/core/favorite.js)
  // Важно: wath сохраняет оригинальное написание, look присутствует в реальном ядре Lampa
  var PROFILE_CATEGORIES = [
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

  var DEFAULT_SETTINGS = {
    serverUrl: 'https://lampa-history-transfer.your-subdomain.workers.dev',
    timeoutMs: 15000,
    cubWriteDelayMs: 100,
    importMode: 'merge' // 'merge' | 'replace'
  };

  var STORAGE_KEYS = {
    SERVER_URL: 'ht_server_url',
    AUTH_TOKEN: 'ht_auth_token',
    AUTH_USER: 'ht_auth_user',
    IMPORT_MODE: 'ht_import_mode',
    PENDING_BACKUP: 'ht_pending_backup',
    ERROR_LOG: 'ht_error_log',
    LAST_BACKUP_AT: 'ht_last_backup_at'
  };

  var ERROR_CODES = {
    SERVER_UNAVAILABLE: 'SERVER_UNAVAILABLE',
    CUB_CONNECTION_ERROR: 'CUB_CONNECTION_ERROR',
    AUTH_ERROR: 'AUTH_ERROR',
    BACKUP_NOT_FOUND: 'BACKUP_NOT_FOUND',
    INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
    HISTORY_FETCH_ERROR: 'HISTORY_FETCH_ERROR',
    UPLOAD_ERROR: 'UPLOAD_ERROR',
    IMPORT_WRITE_ERROR: 'IMPORT_WRITE_ERROR',
    INCOMPATIBLE_FORMAT: 'INCOMPATIBLE_FORMAT',
    PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
    TIMEOUT: 'TIMEOUT'
  };

  var ERROR_MESSAGES = {
    SERVER_UNAVAILABLE: 'Сервер History Transfer недоступен. Проверьте адрес сервера в настройках.',
    CUB_CONNECTION_ERROR: 'Ошибка подключения к аккаунту CUB. Убедитесь, что выполнен вход и включена синхронизация.',
    AUTH_ERROR: 'Ошибка авторизации History Transfer. Войдите в аккаунт заново.',
    BACKUP_NOT_FOUND: 'Резервная копия не найдена в облачном хранилище.',
    INSUFFICIENT_DATA: 'Недостаточно данных для выполнения операции (профиль пуст).',
    HISTORY_FETCH_ERROR: 'Ошибка получения истории и закладок из профиля Lampa/CUB.',
    UPLOAD_ERROR: 'Ошибка отправки резервной копии в облако. Локальная копия сохранена для повтора.',
    IMPORT_WRITE_ERROR: 'Ошибка записи данных в новый профиль CUB.',
    INCOMPATIBLE_FORMAT: 'Несовместимый формат или повреждённая структура резервной копии.',
    PAYLOAD_TOO_LARGE: 'Превышен максимальный размер запроса на сервере.',
    TIMEOUT: 'Превышено время ожидания ответа от сервера (тайм-аут).'
  };

  function createAppError(code, detail, cause) {
    var err = new Error(ERROR_MESSAGES[code] || detail || 'Неизвестная ошибка');
    err.code = code;
    err.detail = detail || '';
    if (cause) {
      err.cause = cause;
    }
    return err;
  }

  function cloneSimple(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      return obj;
    }
  }

  function generateUuid() {
    var tpl = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return tpl.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function formatBytes(bytes) {
    var num = Number(bytes) || 0;
    if (num < 1024) return num + ' Б';
    if (num < 1024 * 1024) return (num / 1024).toFixed(1) + ' КБ';
    return (num / (1024 * 1024)).toFixed(2) + ' МБ';
  }

  function isSeriesCard(card) {
    if (!card || typeof card !== 'object') return false;
    return Boolean(card.original_name || card.first_air_date || card.number_of_seasons || card.name);
  }

  function clearCardObject(card) {
    if (!card || typeof card !== 'object') return null;
    var clean = cloneSimple(card);
    if (!clean || clean.id === undefined || clean.id === null) return null;
    // Удаляем временные служебные поля DOM/рендера, если они случайно попали
    delete clean.params;
    delete clean.active;
    return clean;
  }

  function normalizeProfileStructure(raw) {
    var src = raw && typeof raw === 'object' ? raw : {};
    var out = {
      card: Array.isArray(src.card) ? src.card.slice() : []
    };
    for (var i = 0; i < PROFILE_CATEGORIES.length; i++) {
      var cat = PROFILE_CATEGORIES[i];
      out[cat] = Array.isArray(src[cat]) ? src[cat].slice() : [];
    }
    return out;
  }

  /**
   * Разбирает ответ CUB API `GET bookmarks/dump` в структуру профиля Lampa.Favorite.
   * Реальный формат CUB bookmarks/dump:
   * { bookmarks: [{ id, cid, card_id, type, data, profile, time }, ...], version }
   */
  function parseCubBookmarksDump(dumpResponse) {
    var parsed = typeof dumpResponse === 'string' ? JSON.parse(dumpResponse) : dumpResponse;
    if (!parsed || !Array.isArray(parsed.bookmarks)) {
      throw createAppError(ERROR_CODES.HISTORY_FETCH_ERROR, 'Некорректный ответ bookmarks/dump от CUB');
    }

    var profile = normalizeProfileStructure({});
    var cardMap = {};
    var bookmarks = parsed.bookmarks.slice();

    // Сортируем по убыванию time (новые в начале, как в Lampa.Favorite)
    bookmarks.sort(function (a, b) {
      return (Number(b && b.time) || 0) - (Number(a && a.time) || 0);
    });

    for (var i = 0; i < bookmarks.length; i++) {
      var item = bookmarks[i];
      if (!item || !item.type) continue;
      var type = String(item.type);
      if (PROFILE_CATEGORIES.indexOf(type) === -1) continue;

      var cardObj = null;
      if (item.data) {
        try {
          cardObj = typeof item.data === 'string' ? JSON.parse(item.data) : item.data;
        } catch (e) {
          cardObj = null;
        }
      }

      var cardId = item.card_id !== undefined && item.card_id !== null
        ? item.card_id
        : (cardObj ? cardObj.id : null);

      if (cardId === null || cardId === undefined) continue;

      if (cardObj && typeof cardObj === 'object') {
        if (cardObj.id === undefined || cardObj.id === null) {
          cardObj.id = cardId;
        }
        var key = String(cardObj.id);
        if (!cardMap[key]) {
          cardMap[key] = clearCardObject(cardObj);
          profile.card.push(cardMap[key]);
        }
      }

      profile[type].push(cardId);
    }

    return validateAndDeduplicateProfile(profile);
  }

  /**
   * Разбирает ответ CUB API `GET timeline/dump` в словарь таймкодов Lampa.Timeline.
   * Реальный формат CUB timeline/dump:
   * { timelines: { "<hash>": { duration, time, percent, updated, card?, season?, episode?, profile? } }, version }
   */
  function parseCubTimelineDump(dumpResponse) {
    var parsed = typeof dumpResponse === 'string' ? JSON.parse(dumpResponse) : dumpResponse;
    if (!parsed || typeof parsed !== 'object') {
      throw createAppError(ERROR_CODES.HISTORY_FETCH_ERROR, 'Некорректный ответ timeline/dump от CUB');
    }
    var timelines = parsed.timelines && typeof parsed.timelines === 'object' ? parsed.timelines : {};
    return normalizeTimeline(timelines);
  }

  function normalizeTimeline(rawTimeline) {
    var out = {};
    if (!rawTimeline || typeof rawTimeline !== 'object' || Array.isArray(rawTimeline)) {
      return out;
    }
    var keys = Object.keys(rawTimeline);
    for (var i = 0; i < keys.length; i++) {
      var hash = String(keys[i]);
      var entry = rawTimeline[hash];
      if (!entry || typeof entry !== 'object') continue;
      var normalized = {
        duration: Math.round(Number(entry.duration) || 0),
        time: Math.round(Number(entry.time) || 0),
        percent: Math.round(Number(entry.percent) || 0),
        profile: Number(entry.profile) || 0,
        updated: Number(entry.updated) || 0
      };
      if (entry.card !== undefined && entry.card !== null && String(entry.card) !== '') {
        normalized.card = String(entry.card);
      }
      if (entry.season !== undefined && entry.season !== null) {
        normalized.season = Number(entry.season);
      }
      if (entry.episode !== undefined && entry.episode !== null) {
        normalized.episode = Number(entry.episode);
      }
      out[hash] = normalized;
    }
    return out;
  }

  /**
   * Удаляет технические дубликаты в карточках и категориях, сохраняя исходный порядок.
   * Проверяет соответствие ID карточкам.
   */
  function validateAndDeduplicateProfile(rawProfile) {
    var src = normalizeProfileStructure(rawProfile);
    var result = normalizeProfileStructure({});
    var cardMap = {};
    var i, j, card, idKey, cat, idVal;

    for (i = 0; i < src.card.length; i++) {
      card = clearCardObject(src.card[i]);
      if (!card) continue;
      idKey = String(card.id);
      if (!cardMap[idKey]) {
        cardMap[idKey] = card;
        result.card.push(card);
      }
    }

    var missingCardIds = [];
    for (i = 0; i < PROFILE_CATEGORIES.length; i++) {
      cat = PROFILE_CATEGORIES[i];
      var seen = {};
      for (j = 0; j < src[cat].length; j++) {
        idVal = src[cat][j];
        if (idVal === null || idVal === undefined || idVal === '') continue;
        idKey = String(idVal);
        if (seen[idKey]) continue;
        seen[idKey] = true;
        result[cat].push(idVal);
        if (!cardMap[idKey] && missingCardIds.indexOf(idVal) === -1) {
          missingCardIds.push(idVal);
        }
      }
    }

    return {
      profile: result,
      cardMap: cardMap,
      missingCardIds: missingCardIds
    };
  }

  function computeProfileStats(profile, timeline, sizeBytes) {
    var p = normalizeProfileStructure(profile);
    var t = normalizeTimeline(timeline);
    var moviesCount = 0;
    var seriesCount = 0;
    for (var i = 0; i < p.card.length; i++) {
      if (isSeriesCard(p.card[i])) {
        seriesCount++;
      } else {
        moviesCount++;
      }
    }
    var timelineKeys = Object.keys(t);
    var seriesTimelineCount = 0;
    for (var j = 0; j < timelineKeys.length; j++) {
      var entry = t[timelineKeys[j]];
      if (entry && (entry.season !== undefined || entry.episode !== undefined || (entry.card && entry.card.indexOf('tv_') === 0))) {
        seriesTimelineCount++;
      }
    }

    return {
      cardsCount: p.card.length,
      moviesCount: moviesCount,
      seriesCount: seriesCount,
      historyCount: p.history.length,
      bookCount: p.book.length,
      likeCount: p.like.length,
      wathCount: p.wath.length,
      lookCount: p.look.length,
      viewedCount: p.viewed.length,
      scheduledCount: p.scheduled.length,
      continuedCount: p.continued.length,
      thrownCount: p.thrown.length,
      timelineCount: timelineKeys.length,
      seriesTimelineCount: seriesTimelineCount,
      sizeBytes: Number(sizeBytes) || 0
    };
  }

  function buildBackupPayload(options) {
    var opts = options || {};
    var deduped = validateAndDeduplicateProfile(opts.profile || {});
    var timeline = normalizeTimeline(opts.timeline || {});
    var nowIso = new Date().toISOString();
    var backupId = opts.backupId || generateUuid();
    var name = opts.name || ('Резервная копия ' + nowIso.slice(0, 16).replace('T', ' '));

    var payload = {
      backupId: backupId,
      userId: opts.userId || '',
      name: name,
      createdAt: nowIso,
      formatVersion: FORMAT_VERSION,
      sourceMeta: opts.sourceMeta || {},
      profile: deduped.profile,
      timeline: timeline
    };

    var jsonStr = JSON.stringify(payload);
    var byteSize = typeof Buffer !== 'undefined'
      ? Buffer.byteLength(jsonStr, 'utf8')
      : unescape(encodeURIComponent(jsonStr)).length;

    payload.stats = computeProfileStats(deduped.profile, timeline, byteSize);
    return payload;
  }

  function validateBackupForImport(backup) {
    if (!backup || typeof backup !== 'object') {
      throw createAppError(ERROR_CODES.INCOMPATIBLE_FORMAT, 'Резервная копия пуста или не является объектом');
    }
    var ver = String(backup.formatVersion || '');
    if (SUPPORTED_FORMATS.indexOf(ver) === -1) {
      throw createAppError(ERROR_CODES.INCOMPATIBLE_FORMAT, 'Неподдерживаемая версия формата: ' + (ver || 'нет'));
    }
    if (!backup.profile || typeof backup.profile !== 'object' || !Array.isArray(backup.profile.card)) {
      throw createAppError(ERROR_CODES.INCOMPATIBLE_FORMAT, 'Отсутствует корректный блок profile в резервной копии');
    }
    return true;
  }

  /**
   * Безопасное объединение профилей (без удаления существующих записей нового аккаунта).
   * Сохраняет порядок истории и исключает дубликаты.
   */
  function mergeProfiles(targetRaw, incomingRaw, mode) {
    var importMode = mode === 'replace' ? 'replace' : 'merge';
    var incoming = validateAndDeduplicateProfile(incomingRaw).profile;
    if (importMode === 'replace') {
      return {
        merged: incoming,
        stats: {
          addedCards: incoming.card.length,
          existedCards: 0,
          addedByCategory: countCategories(incoming)
        }
      };
    }

    var target = validateAndDeduplicateProfile(targetRaw).profile;
    var out = normalizeProfileStructure(target);
    var cardMap = {};
    var i, j, card, key;

    for (i = 0; i < out.card.length; i++) {
      card = out.card[i];
      if (card && card.id !== undefined) {
        cardMap[String(card.id)] = true;
      }
    }

    var addedCards = 0;
    var existedCards = 0;
    for (i = 0; i < incoming.card.length; i++) {
      card = incoming.card[i];
      if (!card || card.id === undefined) continue;
      key = String(card.id);
      if (!cardMap[key]) {
        cardMap[key] = true;
        out.card.push(clearCardObject(card));
        addedCards++;
      } else {
        existedCards++;
      }
    }

    var addedByCategory = {};
    for (i = 0; i < PROFILE_CATEGORIES.length; i++) {
      var cat = PROFILE_CATEGORIES[i];
      var existingSet = {};
      for (j = 0; j < out[cat].length; j++) {
        existingSet[String(out[cat][j])] = true;
      }
      var addedCount = 0;
      for (j = 0; j < incoming[cat].length; j++) {
        var idVal = incoming[cat][j];
        var idStr = String(idVal);
        if (!existingSet[idStr]) {
          existingSet[idStr] = true;
          out[cat].push(idVal);
          addedCount++;
        }
      }
      addedByCategory[cat] = addedCount;
    }

    return {
      merged: out,
      stats: {
        addedCards: addedCards,
        existedCards: existedCards,
        addedByCategory: addedByCategory
      }
    };
  }

  function countCategories(profile) {
    var counts = {};
    for (var i = 0; i < PROFILE_CATEGORIES.length; i++) {
      var cat = PROFILE_CATEGORIES[i];
      counts[cat] = (profile[cat] || []).length;
    }
    return counts;
  }

  /**
   * Безопасное объединение таймкодов (прогресс фильмов и серий сериалов).
   * Если запись уже есть в новом аккаунте, выбирается более свежая (updated)
   * или с большим прогрессом (percent).
   */
  function mergeTimelines(targetRaw, incomingRaw, mode) {
    var importMode = mode === 'replace' ? 'replace' : 'merge';
    var incoming = normalizeTimeline(incomingRaw);
    if (importMode === 'replace') {
      return {
        merged: incoming,
        stats: {
          added: Object.keys(incoming).length,
          updated: 0,
          keptExisting: 0
        }
      };
    }

    var target = normalizeTimeline(targetRaw);
    var out = cloneSimple(target);
    var keys = Object.keys(incoming);
    var added = 0;
    var updated = 0;
    var keptExisting = 0;

    for (var i = 0; i < keys.length; i++) {
      var hash = keys[i];
      var inc = incoming[hash];
      var cur = out[hash];

      if (!cur) {
        out[hash] = cloneSimple(inc);
        added++;
      } else {
        var incUpd = Number(inc.updated) || 0;
        var curUpd = Number(cur.updated) || 0;
        if (incUpd > curUpd || (incUpd === curUpd && (Number(inc.percent) || 0) > (Number(cur.percent) || 0))) {
          out[hash] = cloneSimple(inc);
          updated++;
        } else {
          keptExisting++;
        }
      }
    }

    return {
      merged: out,
      stats: {
        added: added,
        updated: updated,
        keptExisting: keptExisting
      }
    };
  }

  /**
   * Готовит список операций записи в CUB API (`bookmarks/add`) только для недостающих элементов.
   */
  function prepareImportOperations(targetProfileRaw, backupProfileRaw, mode) {
    var target = validateAndDeduplicateProfile(targetProfileRaw);
    var backup = validateAndDeduplicateProfile(backupProfileRaw);
    var isReplace = mode === 'replace';

    var operations = [];
    var existedCount = 0;

    for (var i = 0; i < PROFILE_CATEGORIES.length; i++) {
      var cat = PROFILE_CATEGORIES[i];
      var targetSet = {};
      if (!isReplace) {
        for (var j = 0; j < target.profile[cat].length; j++) {
          targetSet[String(target.profile[cat][j])] = true;
        }
      }

      // Идём с конца в начало, чтобы при добавлении через bookmarks/add
      // наиболее свежие записи оказывались в начале списка
      var list = backup.profile[cat];
      for (var k = list.length - 1; k >= 0; k--) {
        var cardId = list[k];
        var idKey = String(cardId);
        if (!isReplace && targetSet[idKey]) {
          existedCount++;
          continue;
        }
        var cardObj = backup.cardMap[idKey] || target.cardMap[idKey] || { id: cardId };
        operations.push({
          type: cat,
          card_id: cardId,
          card: clearCardObject(cardObj)
        });
      }
    }

    return {
      operations: operations,
      existedCount: existedCount
    };
  }

  /**
   * Сверяет фактически полученный после импорта профиль с ожидаемой резервной копией.
   */
  function verifyImportResult(expectedProfileRaw, actualProfileRaw, expectedTimelineRaw, actualTimelineRaw) {
    var expected = validateAndDeduplicateProfile(expectedProfileRaw).profile;
    var actual = validateAndDeduplicateProfile(actualProfileRaw).profile;
    var expTl = normalizeTimeline(expectedTimelineRaw);
    var actTl = normalizeTimeline(actualTimelineRaw);

    var missingByCategory = {};
    var totalExpected = 0;
    var totalVerified = 0;

    for (var i = 0; i < PROFILE_CATEGORIES.length; i++) {
      var cat = PROFILE_CATEGORIES[i];
      var actualSet = {};
      for (var j = 0; j < actual[cat].length; j++) {
        actualSet[String(actual[cat][j])] = true;
      }
      var missing = [];
      for (var k = 0; k < expected[cat].length; k++) {
        totalExpected++;
        var idVal = expected[cat][k];
        if (actualSet[String(idVal)]) {
          totalVerified++;
        } else {
          missing.push(idVal);
        }
      }
      if (missing.length > 0) {
        missingByCategory[cat] = missing;
      }
    }

    var expTlKeys = Object.keys(expTl);
    var missingTimelines = [];
    for (var t = 0; t < expTlKeys.length; t++) {
      if (!actTl[expTlKeys[t]]) {
        missingTimelines.push(expTlKeys[t]);
      }
    }

    return {
      ok: Object.keys(missingByCategory).length === 0 && missingTimelines.length === 0,
      totalExpectedItems: totalExpected,
      totalVerifiedItems: totalVerified,
      missingByCategory: missingByCategory,
      totalExpectedTimelines: expTlKeys.length,
      totalVerifiedTimelines: expTlKeys.length - missingTimelines.length,
      missingTimelines: missingTimelines
    };
  }

  // ============================================================================
  // КЛИЕНТСКАЯ ЧАСТЬ ДЛЯ LAMPA (UI, CUB API, ОБЛАЧНЫЙ СЕРВЕР, ЖУРНАЛ ОШИБОК)
  // ============================================================================

  function initLampaPlugin(Lampa) {
    if (!Lampa || window.plugin_history_transfer_ready) return;
    window.plugin_history_transfer_ready = true;

    var logState = {
      maxEntries: 50
    };

    function getSetting(key, fallback) {
      try {
        var val = Lampa.Storage.get(key, fallback);
        return val !== undefined && val !== null && val !== '' ? val : fallback;
      } catch (e) {
        return fallback;
      }
    }

    function setSetting(key, value) {
      try {
        Lampa.Storage.set(key, value);
      } catch (e) {
        // ignore storage quota errors
      }
    }

    function sanitizeForLog(text) {
      if (!text) return '';
      return String(text)
        .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
        .replace(/("?(?:password|token|authorization)"?\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
    }

    function writeErrorLog(code, message) {
      try {
        var list = Lampa.Storage.get(STORAGE_KEYS.ERROR_LOG, '[]');
        if (typeof list === 'string') list = JSON.parse(list);
        if (!Array.isArray(list)) list = [];
        list.unshift({
          time: new Date().toISOString(),
          code: code || 'UNKNOWN',
          message: sanitizeForLog(message)
        });
        if (list.length > logState.maxEntries) {
          list = list.slice(0, logState.maxEntries);
        }
        Lampa.Storage.set(STORAGE_KEYS.ERROR_LOG, list);
      } catch (e) {
        // ignore
      }
    }

    function getServerUrl() {
      var raw = String(getSetting(STORAGE_KEYS.SERVER_URL, DEFAULT_SETTINGS.serverUrl)).trim();
      return raw.replace(/\/+$/, '');
    }

    function getCubDomain() {
      if (Lampa.Manifest && Lampa.Manifest.cub_domain) {
        return Lampa.Manifest.cub_domain;
      }
      return 'cub.rip';
    }

    function getCubProtocol() {
      if (Lampa.Utils && typeof Lampa.Utils.protocol === 'function') {
        return Lampa.Utils.protocol();
      }
      return 'https://';
    }

    function getCubAccount() {
      var acc = Lampa.Storage.get('account', '{}');
      if (typeof acc === 'string') {
        try {
          acc = JSON.parse(acc);
        } catch (e) {
          acc = {};
        }
      }
      var syncEnabled = false;
      if (Lampa.Account && Lampa.Account.Permit) {
        syncEnabled = Boolean(Lampa.Account.Permit.sync);
      } else {
        syncEnabled = Boolean(acc && acc.token && Lampa.Storage.field('account_use'));
      }
      return {
        raw: acc || {},
        token: acc && acc.token ? acc.token : '',
        email: acc && acc.email ? acc.email : '',
        profileId: acc && acc.profile && acc.profile.id ? acc.profile.id : 0,
        profileName: acc && acc.profile && acc.profile.name ? acc.profile.name : 'Основной',
        syncEnabled: syncEnabled
      };
    }

    function cubRequest(path, method, data, options, callback, errorCallback) {
      var acc = getCubAccount();
      if (!acc.token || !acc.profileId) {
        errorCallback(createAppError(ERROR_CODES.CUB_CONNECTION_ERROR, 'Не выполнен вход в аккаунт CUB'));
        return;
      }

      var opts = options || {};
      var url = getCubProtocol() + getCubDomain() + '/api/' + path;
      var timeoutMs = opts.timeout || DEFAULT_SETTINGS.timeoutMs;
      var xhr = new XMLHttpRequest();
      var finished = false;
      var timer = setTimeout(function () {
        if (!finished) {
          finished = true;
          try { xhr.abort(); } catch (e) {}
          errorCallback(createAppError(ERROR_CODES.TIMEOUT, 'Тайм-аут запроса к CUB: ' + path));
        }
      }, timeoutMs);

      xhr.open(method || 'GET', url, true);
      xhr.setRequestHeader('token', acc.token);
      xhr.setRequestHeader('profile', String(acc.profileId));

      if (!opts.isFormData && method === 'POST') {
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
      }

      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || finished) return;
        finished = true;
        clearTimeout(timer);

        if (xhr.status >= 200 && xhr.status < 300) {
          if (opts.rawText) {
            callback(xhr.responseText);
            return;
          }
          try {
            callback(xhr.responseText ? JSON.parse(xhr.responseText) : {});
          } catch (e) {
            callback(xhr.responseText);
          }
        } else if (xhr.status === 401 || xhr.status === 403) {
          errorCallback(createAppError(ERROR_CODES.CUB_CONNECTION_ERROR, 'Токен CUB недействителен (' + xhr.status + ')'));
        } else {
          errorCallback(createAppError(ERROR_CODES.CUB_CONNECTION_ERROR, 'Ошибка CUB API HTTP ' + xhr.status));
        }
      };

      xhr.onerror = function () {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        errorCallback(createAppError(ERROR_CODES.CUB_CONNECTION_ERROR, 'Сетевая ошибка при обращении к CUB'));
      };

      if (opts.isFormData) {
        xhr.send(data);
      } else if (method === 'POST' && data && typeof data === 'object') {
        var pairs = [];
        var keys = Object.keys(data);
        for (var i = 0; i < keys.length; i++) {
          pairs.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(data[keys[i]]));
        }
        xhr.send(pairs.join('&'));
      } else {
        xhr.send();
      }
    }

    function htRequest(path, method, body, extraHeaders, callback, errorCallback) {
      var baseUrl = getServerUrl();
      if (!baseUrl || baseUrl.indexOf('http') !== 0) {
        errorCallback(createAppError(ERROR_CODES.SERVER_UNAVAILABLE, 'Не задан корректный URL сервера'));
        return;
      }

      var url = baseUrl + path;
      var xhr = new XMLHttpRequest();
      var finished = false;
      var timer = setTimeout(function () {
        if (!finished) {
          finished = true;
          try { xhr.abort(); } catch (e) {}
          errorCallback(createAppError(ERROR_CODES.TIMEOUT, 'Тайм-аут сервера History Transfer'));
        }
      }, DEFAULT_SETTINGS.timeoutMs);

      xhr.open(method || 'GET', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');

      var token = getSetting(STORAGE_KEYS.AUTH_TOKEN, '');
      if (token) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      }
      if (extraHeaders) {
        var hKeys = Object.keys(extraHeaders);
        for (var i = 0; i < hKeys.length; i++) {
          xhr.setRequestHeader(hKeys[i], extraHeaders[hKeys[i]]);
        }
      }

      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || finished) return;
        finished = true;
        clearTimeout(timer);

        var parsed = null;
        try {
          parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch (e) {
          parsed = null;
        }

        if (xhr.status >= 200 && xhr.status < 300 && parsed && parsed.ok !== false) {
          callback(parsed);
          return;
        }

        var msg = parsed && parsed.error && parsed.error.message ? parsed.error.message : ('HTTP ' + xhr.status);
        if (xhr.status === 401) {
          errorCallback(createAppError(ERROR_CODES.AUTH_ERROR, msg));
        } else if (xhr.status === 404) {
          errorCallback(createAppError(ERROR_CODES.BACKUP_NOT_FOUND, msg));
        } else if (xhr.status === 413) {
          errorCallback(createAppError(ERROR_CODES.PAYLOAD_TOO_LARGE, msg));
        } else if (xhr.status === 400 && parsed && parsed.error && parsed.error.code === 'INCOMPATIBLE_FORMAT') {
          errorCallback(createAppError(ERROR_CODES.INCOMPATIBLE_FORMAT, msg));
        } else if (xhr.status === 0) {
          errorCallback(createAppError(ERROR_CODES.SERVER_UNAVAILABLE, 'Сервер не отвечает'));
        } else {
          errorCallback(createAppError(ERROR_CODES.UPLOAD_ERROR, msg));
        }
      };

      xhr.onerror = function () {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        errorCallback(createAppError(ERROR_CODES.SERVER_UNAVAILABLE, 'Сетевая ошибка сервера History Transfer'));
      };

      xhr.send(body ? JSON.stringify(body) : null);
    }

    function getLocalProfileData() {
      var fav = Lampa.Storage.get('favorite', '{}');
      if (typeof fav === 'string') {
        try { fav = JSON.parse(fav); } catch (e) { fav = {}; }
      }
      return normalizeProfileStructure(fav);
    }

    function getLocalTimelineData(profileId) {
      var key = profileId ? ('file_view_' + profileId) : 'file_view';
      var tl = Lampa.Storage.get(key, '{}');
      if (typeof tl === 'string') {
        try { tl = JSON.parse(tl); } catch (e) { tl = {}; }
      }
      return normalizeTimeline(tl);
    }

    function fetchFullAccountSnapshot(onProgress, onSuccess, onError) {
      var acc = getCubAccount();
      var localProfile = getLocalProfileData();
      var localTimeline = getLocalTimelineData(acc.profileId);

      if (!acc.token || !acc.profileId) {
        onProgress('Чтение локального профиля Lampa...');
        var localMerged = validateAndDeduplicateProfile(localProfile);
        onSuccess({
          profile: localMerged.profile,
          timeline: localTimeline,
          cubConnected: false,
          account: acc
        });
        return;
      }

      onProgress('Этап 2/5: Загрузка закладок и истории с сервера CUB...');
      cubRequest('bookmarks/dump', 'GET', null, { rawText: true }, function (bmText) {
        var cubProfile;
        try {
          cubProfile = parseCubBookmarksDump(bmText).profile;
        } catch (e) {
          onError(e);
          return;
        }

        // Объединяем серверные данные CUB с локальными несинхронизированными (приоритет CUB)
        var combinedProfile = mergeProfiles(cubProfile, localProfile, 'merge').merged;

        onProgress('Этап 2/5: Загрузка прогресса фильмов и серий (Timeline)...');
        cubRequest('timeline/dump', 'GET', null, { rawText: true }, function (tlText) {
          var cubTimeline;
          try {
            cubTimeline = parseCubTimelineDump(tlText);
          } catch (e) {
            cubTimeline = {};
          }
          var combinedTimeline = mergeTimelines(cubTimeline, localTimeline, 'merge').merged;

          onSuccess({
            profile: combinedProfile,
            timeline: combinedTimeline,
            cubConnected: true,
            account: acc
          });
        }, function () {
          // Если timeline/dump недоступен, используем локальный timeline, не прерывая экспорт
          onSuccess({
            profile: combinedProfile,
            timeline: localTimeline,
            cubConnected: true,
            account: acc
          });
        });
      }, function (err) {
        onError(err);
      });
    }

    function showProgressModal(title, initialText) {
      var html = $(
        '<div class="ht-progress-box" style="padding:1.2em;">' +
          '<div class="ht-progress-status" style="font-size:1.15em;margin-bottom:0.8em;">' + initialText + '</div>' +
          '<div style="width:100%;height:8px;background:rgba(255,255,255,0.15);border-radius:4px;overflow:hidden;">' +
            '<div class="ht-progress-bar" style="width:15%;height:100%;background:#f5c518;transition:width 0.25s;"></div>' +
          '</div>' +
        '</div>'
      );

      Lampa.Modal.open({
        title: title,
        html: html,
        size: 'medium',
        onBack: function () {
          Lampa.Modal.close();
          Lampa.Controller.toggle('content');
        }
      });

      return {
        update: function (text, percent) {
          html.find('.ht-progress-status').text(text);
          if (percent !== undefined) {
            html.find('.ht-progress-bar').css('width', Math.max(5, Math.min(100, percent)) + '%');
          }
        },
        close: function () {
          Lampa.Modal.close();
        }
      };
    }

    function handleErrorAndShow(err, contextTitle) {
      var code = err && err.code ? err.code : 'UNKNOWN';
      var message = (err && err.message) || 'Неизвестная ошибка';
      if (err && err.detail && message.indexOf(err.detail) === -1) {
        message += ' (' + err.detail + ')';
      }
      writeErrorLog(code, (contextTitle ? contextTitle + ': ' : '') + message);
      Lampa.Noty.show(message);
    }

    // =========================================================================
    // ЭКСПОРТ СТАРОГО АККАУНТА
    // =========================================================================
    function startExportFlow() {
      var htToken = getSetting(STORAGE_KEYS.AUTH_TOKEN, '');
      if (!htToken) {
        Lampa.Noty.show('Сначала войдите в аккаунт History Transfer');
        openAuthMenu();
        return;
      }

      var progress = showProgressModal('📤 Сохранение истории', 'Этап 1/5: Проверка аккаунта CUB и сервера...');

      htRequest('/api/health', 'GET', null, null, function () {
        progress.update('Этап 1/5: Проверка подключения к CUB...', 20);
        fetchFullAccountSnapshot(function (msg) {
          progress.update(msg, 45);
        }, function (snapshot) {
          progress.update('Этап 3/5: Проверка структуры и удаление дубликатов...', 65);

          var deduped = validateAndDeduplicateProfile(snapshot.profile);
          var stats = computeProfileStats(deduped.profile, snapshot.timeline, 0);

          if (stats.cardsCount === 0 && stats.historyCount === 0 && stats.bookCount === 0 && stats.timelineCount === 0) {
            progress.close();
            handleErrorAndShow(createAppError(ERROR_CODES.INSUFFICIENT_DATA, 'В профиле нет ни карточек, ни истории, ни закладок'), 'Экспорт');
            return;
          }

          progress.update('Этап 4/5: Формирование резервной копии...', 75);
          var userObj = getSetting(STORAGE_KEYS.AUTH_USER, {});
          if (typeof userObj === 'string') {
            try { userObj = JSON.parse(userObj); } catch (e) { userObj = {}; }
          }

          var backupPayload = buildBackupPayload({
            userId: userObj && userObj.id ? userObj.id : '',
            profile: deduped.profile,
            timeline: snapshot.timeline,
            sourceMeta: {
              lampaVersion: Lampa.Manifest && Lampa.Manifest.app_version ? Lampa.Manifest.app_version : 'unknown',
              cubDomain: getCubDomain(),
              cubProfileId: snapshot.account.profileId,
              accountSyncEnabled: snapshot.cubConnected
            }
          });

          // Сохраняем локально до отправки, чтобы не потерять при сбое сети
          setSetting(STORAGE_KEYS.PENDING_BACKUP, backupPayload);

          progress.update('Этап 5/5: Отправка резервной копии в облако...', 88);
          htRequest('/api/backups', 'POST', backupPayload, {
            'X-Idempotency-Key': backupPayload.backupId
          }, function (res) {
            progress.close();
            setSetting(STORAGE_KEYS.PENDING_BACKUP, '');
            setSetting(STORAGE_KEYS.LAST_BACKUP_AT, res.backup.createdAt);

            var st = res.backup.stats;
            var summaryHtml = $(
              '<div style="padding:1em;line-height:1.6;">' +
                '<div style="font-size:1.2em;color:#4cd964;margin-bottom:0.6em;">История успешно сохранена!</div>' +
                '<div>• Фильмов и сериалов в базе: <b>' + st.cardsCount + '</b> (фильмов: ' + st.moviesCount + ', сериалов: ' + st.seriesCount + ')</div>' +
                '<div>• Записей истории: <b>' + st.historyCount + '</b></div>' +
                '<div>• Закладок: <b>' + st.bookCount + '</b></div>' +
                '<div>• Просмотренных элементов: <b>' + st.viewedCount + '</b></div>' +
                '<div>• Прогресс серий и таймкоды: <b>' + st.timelineCount + '</b></div>' +
                '<div>• Размер резервной копии: <b>' + formatBytes(st.sizeBytes) + '</b></div>' +
              '</div>'
            );
            Lampa.Modal.open({
              title: 'Готово',
              html: summaryHtml,
              size: 'medium',
              onBack: function () {
                Lampa.Modal.close();
                openMainMenu();
              }
            });
          }, function (err) {
            progress.close();
            handleErrorAndShow(err, 'Отправка в облако');
          });
        }, function (err) {
          progress.close();
          handleErrorAndShow(err, 'Получение профиля');
        });
      }, function (err) {
        progress.close();
        handleErrorAndShow(err, 'Проверка сервера');
      });
    }

    // =========================================================================
    // ИМПОРТ И ВОССТАНОВЛЕНИЕ НА НОВОМ АККАУНТЕ
    // =========================================================================
    function startImportFlow() {
      var htToken = getSetting(STORAGE_KEYS.AUTH_TOKEN, '');
      if (!htToken) {
        Lampa.Noty.show('Сначала войдите в аккаунт History Transfer');
        openAuthMenu();
        return;
      }

      var progress = showProgressModal('📥 Восстановление истории', 'Этап 2/6: Поиск резервных копий в облаке...');
      htRequest('/api/backups', 'GET', null, null, function (res) {
        progress.close();
        var list = res.backups || [];
        if (!list.length) {
          Lampa.Noty.show('У вас пока нет сохранённых резервных копий');
          return;
        }

        var items = list.map(function (b) {
          return {
            title: b.name,
            subtitle: 'Дата: ' + b.createdAt.slice(0, 16).replace('T', ' ') +
              ' | Фильмов: ' + b.moviesCount +
              ' | Сериалов: ' + b.seriesCount +
              ' | История: ' + b.historyCount +
              ' | Закладки: ' + b.bookCount,
            backupMeta: b
          };
        });

        Lampa.Select.show({
          title: 'Выберите резервную копию для восстановления',
          items: items,
          onSelect: function (item) {
            chooseImportModeAndRun(item.backupMeta.id);
          },
          onBack: function () {
            openMainMenu();
          }
        });
      }, function (err) {
        progress.close();
        handleErrorAndShow(err, 'Список резервных копий');
      });
    }

    function chooseImportModeAndRun(backupId) {
      Lampa.Select.show({
        title: 'Режим восстановления',
        items: [
          {
            title: 'Безопасное объединение (рекомендуется)',
            subtitle: 'Сохраняет текущую историю нового аккаунта и добавляет недостающее без дубликатов',
            mode: 'merge'
          },
          {
            title: 'Полная замена профиля',
            subtitle: 'Сначала создаст бэкап текущего профиля, затем очистит его и запишет копию',
            mode: 'replace'
          }
        ],
        onSelect: function (choice) {
          if (choice.mode === 'replace') {
            Lampa.Select.show({
              title: 'Подтвердите полную замену профиля',
              items: [
                { title: 'Да, создать резервную копию текущего профиля и заменить', confirm: true },
                { title: 'Отмена', confirm: false }
              ],
              onSelect: function (c) {
                if (c.confirm) {
                  executeImportWithSafetyBackup(backupId, 'replace');
                } else {
                  openMainMenu();
                }
              },
              onBack: function () {
                openMainMenu();
              }
            });
          } else {
            executeImport(backupId, 'merge');
          }
        },
        onBack: function () {
          openMainMenu();
        }
      });
    }

    function executeImportWithSafetyBackup(backupId, mode) {
      var progress = showProgressModal('🛡️ Страховочная копия', 'Создание резервной копии текущего профиля перед заменой...');
      fetchFullAccountSnapshot(function () {}, function (snapshot) {
        var safetyPayload = buildBackupPayload({
          name: 'Авто-бэкап перед заменой ' + new Date().toISOString().slice(0, 16).replace('T', ' '),
          profile: snapshot.profile,
          timeline: snapshot.timeline,
          sourceMeta: { autoSafetyBackup: true, cubProfileId: snapshot.account.profileId }
        });
        htRequest('/api/backups', 'POST', safetyPayload, {
          'X-Idempotency-Key': safetyPayload.backupId
        }, function () {
          progress.close();
          executeImport(backupId, mode);
        }, function (err) {
          progress.close();
          handleErrorAndShow(err, 'Страховочный бэкап не удался, замена отменена');
        });
      }, function (err) {
        progress.close();
        handleErrorAndShow(err, 'Не удалось прочитать текущий профиль');
      });
    }

    function executeImport(backupId, mode) {
      var acc = getCubAccount();
      if (!acc.token || !acc.profileId) {
        handleErrorAndShow(createAppError(ERROR_CODES.CUB_CONNECTION_ERROR, 'Войдите в новый аккаунт CUB перед восстановлением'), 'Импорт');
        return;
      }

      var progress = showProgressModal('📥 Восстановление истории', 'Этап 3/6: Проверка нового аккаунта CUB...');

      fetchFullAccountSnapshot(function (msg) {
        progress.update(msg, 15);
      }, function (currentSnapshot) {
        progress.update('Этап 4/6: Загрузка резервной копии из облака...', 30);

        htRequest('/api/backups/' + encodeURIComponent(backupId), 'GET', null, null, function (res) {
          var backup = res.backup;
          try {
            validateBackupForImport(backup);
          } catch (e) {
            progress.close();
            handleErrorAndShow(e, 'Проверка формата');
            return;
          }

          var prep = prepareImportOperations(currentSnapshot.profile, backup.profile, mode);
          var mergedProfileRes = mergeProfiles(currentSnapshot.profile, backup.profile, mode);
          var mergedTimelineRes = mergeTimelines(currentSnapshot.timeline, backup.timeline, mode);

          function runWritePhase() {
            var ops = prep.operations;
            var totalOps = ops.length;
            var idx = 0;
            var writtenCount = 0;
            var failedOps = [];
            var delayMs = Number(DEFAULT_SETTINGS.cubWriteDelayMs) || 100;

            function nextBookmarkOp() {
              if (idx >= totalOps) {
                writeTimelinePhase();
                return;
              }
              var op = ops[idx++];
              var pct = 45 + Math.round((idx / Math.max(1, totalOps)) * 35);
              progress.update('Этап 5/6: Запись карточек и истории (' + idx + '/' + totalOps + ')...', pct);

              cubRequest('bookmarks/add', 'POST', {
                type: op.type,
                data: JSON.stringify(op.card),
                card_id: op.card_id,
                id: 0
              }, null, function () {
                writtenCount++;
                setTimeout(nextBookmarkOp, delayMs);
              }, function (err) {
                failedOps.push({ op: op, error: err ? err.message : 'Ошибка записи' });
                setTimeout(nextBookmarkOp, delayMs);
              });
            }

            function writeTimelinePhase() {
              var tlKeys = Object.keys(mergedTimelineRes.merged);
              if (tlKeys.length === 0) {
                finishAndVerify();
                return;
              }

              progress.update('Этап 5/6: Восстановление прогресса серий и таймкодов (' + tlKeys.length + ')...', 84);
              var tlKey = acc.profileId ? ('file_view_' + acc.profileId) : 'file_view';
              setSetting(tlKey, mergedTimelineRes.merged);
              if (Lampa.Timeline && typeof Lampa.Timeline.read === 'function') {
                try { Lampa.Timeline.read(); } catch (e) {}
              }

              if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
                var fd = new FormData();
                var blob = new Blob([JSON.stringify(mergedTimelineRes.merged)], { type: 'application/json' });
                fd.append('file', blob, 'timelines.json');
                cubRequest('timeline/import', 'POST', fd, { isFormData: true }, function () {
                  finishAndVerify();
                }, function () {
                  fallbackTimelineUpdate(tlKeys);
                });
              } else {
                fallbackTimelineUpdate(tlKeys);
              }
            }

            function fallbackTimelineUpdate(keys) {
              var tIdx = 0;
              function nextTl() {
                if (tIdx >= keys.length) {
                  finishAndVerify();
                  return;
                }
                var h = keys[tIdx++];
                var item = mergedTimelineRes.merged[h];
                var payload = cloneSimple(item);
                payload.hash = h;
                cubRequest('timeline/update', 'POST', payload, null, function () {
                  setTimeout(nextTl, 60);
                }, function () {
                  setTimeout(nextTl, 60);
                });
              }
              nextTl();
            }

            function finishAndVerify() {
              // Обновляем локальный кэш Lampa
              setSetting('favorite', mergedProfileRes.merged);
              if (Lampa.Account && Lampa.Account.Bookmarks && typeof Lampa.Account.Bookmarks.update === 'function') {
                try { Lampa.Account.Bookmarks.update(); } catch (e) {}
              }
              if (Lampa.Favorite && typeof Lampa.Favorite.read === 'function') {
                try { Lampa.Favorite.read(); } catch (e) {}
              }

              progress.update('Этап 6/6: Проверка фактически записанных данных в CUB...', 94);
              fetchFullAccountSnapshot(function () {}, function (afterSnapshot) {
                progress.close();
                var check = verifyImportResult(
                  backup.profile,
                  afterSnapshot.profile,
                  backup.timeline,
                  afterSnapshot.timeline
                );

                var statusTitle = check.ok && failedOps.length === 0
                  ? '<div style="font-size:1.2em;color:#4cd964;margin-bottom:0.6em;">Восстановление успешно завершено!</div>'
                  : '<div style="font-size:1.2em;color:#ff9500;margin-bottom:0.6em;">Восстановление завершено с замечаниями</div>';

                var reportHtml = $(
                  '<div style="padding:1em;line-height:1.6;">' +
                    statusTitle +
                    '<div>• Записано новых записей в CUB: <b>' + writtenCount + '</b></div>' +
                    '<div>• Уже существовало в новом аккаунте: <b>' + prep.existedCount + '</b></div>' +
                    '<div>• Объединено таймкодов (включая серии): <b>' + (mergedTimelineRes.stats.added + mergedTimelineRes.stats.updated) + '</b></div>' +
                    '<div>• Подтверждено в новом профиле: <b>' + check.totalVerifiedItems + ' / ' + check.totalExpectedItems + '</b></div>' +
                    '<div>• Ошибок записи: <b>' + failedOps.length + '</b></div>' +
                  '</div>'
                );

                Lampa.Modal.open({
                  title: 'Результат восстановления',
                  html: reportHtml,
                  size: 'medium',
                  onBack: function () {
                    Lampa.Modal.close();
                    openMainMenu();
                  }
                });
              }, function (err) {
                progress.close();
                handleErrorAndShow(err, 'Не удалось проверить результат в CUB');
              });
            }

            nextBookmarkOp();
          }

          if (mode === 'replace') {
            progress.update('Этап 5/6: Очистка текущего профиля перед заменой...', 40);
            var clearCats = PROFILE_CATEGORIES.slice();
            var cIdx = 0;
            function nextClear() {
              if (cIdx >= clearCats.length) {
                runWritePhase();
                return;
              }
              var group = clearCats[cIdx++];
              cubRequest('bookmarks/clear', 'POST', { type: 'group', group: group }, null, function () {
                setTimeout(nextClear, 80);
              }, function () {
                setTimeout(nextClear, 80);
              });
            }
            nextClear();
          } else {
            runWritePhase();
          }
        }, function (err) {
          progress.close();
          handleErrorAndShow(err, 'Загрузка резервной копии');
        });
      }, function (err) {
        progress.close();
        handleErrorAndShow(err, 'Проверка нового аккаунта');
      });
    }

    // =========================================================================
    // UI В СТИЛЕ LAMPA (С ПОДДЕРЖКОЙ ПУЛЬТА TV / ANDROID TV / DESKTOP / MOBILE)
    // =========================================================================
    function openMainMenu() {
      var user = getSetting(STORAGE_KEYS.AUTH_USER, null);
      if (typeof user === 'string') {
        try { user = JSON.parse(user); } catch (e) { user = null; }
      }
      var accLabel = user && user.username ? (' (' + user.username + ')') : ' (не выполнен вход)';
      var pending = getSetting(STORAGE_KEYS.PENDING_BACKUP, '');

      var items = [
        { title: '📤 Сохранить историю', subtitle: 'Экспорт профиля, истории и прогресса серий в облако', action: 'export' },
        { title: '📥 Восстановить историю', subtitle: 'Выбор резервной копии и перенос в текущий аккаунт CUB', action: 'import' },
        { title: '👤 Мой аккаунт' + accLabel, subtitle: 'Регистрация, вход и выход в системе History Transfer', action: 'account' },
        { title: '☁️ Облачное хранилище', subtitle: 'Проверка состояния сервера и дата последнего сохранения', action: 'cloud' },
        { title: '📋 Мои резервные копии', subtitle: 'Просмотр, восстановление и удаление копий', action: 'backups' },
        { title: '⚙️ Настройки', subtitle: 'Адрес сервера, режим импорта и журнал ошибок', action: 'settings' }
      ];

      if (pending) {
        items.unshift({
          title: '🔄 Повторить отправку неотправленной копии',
          subtitle: 'Есть локально сохранённая копия после сбоя сети',
          action: 'retry_pending'
        });
      }

      Lampa.Select.show({
        title: 'LAMPA HISTORY TRANSFER',
        items: items,
        onSelect: function (item) {
          if (item.action === 'export') startExportFlow();
          else if (item.action === 'import') startImportFlow();
          else if (item.action === 'account') openAuthMenu();
          else if (item.action === 'cloud') openCloudStatus();
          else if (item.action === 'backups') openBackupsManager();
          else if (item.action === 'settings') openSettingsMenu();
          else if (item.action === 'retry_pending') retryPendingBackup();
        },
        onBack: function () {
          Lampa.Controller.toggle('content');
        }
      });
    }

    function retryPendingBackup() {
      var pending = getSetting(STORAGE_KEYS.PENDING_BACKUP, '');
      if (!pending) {
        Lampa.Noty.show('Нет неотправленных копий');
        return;
      }
      var progress = showProgressModal('🔄 Повторная отправка', 'Отправка сохранённой копии в облако...');
      htRequest('/api/backups', 'POST', pending, {
        'X-Idempotency-Key': pending.backupId || generateUuid()
      }, function (res) {
        progress.close();
        setSetting(STORAGE_KEYS.PENDING_BACKUP, '');
        setSetting(STORAGE_KEYS.LAST_BACKUP_AT, res.backup.createdAt);
        Lampa.Noty.show('История успешно сохранена!');
        openMainMenu();
      }, function (err) {
        progress.close();
        handleErrorAndShow(err, 'Повторная отправка');
      });
    }

    function promptText(title, defaultValue, isPassword, onDone) {
      if (Lampa.Input && typeof Lampa.Input.edit === 'function') {
        Lampa.Input.edit({
          title: title,
          value: defaultValue || '',
          free: true,
          nosave: true,
          password: Boolean(isPassword)
        }, function (val) {
          onDone(String(val || '').trim());
        });
      } else {
        var val = window.prompt(title, defaultValue || '');
        if (val !== null) onDone(String(val).trim());
      }
    }

    function openAuthMenu() {
      var token = getSetting(STORAGE_KEYS.AUTH_TOKEN, '');
      var items = [];
      if (token) {
        items.push({ title: 'Выйти из аккаунта History Transfer', action: 'logout' });
      } else {
        items.push({ title: 'Войти в существующий аккаунт', action: 'login' });
        items.push({ title: 'Зарегистрировать новый аккаунт', action: 'register' });
      }
      items.push({ title: 'Назад', action: 'back' });

      Lampa.Select.show({
        title: '👤 Аккаунт History Transfer',
        items: items,
        onSelect: function (item) {
          if (item.action === 'login') performAuth('login');
          else if (item.action === 'register') performAuth('register');
          else if (item.action === 'logout') {
            htRequest('/api/auth/logout', 'POST', {}, null, function () {
              setSetting(STORAGE_KEYS.AUTH_TOKEN, '');
              setSetting(STORAGE_KEYS.AUTH_USER, '');
              Lampa.Noty.show('Вы вышли из аккаунта History Transfer');
              openMainMenu();
            }, function () {
              setSetting(STORAGE_KEYS.AUTH_TOKEN, '');
              setSetting(STORAGE_KEYS.AUTH_USER, '');
              openMainMenu();
            });
          } else {
            openMainMenu();
          }
        },
        onBack: function () {
          openMainMenu();
        }
      });
    }

    function performAuth(mode) {
      var label = mode === 'register' ? 'Регистрация: введите логин (3-32 символа)' : 'Вход: введите логин';
      promptText(label, '', false, function (username) {
        if (!username) {
          openAuthMenu();
          return;
        }
        promptText('Введите пароль (от 8 символов)', '', true, function (password) {
          if (!password) {
            openAuthMenu();
            return;
          }
          var endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
          var progress = showProgressModal('Авторизация', 'Подключение к серверу...');
          htRequest(endpoint, 'POST', { username: username, password: password }, null, function (res) {
            progress.close();
            setSetting(STORAGE_KEYS.AUTH_TOKEN, res.token);
            setSetting(STORAGE_KEYS.AUTH_USER, res.user);
            Lampa.Noty.show('Успешный вход: ' + res.user.displayName);
            openMainMenu();
          }, function (err) {
            progress.close();
            handleErrorAndShow(err, 'Авторизация');
            openAuthMenu();
          });
        });
      });
    }

    function openCloudStatus() {
      var progress = showProgressModal('☁️ Облачное хранилище', 'Проверка состояния сервера...');
      htRequest('/api/health', 'GET', null, null, function (health) {
        var token = getSetting(STORAGE_KEYS.AUTH_TOKEN, '');
        if (!token) {
          progress.close();
          Lampa.Noty.show('Сервер работает (v' + health.version + '). Войдите в аккаунт для просмотра статистики.');
          openMainMenu();
          return;
        }
        htRequest('/api/auth/me', 'GET', null, null, function (me) {
          progress.close();
          var lastDate = me.lastBackupAt ? me.lastBackupAt.slice(0, 16).replace('T', ' ') : 'нет';
          Lampa.Noty.show('Сервер ОК | Копий: ' + me.backupsCount + ' | Последняя: ' + lastDate);
          openMainMenu();
        }, function (err) {
          progress.close();
          handleErrorAndShow(err, 'Профиль облака');
        });
      }, function (err) {
        progress.close();
        handleErrorAndShow(err, 'Проверка облака');
      });
    }

    function openBackupsManager() {
      var token = getSetting(STORAGE_KEYS.AUTH_TOKEN, '');
      if (!token) {
        Lampa.Noty.show('Сначала войдите в аккаунт History Transfer');
        openAuthMenu();
        return;
      }

      var progress = showProgressModal('📋 Мои резервные копии', 'Загрузка списка...');
      htRequest('/api/backups', 'GET', null, null, function (res) {
        progress.close();
        var list = res.backups || [];
        if (!list.length) {
          Lampa.Noty.show('Резервных копий пока нет');
          openMainMenu();
          return;
        }

        var items = list.map(function (b) {
          return {
            title: b.name,
            subtitle: b.createdAt.slice(0, 16).replace('T', ' ') + ' | ' + formatBytes(b.sizeBytes) + ' | Карточек: ' + b.cardsCount,
            backup: b
          };
        });

        Lampa.Select.show({
          title: 'Мои резервные копии',
          items: items,
          onSelect: function (item) {
            Lampa.Select.show({
              title: item.backup.name,
              items: [
                { title: '📥 Восстановить эту копию', action: 'restore' },
                { title: '🗑️ Удалить копию', action: 'delete' },
                { title: 'Назад', action: 'back' }
              ],
              onSelect: function (sub) {
                if (sub.action === 'restore') {
                  chooseImportModeAndRun(item.backup.id);
                } else if (sub.action === 'delete') {
                  htRequest('/api/backups/' + encodeURIComponent(item.backup.id), 'DELETE', null, null, function () {
                    Lampa.Noty.show('Резервная копия удалена');
                    openBackupsManager();
                  }, function (err) {
                    handleErrorAndShow(err, 'Удаление копии');
                  });
                } else {
                  openBackupsManager();
                }
              },
              onBack: function () {
                openBackupsManager();
              }
            });
          },
          onBack: function () {
            openMainMenu();
          }
        });
      }, function (err) {
        progress.close();
        handleErrorAndShow(err, 'Список копий');
      });
    }

    function openSettingsMenu() {
      var currentUrl = getServerUrl();
      Lampa.Select.show({
        title: '⚙️ Настройки History Transfer',
        items: [
          { title: 'URL сервера облака', subtitle: currentUrl, action: 'server_url' },
          { title: 'Посмотреть журнал ошибок', subtitle: 'Последние 50 записей (без паролей и токенов)', action: 'logs' },
          { title: 'Очистить журнал ошибок', action: 'clear_logs' },
          { title: 'Назад', action: 'back' }
        ],
        onSelect: function (item) {
          if (item.action === 'server_url') {
            promptText('Введите HTTPS URL сервера History Transfer', currentUrl, false, function (val) {
              if (val) {
                setSetting(STORAGE_KEYS.SERVER_URL, val);
                Lampa.Noty.show('URL сервера сохранён');
              }
              openSettingsMenu();
            });
          } else if (item.action === 'logs') {
            var logs = Lampa.Storage.get(STORAGE_KEYS.ERROR_LOG, '[]');
            if (typeof logs === 'string') {
              try { logs = JSON.parse(logs); } catch (e) { logs = []; }
            }
            var htmlText = logs.length
              ? logs.map(function (l) {
                return '<div style="margin-bottom:0.4em;">[' + l.time + '] <b>' + l.code + '</b>: ' + l.message + '</div>';
              }).join('')
              : '<div>Журнал ошибок пуст</div>';
            Lampa.Modal.open({
              title: 'Технический журнал ошибок',
              html: $('<div style="padding:1em;max-height:60vh;overflow:auto;">' + htmlText + '</div>'),
              size: 'large',
              onBack: function () {
                Lampa.Modal.close();
                openSettingsMenu();
              }
            });
          } else if (item.action === 'clear_logs') {
            setSetting(STORAGE_KEYS.ERROR_LOG, []);
            Lampa.Noty.show('Журнал очищен');
            openSettingsMenu();
          } else {
            openMainMenu();
          }
        },
        onBack: function () {
          openMainMenu();
        }
      });
    }

    function addMenuButton() {
      var menuItem = $(
        '<li class="menu__item selector" data-action="history_transfer">' +
          '<div class="menu__ico">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
              '<path d="M12 3v12m0 0l-4-4m4 4l4-4"/>' +
              '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>' +
            '</svg>' +
          '</div>' +
          '<div class="menu__text">History Transfer</div>' +
        '</li>'
      );

      menuItem.on('hover:enter', function () {
        openMainMenu();
      });

      $('.menu .menu__list').eq(0).append(menuItem);
    }

    if (window.appready) {
      addMenuButton();
    } else if (Lampa.Listener) {
      Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') {
          addMenuButton();
        }
      });
    }
  }

  return {
    PLUGIN_ID: PLUGIN_ID,
    PLUGIN_VERSION: PLUGIN_VERSION,
    FORMAT_VERSION: FORMAT_VERSION,
    PROFILE_CATEGORIES: PROFILE_CATEGORIES,
    ERROR_CODES: ERROR_CODES,
    ERROR_MESSAGES: ERROR_MESSAGES,
    createAppError: createAppError,
    parseCubBookmarksDump: parseCubBookmarksDump,
    parseCubTimelineDump: parseCubTimelineDump,
    normalizeProfileStructure: normalizeProfileStructure,
    normalizeTimeline: normalizeTimeline,
    validateAndDeduplicateProfile: validateAndDeduplicateProfile,
    computeProfileStats: computeProfileStats,
    buildBackupPayload: buildBackupPayload,
    validateBackupForImport: validateBackupForImport,
    mergeProfiles: mergeProfiles,
    mergeTimelines: mergeTimelines,
    prepareImportOperations: prepareImportOperations,
    verifyImportResult: verifyImportResult,
    initLampaPlugin: initLampaPlugin
  };
});
