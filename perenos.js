(function () {
    'use strict';

    // Защита от повторной инициализации плагина
    if (window.lampa_history_transfer_plugin) return;
    window.lampa_history_transfer_plugin = true;

    var PLUGIN_ID = 'history_transfer';
    var PLUGIN_NAME = 'History Transfer';
    var PLUGIN_VERSION = '2.0.0';
    var ARCHIVE_VERSION = 2;

    var STORAGE_KEYS = {
        API_URL: 'ht_v2_api_url',
        OPERATIONS_LOG: 'ht_v2_operations_log',
        LOCAL_BACKUP_SLOT: 'ht_v2_local_backup_slot',
        AUTO_SYNC_CUB: 'ht_v2_auto_sync_cub',
        INCLUDE_TIMELINE: 'ht_v2_include_timeline',
        LAST_ACTIVE_CODE: 'ht_v2_last_active_code'
    };

    var DEFAULT_API_URL = (window.LAMPA_HISTORY_TRANSFER_CONFIG && window.LAMPA_HISTORY_TRANSFER_CONFIG.apiUrl)
        || 'https://lampa-history-transfer.your-subdomain.workers.dev';

    // Все 8 списков профиля Lampa/CUB, привязанных к массиву полных карточек `card`
    var FAVORITE_LIST_KEYS = [
        'history',    // История просмотров
        'book',       // Закладки
        'like',       // Избранное / Понравилось
        'wath',       // Смотрю
        'viewed',     // Просмотрено (фильмы и сериалы)
        'scheduled',  // Отложенный просмотр (Запланировано)
        'continued',  // Продолжаю смотреть
        'thrown'      // Брошено
    ];

    var LIST_TITLES = {
        history: 'История просмотров',
        book: 'Закладки',
        like: 'Избранное (Понравилось)',
        wath: 'Смотрю',
        viewed: 'Просмотрено',
        scheduled: 'Отложенный просмотр',
        continued: 'Продолжаю смотреть',
        thrown: 'Брошено'
    };

    /**
     * ========================================================================
     * ВСПОМОГАТЕЛЬНЫЕ УТИЛИТЫ И КРИПТОГРАФИЯ
     * ========================================================================
     */
    var Utils = {
        getApiUrl: function () {
            var url = Lampa.Storage.get(STORAGE_KEYS.API_URL, DEFAULT_API_URL);
            return String(url || DEFAULT_API_URL).replace(/\/+$/, '');
        },

        getDeviceLabel: function () {
            var platform = (Lampa.Platform && typeof Lampa.Platform.get === 'function')
                ? Lampa.Platform.get()
                : 'Browser';
            return 'Lampa (' + platform + ')';
        },

        deepClone: function (obj) {
            try {
                return JSON.parse(JSON.stringify(obj));
            } catch (e) {
                return obj;
            }
        },

        formatCode: function (code) {
            var digits = String(code || '').replace(/[^0-9]/g, '');
            if (digits.length === 6) {
                return digits.slice(0, 3) + '-' + digits.slice(3);
            }
            return digits;
        },

        normalizeCode: function (code) {
            return String(code || '').replace(/[^0-9]/g, '');
        },

        sha256: function (str) {
            return new Promise(function (resolve) {
                if (window.crypto && window.crypto.subtle && window.TextEncoder) {
                    try {
                        var data = new TextEncoder().encode(str);
                        window.crypto.subtle.digest('SHA-256', data).then(function (buf) {
                            var arr = Array.from(new Uint8Array(buf));
                            var hex = arr.map(function (b) {
                                return b.toString(16).padStart(2, '0');
                            }).join('');
                            resolve(hex);
                        }).catch(function () {
                            resolve('');
                        });
                        return;
                    } catch (e) {}
                }
                resolve('');
            });
        },

        formatDate: function (ts) {
            if (!ts) return '—';
            var d = new Date(Number(ts));
            if (isNaN(d.getTime())) return '—';
            var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() +
                ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        },

        formatBytes: function (bytes) {
            if (!bytes || bytes <= 0) return '0 Б';
            if (bytes < 1024) return bytes + ' Б';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
            return (bytes / (1024 * 1024)).toFixed(2) + ' МБ';
        },

        escapeHtml: function (str) {
            return String(str || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        },

        notify: function (text, isError) {
            if (Lampa.Noty && Lampa.Noty.show) {
                Lampa.Noty.show(text, { time: isError ? 4500 : 3000 });
            } else {
                console.log('[HistoryTransfer]', text);
            }
        },

        copyToClipboard: function (text) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text).then(function () {
                    return true;
                }).catch(function () {
                    return false;
                });
            }
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                var ok = document.execCommand('copy');
                document.body.removeChild(ta);
                return Promise.resolve(Boolean(ok));
            } catch (e) {
                return Promise.resolve(false);
            }
        },

        logOperation: function (type, modeLabel, itemsCount, status) {
            var logs = Lampa.Storage.get(STORAGE_KEYS.OPERATIONS_LOG, []);
            if (!Array.isArray(logs)) logs = [];
            logs.unshift({
                id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                type: type,
                mode: modeLabel,
                items: itemsCount,
                status: status,
                timestamp: Date.now()
            });
            if (logs.length > 30) logs = logs.slice(0, 30);
            Lampa.Storage.set(STORAGE_KEYS.OPERATIONS_LOG, logs);
        }
    };

    /**
     * ========================================================================
     * СЕТЕВОЙ КЛИЕНТ CLOUDFLARE WORKERS API
     * ========================================================================
     */
    var ApiClient = {
        request: function (method, path, bodyData) {
            var baseUrl = Utils.getApiUrl();
            var timeoutMs = (window.LAMPA_HISTORY_TRANSFER_CONFIG && window.LAMPA_HISTORY_TRANSFER_CONFIG.requestTimeoutMs) || 25000;

            return new Promise(function (resolve, reject) {
                if (!baseUrl || baseUrl.indexOf('http') !== 0) {
                    reject(new Error('Некорректный URL сервера API. Проверьте раздел «Настройки».'));
                    return;
                }

                var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                var timeoutId = setTimeout(function () {
                    if (controller) controller.abort();
                }, timeoutMs);

                var options = {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Device-Name': Utils.getDeviceLabel()
                    }
                };

                if (controller) options.signal = controller.signal;
                if (bodyData !== undefined) options.body = JSON.stringify(bodyData);

                fetch(baseUrl + path, options)
                    .then(function (response) {
                        clearTimeout(timeoutId);
                        return response.text().then(function (text) {
                            var json = null;
                            try {
                                json = JSON.parse(text);
                            } catch (e) {
                                throw new Error('Сервер временно недоступен (ошибка ответа HTTP ' + response.status + ').');
                            }
                            if (!response.ok || (json && json.ok === false)) {
                                throw new Error((json && json.error) || ('Ошибка сервера HTTP ' + response.status));
                            }
                            return json;
                        });
                    })
                    .then(resolve)
                    .catch(function (err) {
                        clearTimeout(timeoutId);
                        if (err && err.name === 'AbortError') {
                            reject(new Error('Сервер временно недоступен (превышено время ожидания).'));
                        } else if (err && err.message === 'Failed to fetch') {
                            reject(new Error('Сервер временно недоступен. Проверьте подключение к интернету.'));
                        } else {
                            reject(err);
                        }
                    });
            });
        },

        health: function () {
            return this.request('GET', '/api/health');
        },

        createTransfer: function (archive, checksum) {
            return this.request('POST', '/api/transfer/create', {
                archive: archive,
                checksum: checksum
            });
        },

        inspectTransfer: function (code) {
            return this.request('POST', '/api/transfer/inspect', {
                code: Utils.normalizeCode(code)
            });
        },

        claimTransfer: function (code) {
            return this.request('POST', '/api/transfer/claim', {
                code: Utils.normalizeCode(code)
            });
        },

        cancelTransfer: function (code, deleteSecret) {
            return this.request('POST', '/api/transfer/cancel', {
                code: Utils.normalizeCode(code),
                delete_secret: deleteSecret
            });
        }
    };

    /**
     * ========================================================================
     * ДВИЖОК СБОРА (ЭКСПОРТА), ПРОВЕРКИ И АТОМАРНОГО ВОССТАНОВЛЕНИЯ (ИМПОРТА)
     * ========================================================================
     */
    var DataEngine = {
        /**
         * Чтение и нормализация объекта favorite со всеми 9 полями
         */
        readFavoriteData: function () {
            var raw = null;
            try {
                raw = Lampa.Storage.get('favorite', null);
                if ((!raw || !Array.isArray(raw.card)) && Lampa.Favorite && typeof Lampa.Favorite.all === 'function') {
                    raw = Lampa.Favorite.all();
                }
            } catch (e) {
                throw new Error('Не удалось получить данные из Lampa.');
            }

            if (!raw || typeof raw !== 'object') {
                raw = {};
            }

            var normalized = {
                card: Array.isArray(raw.card) ? Utils.deepClone(raw.card) : []
            };

            FAVORITE_LIST_KEYS.forEach(function (key) {
                normalized[key] = Array.isArray(raw[key]) ? raw[key].slice() : [];
            });

            return normalized;
        },

        /**
         * Подсчёт детальной статистики по всем поддерживаемым категориям
         */
        collectStats: function (dataSection) {
            var fav = (dataSection && dataSection.favorite) ? dataSection.favorite : this.readFavoriteData();
            var timeline = (dataSection && dataSection.timeline) ? dataSection.timeline : (Lampa.Storage.get('file_view', {}) || {});
            var onlineView = (dataSection && dataSection.online_view) ? dataSection.online_view : (Lampa.Storage.get('online_view', []) || []);
            var torrentsView = (dataSection && dataSection.torrents_view) ? dataSection.torrents_view : (Lampa.Storage.get('torrents_view', []) || []);

            var stats = {
                cards: Array.isArray(fav.card) ? fav.card.length : 0,
                byList: {},
                totalListsItems: 0,
                timelineCount: typeof timeline === 'object' && timeline !== null ? Object.keys(timeline).length : 0,
                episodesCount: (Array.isArray(onlineView) ? onlineView.length : 0) + (Array.isArray(torrentsView) ? torrentsView.length : 0)
            };

            FAVORITE_LIST_KEYS.forEach(function (key) {
                var count = Array.isArray(fav[key]) ? fav[key].length : 0;
                stats.byList[key] = count;
                stats.totalListsItems += count;
            });

            return stats;
        },

        /**
         * Сбор полного структурированного архива для переноса (без токенов и паролей)
         */
        buildExportArchive: function () {
            var includeTimeline = Lampa.Storage.get(STORAGE_KEYS.INCLUDE_TIMELINE, true);
            var favorite = this.readFavoriteData();

            // Дедупликация карточек с сохранением полных объектов TMDB/CUB
            var cardMap = {};
            var uniqueCards = [];
            favorite.card.forEach(function (c) {
                if (!c || c.id === undefined || c.id === null) return;
                var idStr = String(c.id);
                if (!cardMap[idStr]) {
                    cardMap[idStr] = c;
                    uniqueCards.push(c);
                }
            });
            favorite.card = uniqueCards;

            // Удаление дубликатов внутри каждого из 8 списков с сохранением порядка
            FAVORITE_LIST_KEYS.forEach(function (key) {
                var seen = {};
                var clean = [];
                favorite[key].forEach(function (id) {
                    var idStr = String(id);
                    if (!seen[idStr]) {
                        seen[idStr] = true;
                        clean.push(id);
                    }
                });
                favorite[key] = clean;
            });

            // Прогресс просмотра, сезоны и просмотренные серии
            var timeline = {};
            var onlineView = [];
            var torrentsView = [];
            var seasonView = {};

            if (includeTimeline) {
                var rawTimeline = Lampa.Storage.get('file_view', {});
                if (rawTimeline && typeof rawTimeline === 'object') {
                    Object.keys(rawTimeline).forEach(function (hash) {
                        var entry = rawTimeline[hash];
                        if (entry && typeof entry === 'object') {
                            timeline[hash] = {
                                hash: entry.hash || hash,
                                percent: Number(entry.percent || 0),
                                time: Number(entry.time || 0),
                                duration: Number(entry.duration || 0)
                            };
                        }
                    });
                }

                var rawOnline = Lampa.Storage.get('online_view', []);
                if (Array.isArray(rawOnline)) onlineView = rawOnline.slice();

                var rawTorrents = Lampa.Storage.get('torrents_view', []);
                if (Array.isArray(rawTorrents)) torrentsView = rawTorrents.slice();

                var rawSeasons = Lampa.Storage.get('season_view', {});
                if (rawSeasons && typeof rawSeasons === 'object') seasonView = Utils.deepClone(rawSeasons);
            }

            return {
                version: ARCHIVE_VERSION,
                created_at: Date.now(),
                source: 'lampa',
                plugin_version: PLUGIN_VERSION,
                data: {
                    favorite: favorite,
                    timeline: timeline,
                    online_view: onlineView,
                    torrents_view: torrentsView,
                    season_view: seasonView
                }
            };
        },

        /**
         * Проверка архива перед отправкой или импортом
         */
        validateArchive: function (archive, allowEmpty) {
            if (!archive || typeof archive !== 'object') {
                return 'Ошибка проверки данных: файл не является корректным JSON-архивом.';
            }
            if (!archive.version || Number(archive.version) > ARCHIVE_VERSION) {
                return 'Неподдерживаемая версия архива (' + (archive.version || 'неизвестна') + '). Обновите плагин.';
            }
            if (!archive.data || typeof archive.data !== 'object' || !archive.data.favorite) {
                return 'Ошибка проверки данных: отсутствует структура пользовательских списков.';
            }
            if (!Array.isArray(archive.data.favorite.card) || !Array.isArray(archive.data.favorite.history)) {
                return 'Ошибка проверки данных: повреждены списки карточек или истории.';
            }

            if (!allowEmpty) {
                var stats = this.collectStats(archive.data);
                if (stats.cards === 0 && stats.totalListsItems === 0 && stats.timelineCount === 0 && stats.episodesCount === 0) {
                    return 'На текущем устройстве нет данных для переноса (история и закладки пусты).';
                }
            }
            return null;
        },

        /**
         * Создание точки отката (Snapshot) перед восстановлением для атомарности операции
         */
        createRollbackSnapshot: function () {
            return {
                favorite: Utils.deepClone(Lampa.Storage.get('favorite', {})),
                file_view: Utils.deepClone(Lampa.Storage.get('file_view', {})),
                online_view: Utils.deepClone(Lampa.Storage.get('online_view', [])),
                torrents_view: Utils.deepClone(Lampa.Storage.get('torrents_view', [])),
                season_view: Utils.deepClone(Lampa.Storage.get('season_view', {}))
            };
        },

        /**
         * Восстановление из точки отката при возникновении ошибки
         */
        applyRollbackSnapshot: function (snapshot) {
            if (!snapshot) return;
            try {
                Lampa.Storage.set('favorite', snapshot.favorite || {});
                Lampa.Storage.set('file_view', snapshot.file_view || {});
                Lampa.Storage.set('online_view', snapshot.online_view || []);
                Lampa.Storage.set('torrents_view', snapshot.torrents_view || []);
                Lampa.Storage.set('season_view', snapshot.season_view || {});
                if (Lampa.Favorite && typeof Lampa.Favorite.init === 'function') Lampa.Favorite.init();
                if (Lampa.Timeline && typeof Lampa.Timeline.init === 'function') Lampa.Timeline.init();
            } catch (e) {
                console.error('[HistoryTransfer] Критическая ошибка отката:', e);
            }
        },

        /**
         * Атомарное восстановление данных на новое устройство
         * mode: 'merge' (Объединение) | 'replace' (Полная замена)
         */
        restoreArchive: function (archive, mode, onProgress) {
            var self = this;
            return new Promise(function (resolve, reject) {
                var validationErr = self.validateArchive(archive, true);
                if (validationErr) {
                    reject(new Error(validationErr));
                    return;
                }

                var rollbackSnapshot = self.createRollbackSnapshot();

                try {
                    onProgress(10, 'Создание резервной точки отката...');

                    var incomingData = archive.data;
                    var incomingFav = incomingData.favorite;

                    // Индексируем полные карточки из архива по ID
                    var incomingCardMap = {};
                    (incomingFav.card || []).forEach(function (c) {
                        if (c && c.id !== undefined && c.id !== null) {
                            incomingCardMap[String(c.id)] = Utils.deepClone(c);
                        }
                    });

                    // Подготавливаем целевую структуру favorite
                    var targetFav;
                    if (mode === 'replace') {
                        targetFav = { card: [] };
                        FAVORITE_LIST_KEYS.forEach(function (k) { targetFav[k] = []; });
                    } else {
                        targetFav = self.readFavoriteData();
                    }

                    // Индекс существующих карточек на новом устройстве
                    var targetCardIndex = {};
                    targetFav.card.forEach(function (c) {
                        if (c && c.id !== undefined && c.id !== null) {
                            targetCardIndex[String(c.id)] = true;
                        }
                    });

                    // 1. Добавляем недостающие полные объекты карточек
                    onProgress(25, 'Перенос метаданных фильмов и сериалов...');
                    var addedCards = 0;
                    (incomingFav.card || []).forEach(function (c) {
                        if (!c || c.id === undefined || c.id === null) return;
                        var idStr = String(c.id);
                        if (!targetCardIndex[idStr]) {
                            targetFav.card.push(Utils.deepClone(c));
                            targetCardIndex[idStr] = true;
                            addedCards++;
                        }
                    });

                    // 2. Формируем очередь добавления элементов через нативный Lampa.Favorite.add
                    // для корректной работы UI и фоновой синхронизации текущего аккаунта CUB
                    var syncTasks = [];
                    var addedByList = {};

                    FAVORITE_LIST_KEYS.forEach(function (listKey) {
                        addedByList[listKey] = 0;
                        var incList = Array.isArray(incomingFav[listKey]) ? incomingFav[listKey] : [];
                        var existingSet = {};
                        targetFav[listKey].forEach(function (id) {
                            existingSet[String(id)] = true;
                        });

                        var uniqueNewIds = [];
                        incList.forEach(function (id) {
                            var idStr = String(id);
                            if (!existingSet[idStr]) {
                                existingSet[idStr] = true;
                                uniqueNewIds.push(id);
                            }
                        });

                        // Обходим с конца, так как Lampa.Favorite.add добавляет элемент в начало (unshift)
                        for (var i = uniqueNewIds.length - 1; i >= 0; i--) {
                            var itemId = uniqueNewIds[i];
                            var fullCard = incomingCardMap[String(itemId)] || targetFav.card.find(function (x) {
                                return String(x.id) === String(itemId);
                            });

                            if (fullCard) {
                                syncTasks.push({ type: listKey, card: fullCard });
                                addedByList[listKey]++;
                            } else {
                                targetFav[listKey].push(itemId);
                                addedByList[listKey]++;
                            }
                        }
                    });

                    // Сохраняем базовое состояние favorite (проверка квоты localStorage)
                    try {
                        Lampa.Storage.set('favorite', targetFav);
                    } catch (quotaErr) {
                        throw new Error('Недостаточно места в локальном хранилище устройства.');
                    }

                    if (mode === 'replace' && Lampa.Favorite && typeof Lampa.Favorite.init === 'function') {
                        Lampa.Favorite.init();
                    }

                    // 3. Пакетное выполнение Lampa.Favorite.add (по 20 элементов за шаг)
                    var totalTasks = syncTasks.length;
                    var batchSize = 20;
                    var cursor = 0;

                    function runNextBatch() {
                        try {
                            if (cursor >= totalTasks) {
                                finalizeProgressAndSync();
                                return;
                            }

                            var end = Math.min(cursor + batchSize, totalTasks);
                            for (var idx = cursor; idx < end; idx++) {
                                var task = syncTasks[idx];
                                if (Lampa.Favorite && typeof Lampa.Favorite.add === 'function') {
                                    Lampa.Favorite.add(task.type, task.card);
                                } else {
                                    var cur = Lampa.Storage.get('favorite', {});
                                    if (!Array.isArray(cur[task.type])) cur[task.type] = [];
                                    if (cur[task.type].indexOf(task.card.id) === -1) {
                                        cur[task.type].unshift(task.card.id);
                                    }
                                    Lampa.Storage.set('favorite', cur);
                                }
                            }

                            cursor = end;
                            var pct = 35 + Math.round((cursor / Math.max(totalTasks, 1)) * 45);
                            onProgress(pct, 'Применение истории и закладок: ' + cursor + ' из ' + totalTasks + '...');
                            setTimeout(runNextBatch, 100);
                        } catch (batchErr) {
                            self.applyRollbackSnapshot(rollbackSnapshot);
                            reject(new Error('Ошибка восстановления: ' + (batchErr.message || 'сбой записи')));
                        }
                    }

                    function finalizeProgressAndSync() {
                        try {
                            onProgress(85, 'Восстановление прогресса просмотра и серий...');
                            var mergedTimelineCount = 0;

                            // Прогресс просмотра (file_view) — не перезаписываем более свежий прогресс устаревшим
                            if (incomingData.timeline && typeof incomingData.timeline === 'object') {
                                var currentTimeline = mode === 'replace' ? {} : (Lampa.Storage.get('file_view', {}) || {});
                                Object.keys(incomingData.timeline).forEach(function (hash) {
                                    var inc = incomingData.timeline[hash];
                                    if (!inc || typeof inc !== 'object') return;
                                    var cur = currentTimeline[hash];
                                    if (!cur || Number(inc.percent || 0) > Number(cur.percent || 0)) {
                                        currentTimeline[hash] = {
                                            hash: inc.hash || hash,
                                            percent: Number(inc.percent || 0),
                                            time: Number(inc.time || 0),
                                            duration: Number(inc.duration || 0)
                                        };
                                        mergedTimelineCount++;
                                    }
                                });
                                Lampa.Storage.set('file_view', currentTimeline);
                            }

                            // Просмотренные серии (online_view, torrents_view)
                            ['online_view', 'torrents_view'].forEach(function (key) {
                                var incArr = Array.isArray(incomingData[key]) ? incomingData[key] : [];
                                if (incArr.length === 0) return;
                                var curArr = mode === 'replace' ? [] : (Lampa.Storage.get(key, []) || []);
                                var seen = {};
                                curArr.forEach(function (h) { seen[String(h)] = true; });
                                incArr.forEach(function (h) {
                                    if (!seen[String(h)]) {
                                        curArr.push(h);
                                        seen[String(h)] = true;
                                        mergedTimelineCount++;
                                    }
                                });
                                Lampa.Storage.set(key, curArr);
                            });

                            // Выбранные сезоны (season_view)
                            if (incomingData.season_view && typeof incomingData.season_view === 'object') {
                                var curSeasons = mode === 'replace' ? {} : (Lampa.Storage.get('season_view', {}) || {});
                                Object.keys(incomingData.season_view).forEach(function (k) {
                                    if (mode === 'replace' || curSeasons[k] === undefined) {
                                        curSeasons[k] = incomingData.season_view[k];
                                    }
                                });
                                Lampa.Storage.set('season_view', curSeasons);
                            }

                            onProgress(95, 'Обновление интерфейса Lampa и облачной синхронизации...');

                            if (Lampa.Favorite && typeof Lampa.Favorite.init === 'function') {
                                Lampa.Favorite.init();
                            }
                            if (Lampa.Timeline && typeof Lampa.Timeline.init === 'function') {
                                Lampa.Timeline.init();
                            }

                            // Запуск синхронизации текущего аккаунта CUB (если пользователь авторизован)
                            var autoSync = Lampa.Storage.get(STORAGE_KEYS.AUTO_SYNC_CUB, true);
                            var acc = Lampa.Storage.get('account', {});
                            var cubSynced = false;

                            if (autoSync && acc && acc.token && Lampa.Account && typeof Lampa.Account.sync === 'function') {
                                try {
                                    Lampa.Account.sync();
                                    cubSynced = true;
                                } catch (e) {}
                            }

                            onProgress(100, 'Данные успешно восстановлены!');

                            resolve({
                                mode: mode,
                                addedCards: addedCards,
                                addedByList: addedByList,
                                totalRestoredItems: totalTasks,
                                mergedTimeline: mergedTimelineCount,
                                cubSynced: cubSynced
                            });
                        } catch (finErr) {
                            self.applyRollbackSnapshot(rollbackSnapshot);
                            reject(new Error('Ошибка восстановления (выполнен безопасный откат): ' + finErr.message));
                        }
                    }

                    runNextBatch();
                } catch (err) {
                    self.applyRollbackSnapshot(rollbackSnapshot);
                    reject(err);
                }
            });
        }
    };

    /**
     * ========================================================================
     * СТИЛИ ИНТЕРФЕЙСА В ДИЗАЙН-СИСТЕМЕ LAMPA (SMART TV / ANDROID TV / WEB)
     * ========================================================================
     */
    function injectStyles() {
        if (document.getElementById('ht-v2-styles')) return;
        var css = [
            '.ht-modal { padding: 1.5em; max-width: 54em; margin: 0 auto; color: #fff; }',
            '.ht-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 0.9em; margin-bottom: 1.1em; }',
            '.ht-title { font-size: 1.45em; font-weight: 700; letter-spacing: 0.02em; }',
            '.ht-badge { background: rgba(255,255,255,0.12); padding: 0.35em 0.75em; border-radius: 0.5em; font-size: 0.85em; color: #ddd; }',
            '.ht-badge--ok { background: rgba(46, 204, 113, 0.22); color: #2ecc71; border: 1px solid rgba(46, 204, 113, 0.4); }',
            '.ht-badge--warn { background: rgba(241, 196, 15, 0.2); color: #f1c40f; border: 1px solid rgba(241, 196, 15, 0.35); }',
            '.ht-code-box { background: rgba(255,255,255,0.08); border: 2px solid rgba(46, 204, 113, 0.5); border-radius: 0.9em; padding: 1.4em; text-align: center; margin: 1em 0; }',
            '.ht-code-label { font-size: 0.95em; color: rgba(255,255,255,0.75); margin-bottom: 0.4em; }',
            '.ht-code-value { font-size: 2.8em; font-weight: 800; letter-spacing: 0.14em; color: #2ecc71; margin: 0.2em 0; font-family: monospace; }',
            '.ht-code-timer { font-size: 1em; color: #f1c40f; font-weight: 600; margin-top: 0.4em; }',
            '.ht-menu-list { display: flex; flex-direction: column; gap: 0.6em; }',
            '.ht-menu-item { display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.07); padding: 0.95em 1.2em; border-radius: 0.75em; transition: transform 0.15s ease, background 0.15s ease; border: 2px solid transparent; cursor: pointer; }',
            '.ht-menu-item.focus, .ht-menu-item:hover { background: rgba(255,255,255,0.16); border-color: #fff; transform: scale(1.01); }',
            '.ht-menu-left { display: flex; align-items: center; gap: 0.9em; }',
            '.ht-menu-icon { font-size: 1.35em; width: 1.5em; text-align: center; }',
            '.ht-menu-text-title { font-size: 1.05em; font-weight: 600; }',
            '.ht-menu-text-desc { font-size: 0.82em; color: rgba(255,255,255,0.6); margin-top: 0.2em; }',
            '.ht-menu-arrow { font-size: 1.1em; opacity: 0.6; }',
            '.ht-progress-wrap { background: rgba(255,255,255,0.08); border-radius: 0.75em; padding: 1.2em; margin: 1em 0; }',
            '.ht-progress-bar-bg { width: 100%; height: 0.65em; background: rgba(255,255,255,0.15); border-radius: 1em; overflow: hidden; margin: 0.75em 0; }',
            '.ht-progress-bar-fill { height: 100%; background: #2ecc71; width: 0%; transition: width 0.25s ease; }',
            '.ht-btn-row { display: flex; gap: 0.8em; margin-top: 1.1em; flex-wrap: wrap; }',
            '.ht-btn { background: rgba(255,255,255,0.12); color: #fff; padding: 0.8em 1.2em; border-radius: 0.6em; font-weight: 600; border: 2px solid transparent; cursor: pointer; text-align: center; flex: 1 1 auto; }',
            '.ht-btn.focus, .ht-btn:hover { background: #fff; color: #111; border-color: #fff; }',
            '.ht-btn--primary { background: rgba(46, 204, 113, 0.25); color: #2ecc71; border-color: rgba(46, 204, 113, 0.4); }',
            '.ht-btn--primary.focus, .ht-btn--primary:hover { background: #2ecc71; color: #111; border-color: #2ecc71; }',
            '.ht-btn--danger { background: rgba(231, 76, 60, 0.25); color: #ff7675; }',
            '.ht-btn--danger.focus, .ht-btn--danger:hover { background: #e74c3c; color: #fff; border-color: #e74c3c; }',
            '.ht-info-table { width: 100%; border-collapse: collapse; margin: 0.7em 0; font-size: 0.9em; }',
            '.ht-info-table td, .ht-info-table th { padding: 0.5em 0.4em; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: left; }',
            '.ht-info-table th { color: rgba(255,255,255,0.55); font-weight: 500; }',
            '.ht-warn-box { background: rgba(231, 76, 60, 0.18); border: 1px solid rgba(231, 76, 60, 0.45); border-radius: 0.7em; padding: 0.9em 1.1em; margin: 0.8em 0; color: #ff9f9b; font-size: 0.9em; line-height: 1.45; }'
        ].join('\n');

        var style = document.createElement('style');
        style.id = 'ht-v2-styles';
        style.textContent = css;
        document.head.appendChild(style);
    }

    /**
     * ========================================================================
     * ПОЛЬЗОВАТЕЛЬСКИЙ ИНТЕРФЕЙС (6 РАЗДЕЛОВ)
     * ========================================================================
     */
    var UI = {
        activeTimerInterval: null,

        clearTimer: function () {
            if (this.activeTimerInterval) {
                clearInterval(this.activeTimerInterval);
                this.activeTimerInterval = null;
            }
        },

        openScreen: function (htmlContent, onReady, onBackCallback) {
            this.clearTimer();
            var wrap = $('<div class="ht-modal">' + htmlContent + '</div>');

            Lampa.Modal.open({
                title: '',
                html: wrap,
                size: 'medium',
                onBack: function () {
                    UI.clearTimer();
                    Lampa.Modal.close();
                    if (typeof onBackCallback === 'function') {
                        onBackCallback();
                    } else {
                        Lampa.Controller.toggle('content');
                    }
                }
            });

            setTimeout(function () {
                Lampa.Controller.collectionSet(wrap);
                var first = wrap.find('.selector').first()[0];
                if (first) Lampa.Controller.collectionFocus(first, wrap);
                if (typeof onReady === 'function') onReady(wrap);
            }, 60);
        },

        /**
         * РАЗДЕЛ 1: ПЕРЕНОС ДАННЫХ (ГЛАВНОЕ МЕНЮ)
         */
        openMainMenu: function () {
            var self = this;
            var stats = DataEngine.collectStats();

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">🔄 ' + PLUGIN_NAME + ' — Перенос данных</div>',
                '  <span class="ht-badge">v' + PLUGIN_VERSION + '</span>',
                '</div>',

                '<p style="color:rgba(255,255,255,0.75);font-size:0.92em;margin-bottom:1em;">',
                '  Перенос истории просмотров, закладок, списков и прогресса серий между устройствами по одноразовому коду. ',
                '  На устройстве найдено: <strong>' + stats.cards + '</strong> карточек, <strong>' + stats.byList.history + '</strong> в истории, <strong>' + stats.timelineCount + '</strong> таймкодов.',
                '</p>',

                '<div class="ht-menu-list">',
                '  <div class="ht-menu-item selector" data-nav="create_code">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">📤</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">Создать код переноса</div>',
                '        <div class="ht-menu-text-desc">Для старого устройства: подготовить данные и получить одноразовый код на 15 минут</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                '  <div class="ht-menu-item selector" data-nav="restore_data">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">📥</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">Восстановить данные</div>',
                '        <div class="ht-menu-text-desc">Для нового устройства: ввести код переноса или загрузить резервный JSON-файл</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                '  <div class="ht-menu-item selector" data-nav="info">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">📊</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">Информация о переносе</div>',
                '        <div class="ht-menu-text-desc">Детальная статистика данных и локальное резервное копирование в JSON-файл</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                '  <div class="ht-menu-item selector" data-nav="logs">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">🕒</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">История операций</div>',
                '        <div class="ht-menu-text-desc">Журнал выполненных отправок и восстановлений на этом устройстве</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                '  <div class="ht-menu-item selector" data-nav="settings">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">⚙️</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">Настройки</div>',
                '        <div class="ht-menu-text-desc">Адрес облачного сервера, проверка связи и параметры синхронизации</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('.ht-menu-item').on('hover:enter click', function () {
                    var nav = $(this).data('nav');
                    if (nav === 'create_code') self.openCreateCodeScreen();
                    else if (nav === 'restore_data') self.openRestoreMenuScreen();
                    else if (nav === 'info') self.openTransferInfoScreen();
                    else if (nav === 'logs') self.openOperationsHistoryScreen();
                    else if (nav === 'settings') self.openSettingsScreen();
                });
            });
        },

        /**
         * РАЗДЕЛ 2: СОЗДАТЬ КОД (СТАРОЕ УСТРОЙСТВО)
         */
        openCreateCodeScreen: function () {
            var self = this;

            var loadingHtml = [
                '<div class="ht-header">',
                '  <div class="ht-title">СОЗДАНИЕ ПЕРЕНОСА</div>',
                '  <span class="ht-badge">Подготовка</span>',
                '</div>',
                '<div class="ht-progress-wrap">',
                '  <div id="ht-create-step">Сбор пользовательских данных Lampa...</div>',
                '  <div class="ht-progress-bar-bg"><div class="ht-progress-bar-fill" id="ht-create-bar"></div></div>',
                '  <div id="ht-create-sub" style="font-size:0.85em;color:rgba(255,255,255,0.65);">Не закрывайте окно...</div>',
                '</div>'
            ].join('');

            this.openScreen(loadingHtml, function (wrap) {
                var setStep = function (pct, step, sub) {
                    wrap.find('#ht-create-bar').css('width', pct + '%');
                    wrap.find('#ht-create-step').text(step);
                    if (sub !== undefined) wrap.find('#ht-create-sub').text(sub);
                };

                setTimeout(function () {
                    try {
                        setStep(25, 'Сбор истории, закладок, списков и прогресса серий...');
                        var archive = DataEngine.buildExportArchive();
                        var errMsg = DataEngine.validateArchive(archive, false);

                        if (errMsg) {
                            throw new Error(errMsg);
                        }

                        setStep(55, 'Проверка целостности и вычисление SHA-256...');
                        var serialized = JSON.stringify(archive);

                        Utils.sha256(serialized).then(function (checksum) {
                            setStep(80, 'Загрузка архива в облачное хранилище...');
                            return ApiClient.createTransfer(archive, checksum);
                        }).then(function (res) {
                            var totalItems = (res.summary.history || 0) + (res.summary.book || 0) + (res.summary.viewed || 0);
                            Utils.logOperation('Создание кода переноса', 'Код ' + res.formatted_code, totalItems, 'Успешно');
                            Lampa.Storage.set(STORAGE_KEYS.LAST_ACTIVE_CODE, {
                                code: res.code,
                                delete_secret: res.delete_secret,
                                expires_at: res.expires_at
                            });

                            self.renderGeneratedCodeScreen(res);
                        }).catch(function (err) {
                            wrap.find('#ht-create-bar').css('background', '#e74c3c');
                            setStep(100, 'Ошибка создания переноса', err.message || 'Сервер временно недоступен');
                            Utils.notify(err.message || 'Ошибка создания кода', true);
                            wrap.append('<div class="ht-btn-row"><div class="ht-btn selector" data-back="1">Вернуться в меню</div></div>');
                            Lampa.Controller.collectionSet(wrap);
                            var btn = wrap.find('.selector').first()[0];
                            if (btn) Lampa.Controller.collectionFocus(btn, wrap);
                            wrap.find('[data-back="1"]').on('hover:enter click', function () { self.openMainMenu(); });
                        });
                    } catch (e) {
                        wrap.find('#ht-create-bar').css('background', '#e74c3c');
                        setStep(100, 'Ошибка подготовки данных', e.message);
                        Utils.notify(e.message, true);
                        wrap.append('<div class="ht-btn-row"><div class="ht-btn selector" data-back="1">Вернуться в меню</div></div>');
                        Lampa.Controller.collectionSet(wrap);
                        var btn = wrap.find('.selector').first()[0];
                        if (btn) Lampa.Controller.collectionFocus(btn, wrap);
                        wrap.find('[data-back="1"]').on('hover:enter click', function () { self.openMainMenu(); });
                    }
                }, 150);
            }, function () { self.openMainMenu(); });
        },

        renderGeneratedCodeScreen: function (transferRes) {
            var self = this;
            var s = transferRes.summary || {};

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">СОЗДАНИЕ ПЕРЕНОСА</div>',
                '  <span class="ht-badge ht-badge--ok">Одноразовый код</span>',
                '</div>',
                '<div class="ht-code-box">',
                '  <div class="ht-code-label">Ваши данные подготовлены!</div>',
                '  <div class="ht-code-value">' + Utils.escapeHtml(transferRes.formatted_code) + '</div>',
                '  <div class="ht-code-timer" id="ht-code-countdown">Срок действия: 15 минут</div>',
                '</div>',
                '<p style="font-size:0.88em;color:rgba(255,255,255,0.7);text-align:center;">',
                '  Упаковано: <strong>' + (s.cards || 0) + '</strong> карточек • <strong>' + (s.history || 0) + '</strong> в истории • ',
                '  <strong>' + (s.book || 0) + '</strong> закладок • <strong>' + (s.timeline || 0) + '</strong> таймкодов (' + Utils.formatBytes(transferRes.size_bytes) + ')',
                '</p>',
                '<div class="ht-btn-row">',
                '  <div class="ht-btn ht-btn--primary selector" data-code-act="copy">Скопировать код</div>',
                '  <div class="ht-btn ht-btn--danger selector" data-code-act="cancel">Отменить и удалить</div>',
                '  <div class="ht-btn selector" data-code-act="done">Готово</div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                var updateTimer = function () {
                    var leftMs = transferRes.expires_at - Date.now();
                    if (leftMs <= 0) {
                        wrap.find('#ht-code-countdown').text('Срок действия кода истёк!').css('color', '#e74c3c');
                        self.clearTimer();
                        return;
                    }
                    var totalSec = Math.floor(leftMs / 1000);
                    var min = Math.floor(totalSec / 60);
                    var sec = totalSec % 60;
                    wrap.find('#ht-code-countdown').text(
                        'Срок действия: ' + (min < 10 ? '0' + min : min) + ':' + (sec < 10 ? '0' + sec : sec)
                    );
                };
                updateTimer();
                self.activeTimerInterval = setInterval(updateTimer, 1000);

                wrap.find('[data-code-act="copy"]').on('hover:enter click', function () {
                    Utils.copyToClipboard(transferRes.formatted_code).then(function (ok) {
                        if (ok) Utils.notify('Код ' + transferRes.formatted_code + ' скопирован в буфер обмена');
                        else Utils.notify('Запомните код: ' + transferRes.formatted_code);
                    });
                });

                wrap.find('[data-code-act="cancel"]').on('hover:enter click', function () {
                    ApiClient.cancelTransfer(transferRes.code, transferRes.delete_secret)
                        .then(function () {
                            Utils.notify('Перенос отменён, данные удалены из облака');
                            self.openMainMenu();
                        })
                        .catch(function (err) {
                            Utils.notify(err.message || 'Не удалось отменить перенос', true);
                        });
                });

                wrap.find('[data-code-act="done"]').on('hover:enter click', function () {
                    self.openMainMenu();
                });
            }, function () { self.openMainMenu(); });
        },

        /**
         * РАЗДЕЛ 3: ВОССТАНОВИТЬ ДАННЫЕ (НОВОЕ УСТРОЙСТВО)
         */
        openRestoreMenuScreen: function () {
            var self = this;
            var hasLocalSlot = Boolean(Lampa.Storage.get(STORAGE_KEYS.LOCAL_BACKUP_SLOT, null));

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">📥 Восстановить данные</div>',
                '  <span class="ht-badge">Новое устройство</span>',
                '</div>',
                '<p style="color:rgba(255,255,255,0.75);font-size:0.92em;margin-bottom:1em;">',
                '  Выберите способ получения данных. Ваш текущий аккаунт Lampa/CUB останется активным.',
                '</p>',
                '<div class="ht-menu-list">',
                '  <div class="ht-menu-item selector" data-rest="by_code">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">🔢</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">Ввести одноразовый код переноса</div>',
                '        <div class="ht-menu-text-desc">Получить архив со старого устройства по 6-значному коду</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                '  <div class="ht-menu-item selector" data-rest="from_file">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">📂</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">Импортировать из JSON-файла</div>',
                '        <div class="ht-menu-text-desc">Загрузить локально сохранённую резервную копию с носителя</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                (hasLocalSlot ? [
                    '  <div class="ht-menu-item selector" data-rest="from_slot">',
                    '    <div class="ht-menu-left">',
                    '      <div class="ht-menu-icon">💾</div>',
                    '      <div>',
                    '        <div class="ht-menu-text-title">Восстановить из локального слота памяти</div>',
                    '        <div class="ht-menu-text-desc">Использовать резервную копию, сохранённую в памяти Lampa</div>',
                    '      </div>',
                    '    </div>',
                    '    <div class="ht-menu-arrow">❯</div>',
                    '  </div>'
                ].join('') : ''),
                '</div>',
                '<div class="ht-btn-row"><div class="ht-btn selector" data-rest="back">Назад в меню</div></div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('[data-rest="by_code"]').on('hover:enter click', function () {
                    self.promptTransferCode();
                });

                wrap.find('[data-rest="from_file"]').on('hover:enter click', function () {
                    self.triggerJsonFileUpload();
                });

                wrap.find('[data-rest="from_slot"]').on('hover:enter click', function () {
                    var slotArchive = Lampa.Storage.get(STORAGE_KEYS.LOCAL_BACKUP_SLOT, null);
                    if (!slotArchive) {
                        Utils.notify('Локальная копия не найдена', true);
                        return;
                    }
                    var err = DataEngine.validateArchive(slotArchive, true);
                    if (err) {
                        Utils.notify(err, true);
                        return;
                    }
                    self.openRestoreModeSelection({
                        sourceType: 'slot',
                        sourceLabel: 'Локальный слот памяти Lampa',
                        createdAt: slotArchive.created_at,
                        summary: DataEngine.collectStats(slotArchive.data),
                        archive: slotArchive
                    });
                });

                wrap.find('[data-rest="back"]').on('hover:enter click', function () {
                    self.openMainMenu();
                });
            }, function () { self.openMainMenu(); });
        },

        promptTransferCode: function () {
            var self = this;
            Lampa.Modal.close();

            Lampa.Input.edit({
                title: 'Введите 6-значный код переноса (например: 583921)',
                value: '',
                free: true,
                nosave: true
            }, function (inputVal) {
                var cleanCode = Utils.normalizeCode(inputVal);
                if (!cleanCode) {
                    self.openRestoreMenuScreen();
                    return;
                }
                if (cleanCode.length !== 6) {
                    Utils.notify('Код переноса должен состоять из 6 цифр', true);
                    self.openRestoreMenuScreen();
                    return;
                }

                Utils.notify('Проверка кода ' + Utils.formatCode(cleanCode) + '...');
                ApiClient.inspectTransfer(cleanCode)
                    .then(function (info) {
                        if (Number(info.schema_version) > ARCHIVE_VERSION) {
                            throw new Error('Неподдерживаемая версия архива. Обновите плагин.');
                        }
                        self.openRestoreModeSelection({
                            sourceType: 'cloud',
                            code: cleanCode,
                            formattedCode: info.formatted_code,
                            sourceLabel: info.source_device || 'Устройство Lampa',
                            createdAt: info.created_at,
                            expiresAt: info.expires_at,
                            summary: info.summary
                        });
                    })
                    .catch(function (err) {
                        Utils.notify(err.message || 'Ошибка проверки кода', true);
                        self.openRestoreMenuScreen();
                    });
            });
        },

        /**
         * Показ содержимого переноса и выбор режима восстановления
         */
        openRestoreModeSelection: function (context) {
            var self = this;
            var s = context.summary || {};
            var localStats = DataEngine.collectStats();

            var bCards = s.cards || 0;
            var bHistory = s.byList ? s.byList.history : (s.history || 0);
            var bBook = s.byList ? s.byList.book : (s.book || 0);
            var bViewed = s.byList ? s.byList.viewed : (s.viewed || 0);
            var bLike = s.byList ? s.byList.like : (s.like || 0);
            var bTimeline = s.timelineCount !== undefined ? s.timelineCount : (s.timeline || 0);

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">📦 Содержимое переноса</div>',
                '  <span class="ht-badge ht-badge--ok">' + (context.formattedCode || 'JSON-архив') + '</span>',
                '</div>',
                '<p style="font-size:0.88em;color:rgba(255,255,255,0.75);margin-bottom:0.7em;">',
                '  Источник: <strong>' + Utils.escapeHtml(context.sourceLabel) + '</strong> • Создан: ' + Utils.formatDate(context.createdAt),
                '</p>',
                '<table class="ht-info-table">',
                '  <thead><tr><th>Категория данных</th><th>В переносе</th><th>Сейчас на устройстве</th></tr></thead>',
                '  <tbody>',
                '    <tr><td>Полные карточки (card)</td><td><strong>' + bCards + '</strong></td><td>' + localStats.cards + '</td></tr>',
                '    <tr><td>История просмотров (history)</td><td><strong>' + bHistory + '</strong></td><td>' + localStats.byList.history + '</td></tr>',
                '    <tr><td>Закладки (book)</td><td><strong>' + bBook + '</strong></td><td>' + localStats.byList.book + '</td></tr>',
                '    <tr><td>Просмотрено (viewed)</td><td><strong>' + bViewed + '</strong></td><td>' + localStats.byList.viewed + '</td></tr>',
                '    <tr><td>Избранное (like)</td><td><strong>' + bLike + '</strong></td><td>' + localStats.byList.like + '</td></tr>',
                '    <tr><td>Прогресс серий и таймкоды</td><td><strong>' + bTimeline + '</strong></td><td>' + localStats.timelineCount + '</td></tr>',
                '  </tbody>',
                '</table>',
                '<div class="ht-menu-list" style="margin-top:0.9em;">',
                '  <div class="ht-menu-item selector" data-rmode="merge">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">🔀</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">Режим 2: Объединение (Рекомендуется)</div>',
                '        <div class="ht-menu-text-desc">Безопасно объединить истории без дубликатов и потери текущих закладок</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',
                '  <div class="ht-menu-item selector" data-rmode="replace">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">♻️</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">Режим 1: Полная замена</div>',
                '        <div class="ht-menu-text-desc">Заменить существующие данные нового устройства данными из переноса</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',
                '</div>',
                '<div class="ht-btn-row"><div class="ht-btn selector" data-rmode="cancel">Отмена</div></div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('[data-rmode="merge"]').on('hover:enter click', function () {
                    self.executeRestoreProcess(context, 'merge');
                });

                wrap.find('[data-rmode="replace"]').on('hover:enter click', function () {
                    self.confirmFullReplaceWarning(function () {
                        self.executeRestoreProcess(context, 'replace');
                    }, function () {
                        self.openRestoreModeSelection(context);
                    });
                });

                wrap.find('[data-rmode="cancel"]').on('hover:enter click', function () {
                    self.openMainMenu();
                });
            }, function () { self.openMainMenu(); });
        },

        confirmFullReplaceWarning: function (onConfirm, onCancel) {
            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">⚠️ Внимание: Полная замена данных</div>',
                '</div>',
                '<div class="ht-warn-box">',
                '  Вы выбрали режим <strong>Полной замены</strong>. Вся текущая история просмотров, закладки и списки на этом устройстве ',
                '  будут полностью заменены данными из переноса. При сбое сработает автоматический откат, но после успешного завершения отменить замену будет нельзя.',
                '</div>',
                '<div class="ht-btn-row">',
                '  <div class="ht-btn ht-btn--danger selector" data-warn="yes">Да, заменить данные</div>',
                '  <div class="ht-btn selector" data-warn="no">Назад к выбору режима</div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('[data-warn="yes"]').on('hover:enter click', onConfirm);
                wrap.find('[data-warn="no"]').on('hover:enter click', onCancel);
            }, onCancel);
        },

        executeRestoreProcess: function (context, mode) {
            var self = this;
            var modeName = mode === 'replace' ? 'Полная замена' : 'Объединение';

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">📥 Восстановление данных</div>',
                '  <span class="ht-badge">' + modeName + '</span>',
                '</div>',
                '<div class="ht-progress-wrap">',
                '  <div id="ht-imp-step">Получение архива...</div>',
                '  <div class="ht-progress-bar-bg"><div class="ht-progress-bar-fill" id="ht-imp-bar"></div></div>',
                '  <div id="ht-imp-sub" style="font-size:0.85em;color:rgba(255,255,255,0.65);">Не выключайте устройство до завершения...</div>',
                '</div>',
                '<div class="ht-btn-row" id="ht-imp-footer" style="display:none;">',
                '  <div class="ht-btn ht-btn--primary selector" data-done="1">Готово</div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                var setStep = function (pct, step, sub) {
                    wrap.find('#ht-imp-bar').css('width', pct + '%');
                    wrap.find('#ht-imp-step').text(step);
                    if (sub !== undefined) wrap.find('#ht-imp-sub').text(sub);
                };

                var showFooter = function () {
                    wrap.find('#ht-imp-footer').show();
                    Lampa.Controller.collectionSet(wrap);
                    var btn = wrap.find('.selector').first()[0];
                    if (btn) Lampa.Controller.collectionFocus(btn, wrap);
                    wrap.find('[data-done="1"]').on('hover:enter click', function () {
                        self.openMainMenu();
                    });
                };

                var archivePromise;
                if (context.sourceType === 'cloud') {
                    setStep(15, 'Скачивание архива по одноразовому коду...');
                    archivePromise = ApiClient.claimTransfer(context.code).then(function (res) {
                        return res.archive;
                    });
                } else {
                    archivePromise = Promise.resolve(context.archive);
                }

                archivePromise
                    .then(function (archive) {
                        return DataEngine.restoreArchive(archive, mode, function (pct, msg) {
                            setStep(pct, msg);
                        });
                    })
                    .then(function (result) {
                        var totalRestored = result.totalRestoredItems + result.mergedTimeline;
                        Utils.logOperation('Восстановление данных', modeName, totalRestored, 'Успешно');

                        var syncInfo = result.cubSynced
                            ? 'Синхронизация с текущим аккаунтом CUB запущена.'
                            : 'Данные сохранены в локальном профиле Lampa.';

                        setStep(
                            100,
                            'Перенос успешно завершён!',
                            'Карточек: +' + result.addedCards + ' | Записей в списках: +' + result.totalRestoredItems +
                            ' | Таймкодов: +' + result.mergedTimeline + '. ' + syncInfo
                        );
                        Utils.notify('Данные успешно восстановлены!');
                        showFooter();
                    })
                    .catch(function (err) {
                        Utils.logOperation('Восстановление данных', modeName, 0, 'Ошибка: ' + err.message);
                        wrap.find('#ht-imp-bar').css('background', '#e74c3c');
                        setStep(100, 'Ошибка при восстановлении', err.message || 'Не удалось восстановить данные');
                        Utils.notify(err.message || 'Ошибка восстановления', true);
                        showFooter();
                    });
            }, function () { self.openMainMenu(); });
        },

        /**
         * Локальный импорт из JSON-файла
         */
        triggerJsonFileUpload: function () {
            var self = this;
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.style.display = 'none';

            input.onchange = function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;

                var reader = new FileReader();
                reader.onload = function (ev) {
                    try {
                        var parsed = JSON.parse(ev.target.result);
                        var err = DataEngine.validateArchive(parsed, true);
                        if (err) {
                            Utils.notify(err, true);
                            return;
                        }
                        self.openRestoreModeSelection({
                            sourceType: 'file',
                            sourceLabel: 'Файл: ' + file.name,
                            createdAt: parsed.created_at,
                            summary: DataEngine.collectStats(parsed.data),
                            archive: parsed
                        });
                    } catch (parseErr) {
                        Utils.notify('Ошибка проверки данных: невалидный JSON-файл.', true);
                    }
                };
                reader.readAsText(file);
            };

            document.body.appendChild(input);
            input.click();
            setTimeout(function () {
                if (input.parentNode) input.parentNode.removeChild(input);
            }, 5000);
        },

        /**
         * РАЗДЕЛ 4: ИНФОРМАЦИЯ О ПЕРЕНОСЕ И ЛОКАЛЬНЫЙ ЭКСПОРТ В JSON
         */
        openTransferInfoScreen: function () {
            var self = this;
            var stats = DataEngine.collectStats();

            var rows = FAVORITE_LIST_KEYS.map(function (k) {
                return '<tr><td>' + LIST_TITLES[k] + ' (<code>' + k + '</code>)</td><td style="text-align:right;"><strong>' + stats.byList[k] + '</strong></td></tr>';
            }).join('');

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">📊 Информация о переносе</div>',
                '  <span class="ht-badge">Резервные копии</span>',
                '</div>',
                '<table class="ht-info-table">',
                '  <tr><td>Полные карточки фильмов/сериалов (<code>card</code>)</td><td style="text-align:right;"><strong>' + stats.cards + '</strong></td></tr>',
                rows,
                '  <tr><td>Прогресс просмотра (<code>file_view</code>)</td><td style="text-align:right;"><strong>' + stats.timelineCount + '</strong></td></tr>',
                '  <tr><td>Просмотренные серии (<code>online/torrents</code>)</td><td style="text-align:right;"><strong>' + stats.episodesCount + '</strong></td></tr>',
                '</table>',
                '<div class="ht-btn-row">',
                '  <div class="ht-btn ht-btn--primary selector" data-info="export_json">Скачать JSON-файл резервной копии</div>',
                '  <div class="ht-btn selector" data-info="save_slot">Сохранить в локальный слот Lampa</div>',
                '  <div class="ht-btn selector" data-info="back">Назад</div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('[data-info="export_json"]').on('hover:enter click', function () {
                    try {
                        var archive = DataEngine.buildExportArchive();
                        var err = DataEngine.validateArchive(archive, false);
                        if (err) {
                            Utils.notify(err, true);
                            return;
                        }
                        var jsonStr = JSON.stringify(archive, null, 2);
                        var blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
                        var url = URL.createObjectURL(blob);
                        var a = document.createElement('a');
                        var dateTag = new Date().toISOString().slice(0, 10);
                        a.href = url;
                        a.download = 'lampa-history-backup-' + dateTag + '.json';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);

                        Utils.logOperation('Локальный экспорт JSON', 'Файл .json', archive.data.favorite.card.length, 'Успешно');
                        Utils.notify('Резервная копия JSON сформирована и отправлена на скачивание');
                    } catch (e) {
                        Utils.notify('Устройство не поддерживает прямое скачивание файлов. Используйте «Сохранить в локальный слот».', true);
                    }
                });

                wrap.find('[data-info="save_slot"]').on('hover:enter click', function () {
                    try {
                        var archive = DataEngine.buildExportArchive();
                        var err = DataEngine.validateArchive(archive, false);
                        if (err) {
                            Utils.notify(err, true);
                            return;
                        }
                        Lampa.Storage.set(STORAGE_KEYS.LOCAL_BACKUP_SLOT, archive);
                        Utils.logOperation('Локальный бэкап', 'Слот памяти Lampa', archive.data.favorite.card.length, 'Успешно');
                        Utils.notify('Резервная копия сохранена в локальный слот Lampa');
                    } catch (e) {
                        Utils.notify('Недостаточно места в локальном хранилище устройства', true);
                    }
                });

                wrap.find('[data-info="back"]').on('hover:enter click', function () {
                    self.openMainMenu();
                });
            }, function () { self.openMainMenu(); });
        },

        /**
         * РАЗДЕЛ 5: ИСТОРИЯ ОПЕРАЦИЙ
         */
        openOperationsHistoryScreen: function () {
            var self = this;
            var logs = Lampa.Storage.get(STORAGE_KEYS.OPERATIONS_LOG, []);
            if (!Array.isArray(logs)) logs = [];

            var bodyHtml;
            if (logs.length === 0) {
                bodyHtml = '<p style="color:rgba(255,255,255,0.65);padding:1.2em 0;">На этом устройстве ещё не выполнялись операции переноса.</p>';
            } else {
                var rows = logs.map(function (item) {
                    return '<tr>' +
                        '<td>' + Utils.formatDate(item.timestamp) + '</td>' +
                        '<td><strong>' + Utils.escapeHtml(item.type) + '</strong> (' + Utils.escapeHtml(item.mode) + ')</td>' +
                        '<td>' + item.items + ' зап.</td>' +
                        '<td style="text-align:right;">' + Utils.escapeHtml(item.status) + '</td>' +
                        '</tr>';
                }).join('');

                bodyHtml = [
                    '<table class="ht-info-table">',
                    '  <thead><tr><th>Дата</th><th>Операция</th><th>Объём</th><th style="text-align:right;">Статус</th></tr></thead>',
                    '  <tbody>' + rows + '</tbody>',
                    '</table>'
                ].join('');
            }

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">🕒 История операций</div>',
                '  <span class="ht-badge">Журнал устройства</span>',
                '</div>',
                bodyHtml,
                '<div class="ht-btn-row">',
                (logs.length > 0 ? '<div class="ht-btn ht-btn--danger selector" data-log="clear">Очистить журнал</div>' : ''),
                '  <div class="ht-btn selector" data-log="back">Назад в меню</div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('[data-log="clear"]').on('hover:enter click', function () {
                    Lampa.Storage.set(STORAGE_KEYS.OPERATIONS_LOG, []);
                    Utils.notify('Журнал операций очищен');
                    self.openOperationsHistoryScreen();
                });

                wrap.find('[data-log="back"]').on('hover:enter click', function () {
                    self.openMainMenu();
                });
            }, function () { self.openMainMenu(); });
        },

        /**
         * РАЗДЕЛ 6: НАСТРОЙКИ
         */
        openSettingsScreen: function () {
            var self = this;
            var apiUrl = Utils.getApiUrl();
            var incTimeline = Lampa.Storage.get(STORAGE_KEYS.INCLUDE_TIMELINE, true);
            var autoSync = Lampa.Storage.get(STORAGE_KEYS.AUTO_SYNC_CUB, true);

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">⚙️ Настройки</div>',
                '  <span class="ht-badge">v' + PLUGIN_VERSION + '</span>',
                '</div>',
                '<div class="ht-menu-list">',
                '  <div class="ht-menu-item selector" data-set="api_url">',
                '    <div class="ht-menu-left"><div class="ht-menu-icon">🌐</div><div><div class="ht-menu-text-title">Адрес облачного сервера (Cloudflare Workers)</div><div class="ht-menu-text-desc">' + Utils.escapeHtml(apiUrl) + '</div></div></div>',
                '    <div class="ht-menu-arrow">✎</div>',
                '  </div>',
                '  <div class="ht-menu-item selector" data-set="ping">',
                '    <div class="ht-menu-left"><div class="ht-menu-icon">📡</div><div><div class="ht-menu-text-title">Проверить доступность сервера</div><div class="ht-menu-text-desc">Диагностика соединения с Cloudflare Workers и базой D1</div></div></div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',
                '  <div class="ht-menu-item selector" data-set="timeline">',
                '    <div class="ht-menu-left"><div class="ht-menu-icon">⏱️</div><div><div class="ht-menu-text-title">Переносить прогресс просмотра и серии</div><div class="ht-menu-text-desc">Включать таймкоды фильмов и просмотренные эпизоды сериалов</div></div></div>',
                '    <div class="ht-badge">' + (incTimeline ? 'ВКЛ' : 'ВЫКЛ') + '</div>',
                '  </div>',
                '  <div class="ht-menu-item selector" data-set="sync">',
                '    <div class="ht-menu-left"><div class="ht-menu-icon">🔄</div><div><div class="ht-menu-text-title">Синхронизация с аккаунтом нового устройства</div><div class="ht-menu-text-desc">Автоматически отправлять восстановленные данные в текущий аккаунт CUB</div></div></div>',
                '    <div class="ht-badge">' + (autoSync ? 'ВКЛ' : 'ВЫКЛ') + '</div>',
                '  </div>',
                '</div>',
                '<div class="ht-btn-row"><div class="ht-btn selector" data-set="back">Назад в меню</div></div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('[data-set="api_url"]').on('hover:enter click', function () {
                    Lampa.Modal.close();
                    Lampa.Input.edit({
                        title: 'Введите URL вашего Cloudflare Worker',
                        value: Utils.getApiUrl(),
                        free: true,
                        nosave: true
                    }, function (val) {
                        val = String(val || '').trim().replace(/\/+$/, '');
                        if (val) {
                            Lampa.Storage.set(STORAGE_KEYS.API_URL, val);
                            Utils.notify('Адрес сервера обновлён');
                        }
                        self.openSettingsScreen();
                    });
                });

                wrap.find('[data-set="ping"]').on('hover:enter click', function () {
                    Utils.notify('Проверка соединения с сервером...');
                    ApiClient.health()
                        .then(function (res) {
                            Utils.notify('Сервер онлайн! База данных D1: ' + (res.database || 'OK'));
                        })
                        .catch(function (err) {
                            Utils.notify(err.message || 'Сервер временно недоступен', true);
                        });
                });

                wrap.find('[data-set="timeline"]').on('hover:enter click', function () {
                    Lampa.Storage.set(STORAGE_KEYS.INCLUDE_TIMELINE, !incTimeline);
                    self.openSettingsScreen();
                });

                wrap.find('[data-set="sync"]').on('hover:enter click', function () {
                    Lampa.Storage.set(STORAGE_KEYS.AUTO_SYNC_CUB, !autoSync);
                    self.openSettingsScreen();
                });

                wrap.find('[data-set="back"]').on('hover:enter click', function () {
                    self.openMainMenu();
                });
            }, function () { self.openMainMenu(); });
        }
    };

    /**
     * ========================================================================
     * РЕГИСТРАЦИЯ ПЛАГИНА В ИНТЕРФЕЙСЕ LAMPA
     * ========================================================================
     */
    function startPlugin() {
        injectStyles();

        var menuItem = $([
            '<li class="menu__item selector" data-action="' + PLUGIN_ID + '">',
            '  <div class="menu__ico">',
            '    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
            '      <polyline points="17 1 21 5 17 9"></polyline>',
            '      <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>',
            '      <polyline points="7 23 3 19 7 15"></polyline>',
            '      <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>',
            '    </svg>',
            '  </div>',
            '  <div class="menu__text">' + PLUGIN_NAME + '</div>',
            '</li>'
        ].join(''));

        menuItem.on('hover:enter click', function () {
            UI.openMainMenu();
        });

        $('.menu .menu__list').eq(0).append(menuItem);

        if (Lampa.SettingsApi) {
            Lampa.SettingsApi.addComponent({
                component: PLUGIN_ID,
                name: PLUGIN_NAME,
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>'
            });

            Lampa.SettingsApi.addParam({
                component: PLUGIN_ID,
                param: { name: 'ht_v2_open', type: 'button' },
                field: {
                    name: 'Открыть History Transfer',
                    description: 'Перенос истории, закладок и серий между устройствами по одноразовому коду'
                },
                onChange: function () { UI.openMainMenu(); }
            });
        }
    }

    if (window.appready) {
        startPlugin();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') startPlugin();
        });
    }
})();
