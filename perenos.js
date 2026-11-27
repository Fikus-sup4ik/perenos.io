(function () {
    'use strict';

    if (window.lampa_history_transfer_plugin) return;
    window.lampa_history_transfer_plugin = true;

    var PLUGIN_ID = 'history_transfer';
    var PLUGIN_NAME = 'Lampa History Transfer';
    var PLUGIN_VERSION = '1.1.0';
    var SCHEMA_VERSION = 2;

    var STORAGE_KEYS = {
        API_URL: 'ht_api_url',
        TOKEN: 'ht_auth_token',
        USER: 'ht_auth_user',
        INCLUDE_TIMELINE: 'ht_include_timeline',
        AUTO_SYNC_CUB: 'ht_auto_sync_cub'
    };

    var DEFAULT_API_URL = (window.LAMPA_HISTORY_TRANSFER_CONFIG && window.LAMPA_HISTORY_TRANSFER_CONFIG.apiUrl)
        || 'https://lampa-history-transfer-api.your-subdomain.workers.dev';

    // Все 8 списков профиля Lampa/CUB (в дополнение к массиву полных объектов `card`)
    var FAVORITE_LIST_KEYS = [
        'history',    // История просмотров (раздел «История» в Lampa)
        'book',       // Закладки
        'like',       // Понравившиеся
        'wath',       // Смотрю (оригинальное имя ключа в Lampa)
        'viewed',     // Просмотрено
        'scheduled',  // Запланировано
        'continued',  // Продолжаю смотреть
        'thrown'      // Брошено
    ];

    var LIST_LABELS = {
        history: 'История просмотров',
        book: 'Закладки',
        like: 'Понравившиеся',
        wath: 'Смотрю',
        viewed: 'Просмотрено',
        scheduled: 'Запланировано',
        continued: 'Продолжаю смотреть',
        thrown: 'Брошено'
    };

    /**
     * ========================================================================
     * УТИЛИТЫ И КРИПТОГРАФИЯ
     * ========================================================================
     */
    var Utils = {
        getApiUrl: function () {
            var url = Lampa.Storage.get(STORAGE_KEYS.API_URL, DEFAULT_API_URL);
            return String(url || DEFAULT_API_URL).replace(/\/+$/, '');
        },

        getToken: function () {
            return Lampa.Storage.get(STORAGE_KEYS.TOKEN, '');
        },

        getUser: function () {
            return Lampa.Storage.get(STORAGE_KEYS.USER, null);
        },

        isAuthorized: function () {
            return Boolean(this.getToken() && this.getUser());
        },

        getCurrentLampaAccountInfo: function () {
            var acc = Lampa.Storage.get('account', {});
            var email = Lampa.Storage.get('account_email', '');
            if (acc && acc.token) {
                var label = acc.email || email || (acc.profile && acc.profile.name) || ('CUB ID: ' + (acc.id || 'Active'));
                return {
                    authorized: true,
                    id: acc.id || '',
                    label: String(label)
                };
            }
            return {
                authorized: false,
                id: '',
                label: 'Локальный профиль Lampa (без CUB)'
            };
        },

        deepClone: function (obj) {
            try {
                return JSON.parse(JSON.stringify(obj));
            } catch (e) {
                return obj;
            }
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
            if (!ts) return 'Никогда';
            var d = new Date(Number(ts));
            if (isNaN(d.getTime())) return 'Неизвестно';
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
            var token = Utils.getToken();

            return new Promise(function (resolve, reject) {
                if (!baseUrl || baseUrl.indexOf('http') !== 0) {
                    reject(new Error('Некорректный URL сервера API. Проверьте настройки.'));
                    return;
                }

                var headers = {
                    'Content-Type': 'application/json',
                    'X-Device-Name': 'Lampa ' + (Lampa.Platform ? Lampa.Platform.get() : 'Client')
                };

                if (token) {
                    headers['Authorization'] = 'Bearer ' + token;
                }

                var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                var timeoutId = setTimeout(function () {
                    if (controller) controller.abort();
                }, 25000);

                var fetchOptions = { method: method, headers: headers };
                if (controller) fetchOptions.signal = controller.signal;
                if (bodyData !== undefined) fetchOptions.body = JSON.stringify(bodyData);

                fetch(baseUrl + path, fetchOptions)
                    .then(function (response) {
                        clearTimeout(timeoutId);
                        return response.text().then(function (text) {
                            var json = null;
                            try {
                                json = JSON.parse(text);
                            } catch (e) {
                                throw new Error('Сервер вернул некорректный ответ (HTTP ' + response.status + ')');
                            }
                            if (!response.ok || (json && json.ok === false)) {
                                if (response.status === 401) {
                                    Lampa.Storage.set(STORAGE_KEYS.TOKEN, '');
                                    Lampa.Storage.set(STORAGE_KEYS.USER, null);
                                }
                                throw new Error((json && json.error) || ('Ошибка сервера HTTP ' + response.status));
                            }
                            return json;
                        });
                    })
                    .then(resolve)
                    .catch(function (err) {
                        clearTimeout(timeoutId);
                        if (err && err.name === 'AbortError') {
                            reject(new Error('Превышено время ожидания ответа от сервера.'));
                        } else {
                            reject(err);
                        }
                    });
            });
        },

        health: function () { return this.request('GET', '/api/health'); },
        register: function (username, password) { return this.request('POST', '/api/auth/register', { username: username, password: password }); },
        login: function (username, password) { return this.request('POST', '/api/auth/login', { username: username, password: password }); },
        logout: function () { return this.request('POST', '/api/auth/logout'); },
        getProfile: function () { return this.request('GET', '/api/auth/me'); },
        getBackupStatus: function () { return this.request('GET', '/api/backup/status'); },
        uploadBackup: function (payload, checksum, sourceLabel) {
            return this.request('POST', '/api/backup', {
                schema_version: SCHEMA_VERSION,
                source_account_label: sourceLabel,
                checksum: checksum,
                payload: payload
            });
        },
        downloadBackup: function () { return this.request('GET', '/api/backup'); },
        confirmImport: function (targetLabel, itemsProcessed) {
            return this.request('POST', '/api/backup/confirm-import', {
                target_account_label: targetLabel,
                items_processed: itemsProcessed
            });
        },
        deleteBackup: function () { return this.request('DELETE', '/api/backup'); },
        deleteAccount: function () { return this.request('DELETE', '/api/account'); }
    };

    /**
     * ========================================================================
     * ДВИЖОК ЭКСПОРТА И ИМПОРТА СТРУКТУРЫ LAMPA / CUB
     * ========================================================================
     */
    var TransferEngine = {
        /**
         * Чтение актуального объекта favorite из Lampa со всеми 9 полями
         */
        readNormalizedFavorite: function () {
            var raw = Lampa.Storage.get('favorite', {});
            if ((!raw || !Array.isArray(raw.card)) && Lampa.Favorite && typeof Lampa.Favorite.all === 'function') {
                raw = Lampa.Favorite.all() || {};
            }

            var result = {
                card: Array.isArray(raw.card) ? Utils.deepClone(raw.card) : []
            };

            FAVORITE_LIST_KEYS.forEach(function (key) {
                result[key] = Array.isArray(raw[key]) ? raw[key].slice() : [];
            });

            return result;
        },

        /**
         * Подсчёт статистики по всем полям favorite
         */
        getFavoriteStats: function (favObj) {
            var stats = {
                cards: Array.isArray(favObj.card) ? favObj.card.length : 0,
                totalListItems: 0,
                byList: {}
            };

            FAVORITE_LIST_KEYS.forEach(function (key) {
                var len = Array.isArray(favObj[key]) ? favObj[key].length : 0;
                stats.byList[key] = len;
                stats.totalListItems += len;
            });

            return stats;
        },

        /**
         * ЭТАП 6: Сбор полного слепка профиля Lampa/CUB (все 9 полей favorite + timeline)
         */
        collectLocalHistory: function () {
            var includeTimeline = Lampa.Storage.get(STORAGE_KEYS.INCLUDE_TIMELINE, true);
            var favoriteData = this.readNormalizedFavorite();

            // Индексируем полные объекты карточек и проверяем целостность связей ID <-> card
            var cardIndex = {};
            var deduplicatedCards = [];

            favoriteData.card.forEach(function (c) {
                if (!c || c.id === undefined || c.id === null) return;
                var idStr = String(c.id);
                if (!cardIndex[idStr]) {
                    cardIndex[idStr] = c;
                    deduplicatedCards.push(c);
                }
            });

            favoriteData.card = deduplicatedCards;

            // Проверяем, все ли ID из списков имеют соответствующую карточку в `card`
            var orphanIdsCount = 0;
            FAVORITE_LIST_KEYS.forEach(function (key) {
                var seenInList = {};
                var cleanList = [];
                favoriteData[key].forEach(function (id) {
                    var idStr = String(id);
                    if (seenInList[idStr]) return;
                    seenInList[idStr] = true;
                    cleanList.push(id);
                    if (!cardIndex[idStr]) {
                        orphanIdsCount++;
                    }
                });
                favoriteData[key] = cleanList;
            });

            // Дополнительно собираем прогресс серий (file_view / online_view / torrents_view)
            var timelineExport = {};
            var onlineViewExport = [];
            var torrentsViewExport = [];

            if (includeTimeline) {
                var rawTimeline = Lampa.Storage.get('file_view', {});
                if (rawTimeline && typeof rawTimeline === 'object') {
                    Object.keys(rawTimeline).forEach(function (hash) {
                        var item = rawTimeline[hash];
                        if (item && typeof item === 'object') {
                            timelineExport[hash] = {
                                hash: item.hash || hash,
                                percent: Number(item.percent || 0),
                                time: Number(item.time || 0),
                                duration: Number(item.duration || 0)
                            };
                        }
                    });
                }

                var rawOnline = Lampa.Storage.get('online_view', []);
                if (Array.isArray(rawOnline)) onlineViewExport = rawOnline.slice();

                var rawTorrents = Lampa.Storage.get('torrents_view', []);
                if (Array.isArray(rawTorrents)) torrentsViewExport = rawTorrents.slice();
            }

            return {
                exported_at: Date.now(),
                plugin_version: PLUGIN_VERSION,
                source_account: Utils.getCurrentLampaAccountInfo(),
                integrity: {
                    cards_total: favoriteData.card.length,
                    orphan_ids: orphanIdsCount
                },
                favorite: favoriteData,
                timeline: timelineExport,
                online_view: onlineViewExport,
                torrents_view: torrentsViewExport
            };
        },

        validateBeforeUpload: function (payload) {
            if (!payload || !payload.favorite) {
                return 'Не удалось прочитать структуру данных Lampa.';
            }
            var stats = this.getFavoriteStats(payload.favorite);
            var timelineCount = Object.keys(payload.timeline || {}).length;

            if (stats.cards === 0 && stats.totalListItems === 0 && timelineCount === 0) {
                return 'На текущем аккаунте Lampa не найдено записей истории, закладок или таймкодов.';
            }
            return null;
        },

        /**
         * ЭТАП 7: Восстановление данных в новый аккаунт с гарантией синхронизации CUB
         * mode: 'merge' (объединить без дубликатов) | 'replace' (заменить по согласию пользователя)
         */
        restoreBackupToLocal: function (backupData, mode, onProgress) {
            var self = this;
            return new Promise(function (resolve, reject) {
                try {
                    var payload = backupData.payload;
                    if (!payload || !payload.favorite) {
                        reject(new Error('Некорректная структура резервной копии.'));
                        return;
                    }

                    onProgress(10, 'Подготовка структуры данных нового аккаунта...');

                    // Карта всех карточек из бэкапа по строковому ID
                    var backupCardMap = {};
                    var backupCards = Array.isArray(payload.favorite.card) ? payload.favorite.card : [];
                    backupCards.forEach(function (c) {
                        if (c && c.id !== undefined && c.id !== null) {
                            backupCardMap[String(c.id)] = Utils.deepClone(c);
                        }
                    });

                    // Определяем базовое состояние нового аккаунта в зависимости от выбранного режима
                    var targetFav;
                    if (mode === 'replace') {
                        targetFav = { card: [] };
                        FAVORITE_LIST_KEYS.forEach(function (k) { targetFav[k] = []; });
                    } else {
                        targetFav = self.readNormalizedFavorite();
                    }

                    // Индекс существующих карточек в целевом профиле
                    var targetCardIndex = {};
                    targetFav.card.forEach(function (c) {
                        if (c && c.id !== undefined && c.id !== null) {
                            targetCardIndex[String(c.id)] = true;
                        }
                    });

                    // 1. Переносим все недостающие полные объекты карточек из `card`
                    onProgress(25, 'Перенос полных объектов карточек (' + backupCards.length + ')...');
                    var addedCards = 0;
                    backupCards.forEach(function (c) {
                        if (!c || c.id === undefined || c.id === null) return;
                        var idStr = String(c.id);
                        if (!targetCardIndex[idStr]) {
                            targetFav.card.push(Utils.deepClone(c));
                            targetCardIndex[idStr] = true;
                            addedCards++;
                        }
                    });

                    // 2. Формируем очередь операций для нативного Lampa.Favorite.add(type, card),
                    // чтобы CUB API получил уведомления о каждой добавленной записи и синхронизировал её в облако
                    var syncQueue = [];
                    var addedPerList = {};

                    FAVORITE_LIST_KEYS.forEach(function (listKey) {
                        addedPerList[listKey] = 0;
                        var incomingIds = Array.isArray(payload.favorite[listKey]) ? payload.favorite[listKey] : [];
                        var existingSet = {};
                        targetFav[listKey].forEach(function (id) {
                            existingSet[String(id)] = true;
                        });

                        // Собираем только новые уникальные ID
                        var toAdd = [];
                        incomingIds.forEach(function (id) {
                            var idStr = String(id);
                            if (!existingSet[idStr]) {
                                existingSet[idStr] = true;
                                toAdd.push(id);
                            }
                        });

                        // Обходим в обратном порядке, если будем добавлять через Lampa.Favorite.add (который делает unshift),
                        // чтобы сохранить оригинальный порядок списка
                        for (var i = toAdd.length - 1; i >= 0; i--) {
                            var itemId = toAdd[i];
                            var cardObj = backupCardMap[String(itemId)] || targetFav.card.find(function (x) {
                                return String(x.id) === String(itemId);
                            });

                            if (cardObj) {
                                syncQueue.push({
                                    type: listKey,
                                    card: cardObj
                                });
                                addedPerList[listKey]++;
                            } else {
                                // Если карточка отсутствовала даже в старом card, сохраняем ID напрямую в список
                                targetFav[listKey].push(itemId);
                                addedPerList[listKey]++;
                            }
                        }
                    });

                    // Если выбран режим replace, сначала очищаем локальный favorite
                    if (mode === 'replace') {
                        Lampa.Storage.set('favorite', targetFav);
                        if (Lampa.Favorite && typeof Lampa.Favorite.init === 'function') {
                            Lampa.Favorite.init();
                        }
                    } else {
                        // В режиме merge предварительно записываем недостающие карточки в favorite.card
                        Lampa.Storage.set('favorite', targetFav);
                    }

                    // 3. Пакетная запись через нативный Lampa.Favorite.add (гарантирует CUB Sync без 429 rate-limit)
                    var totalQueue = syncQueue.length;
                    var batchSize = 20;
                    var cursor = 0;

                    function processNextBatch() {
                        if (cursor >= totalQueue) {
                            finishTimelineAndSync();
                            return;
                        }

                        var end = Math.min(cursor + batchSize, totalQueue);
                        for (var idx = cursor; idx < end; idx++) {
                            var task = syncQueue[idx];
                            try {
                                if (Lampa.Favorite && typeof Lampa.Favorite.add === 'function') {
                                    Lampa.Favorite.add(task.type, task.card);
                                } else {
                                    var curFav = Lampa.Storage.get('favorite', {});
                                    if (!Array.isArray(curFav[task.type])) curFav[task.type] = [];
                                    if (curFav[task.type].indexOf(task.card.id) === -1) {
                                        curFav[task.type].unshift(task.card.id);
                                    }
                                    Lampa.Storage.set('favorite', curFav);
                                }
                            } catch (e) {
                                console.warn('[HistoryTransfer] Ошибка добавления карточки:', e);
                            }
                        }

                        cursor = end;
                        var pct = 35 + Math.round((cursor / Math.max(totalQueue, 1)) * 45);
                        onProgress(pct, 'Синхронизация списков с Lampa/CUB: ' + cursor + ' из ' + totalQueue + '...');

                        setTimeout(processNextBatch, 120);
                    }

                    function finishTimelineAndSync() {
                        onProgress(85, 'Восстановление таймкодов и просмотренных серий...');
                        var mergedEpisodes = 0;

                        if (payload.timeline && typeof payload.timeline === 'object') {
                            var currentTimeline = mode === 'replace' ? {} : (Lampa.Storage.get('file_view', {}) || {});
                            Object.keys(payload.timeline).forEach(function (hash) {
                                var inc = payload.timeline[hash];
                                if (!inc || typeof inc !== 'object') return;
                                var cur = currentTimeline[hash];
                                if (!cur || Number(inc.percent || 0) > Number(cur.percent || 0)) {
                                    currentTimeline[hash] = {
                                        hash: inc.hash || hash,
                                        percent: Number(inc.percent || 0),
                                        time: Number(inc.time || 0),
                                        duration: Number(inc.duration || 0)
                                    };
                                    mergedEpisodes++;
                                }
                            });
                            Lampa.Storage.set('file_view', currentTimeline);
                        }

                        ['online_view', 'torrents_view'].forEach(function (viewKey) {
                            var incArr = Array.isArray(payload[viewKey]) ? payload[viewKey] : [];
                            if (incArr.length === 0) return;
                            var curArr = mode === 'replace' ? [] : (Lampa.Storage.get(viewKey, []) || []);
                            var set = {};
                            curArr.forEach(function (h) { set[String(h)] = true; });
                            incArr.forEach(function (h) {
                                if (!set[String(h)]) {
                                    curArr.push(h);
                                    set[String(h)] = true;
                                    mergedEpisodes++;
                                }
                            });
                            Lampa.Storage.set(viewKey, curArr);
                        });

                        onProgress(95, 'Обновление интерфейса Lampa и отправка в облако CUB...');

                        if (Lampa.Favorite && typeof Lampa.Favorite.init === 'function') {
                            Lampa.Favorite.init();
                        }
                        if (Lampa.Timeline && typeof Lampa.Timeline.init === 'function') {
                            Lampa.Timeline.init();
                        }

                        var autoSyncCub = Lampa.Storage.get(STORAGE_KEYS.AUTO_SYNC_CUB, true);
                        var cubAccount = Utils.getCurrentLampaAccountInfo();

                        if (autoSyncCub && cubAccount.authorized && Lampa.Account && typeof Lampa.Account.sync === 'function') {
                            try {
                                Lampa.Account.sync();
                            } catch (e) {}
                        }

                        onProgress(100, 'Перенос успешно завершён!');

                        resolve({
                            mode: mode,
                            addedCards: addedCards,
                            addedPerList: addedPerList,
                            totalSyncedItems: totalQueue,
                            mergedEpisodes: mergedEpisodes,
                            cubSynced: autoSyncCub && cubAccount.authorized
                        });
                    }

                    processNextBatch();
                } catch (err) {
                    reject(err);
                }
            });
        }
    };

    /**
     * ========================================================================
     * СТИЛИ ИНТЕРФЕЙСА LAMPA
     * ========================================================================
     */
    function injectStyles() {
        if (document.getElementById('ht-plugin-styles')) return;
        var css = [
            '.ht-modal { padding: 1.5em; max-width: 54em; margin: 0 auto; color: #fff; }',
            '.ht-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 1em; margin-bottom: 1.2em; }',
            '.ht-title { font-size: 1.45em; font-weight: 700; letter-spacing: 0.02em; }',
            '.ht-badge { background: rgba(255,255,255,0.12); padding: 0.35em 0.75em; border-radius: 0.5em; font-size: 0.85em; color: #ddd; }',
            '.ht-badge--ok { background: rgba(46, 204, 113, 0.22); color: #2ecc71; border: 1px solid rgba(46, 204, 113, 0.4); }',
            '.ht-badge--warn { background: rgba(241, 196, 15, 0.2); color: #f1c40f; border: 1px solid rgba(241, 196, 15, 0.35); }',
            '.ht-status-card { background: rgba(255,255,255,0.06); border-radius: 0.8em; padding: 1em 1.2em; margin-bottom: 1.2em; display: flex; flex-wrap: wrap; gap: 1em; justify-content: space-between; }',
            '.ht-stat-box { flex: 1 1 30%; min-width: 10em; }',
            '.ht-stat-label { font-size: 0.8em; color: rgba(255,255,255,0.55); margin-bottom: 0.25em; }',
            '.ht-stat-val { font-size: 1.1em; font-weight: 600; }',
            '.ht-menu-list { display: flex; flex-direction: column; gap: 0.65em; }',
            '.ht-menu-item { display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.07); padding: 1em 1.25em; border-radius: 0.75em; transition: transform 0.15s ease, background 0.15s ease; border: 2px solid transparent; cursor: pointer; }',
            '.ht-menu-item.focus, .ht-menu-item:hover { background: rgba(255,255,255,0.16); border-color: #fff; transform: scale(1.01); }',
            '.ht-menu-left { display: flex; align-items: center; gap: 0.9em; }',
            '.ht-menu-icon { font-size: 1.4em; width: 1.5em; text-align: center; }',
            '.ht-menu-text-title { font-size: 1.05em; font-weight: 600; letter-spacing: 0.03em; }',
            '.ht-menu-text-desc { font-size: 0.82em; color: rgba(255,255,255,0.6); margin-top: 0.2em; }',
            '.ht-menu-arrow { font-size: 1.1em; opacity: 0.6; }',
            '.ht-progress-wrap { background: rgba(255,255,255,0.08); border-radius: 0.75em; padding: 1.2em; margin: 1em 0; }',
            '.ht-progress-bar-bg { width: 100%; height: 0.6em; background: rgba(255,255,255,0.15); border-radius: 1em; overflow: hidden; margin: 0.75em 0; }',
            '.ht-progress-bar-fill { height: 100%; background: #2ecc71; width: 0%; transition: width 0.25s ease; }',
            '.ht-btn-row { display: flex; gap: 0.8em; margin-top: 1.2em; flex-wrap: wrap; }',
            '.ht-btn { background: rgba(255,255,255,0.12); color: #fff; padding: 0.8em 1.3em; border-radius: 0.6em; font-weight: 600; border: 2px solid transparent; cursor: pointer; text-align: center; flex: 1 1 auto; }',
            '.ht-btn.focus, .ht-btn:hover { background: #fff; color: #111; border-color: #fff; }',
            '.ht-btn--danger { background: rgba(231, 76, 60, 0.25); color: #ff7675; }',
            '.ht-btn--danger.focus, .ht-btn--danger:hover { background: #e74c3c; color: #fff; border-color: #e74c3c; }',
            '.ht-info-table { width: 100%; border-collapse: collapse; margin: 0.8em 0; font-size: 0.9em; }',
            '.ht-info-table td, .ht-info-table th { padding: 0.5em 0.4em; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: left; }',
            '.ht-info-table th { color: rgba(255,255,255,0.55); font-weight: 500; }',
            '.ht-grid-8 { display: grid; grid-template-columns: repeat(auto-fit, minmax(11em, 1fr)); gap: 0.5em; margin: 0.8em 0; }',
            '.ht-grid-cell { background: rgba(255,255,255,0.05); padding: 0.55em 0.75em; border-radius: 0.5em; display: flex; justify-content: space-between; font-size: 0.85em; }'
        ].join('\n');

        var style = document.createElement('style');
        style.id = 'ht-plugin-styles';
        style.textContent = css;
        document.head.appendChild(style);
    }

    /**
     * ========================================================================
     * ПОЛЬЗОВАТЕЛЬСКИЙ ИНТЕРФЕЙС
     * ========================================================================
     */
    var UI = {
        openScreen: function (htmlContent, onReady, onBackCallback) {
            var wrap = $('<div class="ht-modal">' + htmlContent + '</div>');

            Lampa.Modal.open({
                title: '',
                html: wrap,
                size: 'medium',
                onBack: function () {
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
         * ГЛАВНОЕ МЕНЮ
         */
        openMainMenu: function () {
            var self = this;
            var isAuth = Utils.isAuthorized();
            var user = Utils.getUser();
            var lampaAcc = Utils.getCurrentLampaAccountInfo();
            var localFav = TransferEngine.readNormalizedFavorite();
            var localStats = TransferEngine.getFavoriteStats(localFav);

            var authBadge = isAuth
                ? '<span class="ht-badge ht-badge--ok">● ' + Utils.escapeHtml(user.username) + '</span>'
                : '<span class="ht-badge ht-badge--warn">Не выполнен вход</span>';

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">' + PLUGIN_NAME + '</div>',
                '  <div>' + authBadge + '</div>',
                '</div>',

                '<div class="ht-status-card">',
                '  <div class="ht-stat-box">',
                '    <div class="ht-stat-label">Текущий профиль Lampa</div>',
                '    <div class="ht-stat-val">' + Utils.escapeHtml(lampaAcc.label) + '</div>',
                '  </div>',
                '  <div class="ht-stat-box">',
                '    <div class="ht-stat-label">История / Карточки (card)</div>',
                '    <div class="ht-stat-val">' + localStats.byList.history + ' в истории / ' + localStats.cards + ' карт.</div>',
                '  </div>',
                '  <div class="ht-stat-box">',
                '    <div class="ht-stat-label">Облачный бэкап</div>',
                '    <div class="ht-stat-val" id="ht-cloud-quick-status">' + (isAuth ? 'Проверка...' : 'Требуется вход') + '</div>',
                '  </div>',
                '</div>',

                '<div class="ht-menu-list">',
                '  <div class="ht-menu-item selector" data-action="save">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">📤</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">СОХРАНИТЬ ИСТОРИЮ</div>',
                '        <div class="ht-menu-text-desc">Экспортировать все 9 разделов профиля (card, history, статусы, закладки) и серии</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                '  <div class="ht-menu-item selector" data-action="restore">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">📥</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">ВОССТАНОВИТЬ ИСТОРИЮ</div>',
                '        <div class="ht-menu-text-desc">Проверить бэкап и перенести данные в текущий аккаунт Lampa/CUB</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                '  <div class="ht-menu-item selector" data-action="account">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">👤</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">МОЙ АККАУНТ</div>',
                '        <div class="ht-menu-text-desc">Вход, регистрация и журнал операций History Transfer</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                '  <div class="ht-menu-item selector" data-action="cloud">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">☁️</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">ОБЛАЧНОЕ ХРАНИЛИЩЕ</div>',
                '        <div class="ht-menu-text-desc">Состояние облачной копии, контрольная сумма и очистка</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',

                '  <div class="ht-menu-item selector" data-action="settings">',
                '    <div class="ht-menu-left">',
                '      <div class="ht-menu-icon">⚙️</div>',
                '      <div>',
                '        <div class="ht-menu-text-title">НАСТРОЙКИ</div>',
                '        <div class="ht-menu-text-desc">Адрес API Cloudflare Workers и параметры синхронизации</div>',
                '      </div>',
                '    </div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('.ht-menu-item').on('hover:enter click', function () {
                    var action = $(this).data('action');
                    if (action === 'save') self.handleExportFlow();
                    else if (action === 'restore') self.prepareImportFlow();
                    else if (action === 'account') self.openAccountScreen();
                    else if (action === 'cloud') self.openCloudStorageScreen();
                    else if (action === 'settings') self.openSettingsScreen();
                });

                if (isAuth) {
                    ApiClient.getBackupStatus()
                        .then(function (res) {
                            var el = wrap.find('#ht-cloud-quick-status');
                            if (res.exists && res.backup) {
                                el.text('Доступен (' + res.backup.history_count + ' в истории)');
                            } else {
                                el.text('Пусто (нет копии)');
                            }
                        })
                        .catch(function () {
                            wrap.find('#ht-cloud-quick-status').text('Ошибка связи с API');
                        });
                }
            });
        },

        /**
         * ЭКСПОРТ ИСТОРИИ (ВСЕ 9 ПОЛЕЙ + TIMELINE)
         */
        handleExportFlow: function () {
            var self = this;
            if (!Utils.isAuthorized()) {
                Utils.notify('Сначала войдите или зарегистрируйтесь в «Мой аккаунт»', true);
                this.openAccountScreen(function () { self.handleExportFlow(); });
                return;
            }

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">📤 Сохранение истории</div>',
                '  <span class="ht-badge">Экспорт</span>',
                '</div>',
                '<div class="ht-progress-wrap">',
                '  <div id="ht-export-step">Сбор всех разделов профиля Lampa...</div>',
                '  <div class="ht-progress-bar-bg"><div class="ht-progress-bar-fill" id="ht-export-bar"></div></div>',
                '  <div id="ht-export-details" style="font-size:0.85em;color:rgba(255,255,255,0.65);"></div>',
                '</div>',
                '<div id="ht-export-breakdown"></div>',
                '<div class="ht-btn-row" id="ht-export-actions" style="display:none;">',
                '  <div class="ht-btn selector" data-act="back">Вернуться в меню</div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                var setProgress = function (pct, text, details) {
                    wrap.find('#ht-export-bar').css('width', pct + '%');
                    wrap.find('#ht-export-step').text(text);
                    if (details !== undefined) wrap.find('#ht-export-details').text(details);
                };

                var finish = function () {
                    wrap.find('#ht-export-actions').show();
                    Lampa.Controller.collectionSet(wrap);
                    var btn = wrap.find('.selector').first()[0];
                    if (btn) Lampa.Controller.collectionFocus(btn, wrap);
                    wrap.find('[data-act="back"]').on('hover:enter click', function () { self.openMainMenu(); });
                };

                setTimeout(function () {
                    setProgress(25, 'Чтение card, history, book, like, wath, viewed, scheduled, continued, thrown...');
                    var payload = TransferEngine.collectLocalHistory();
                    var validationError = TransferEngine.validateBeforeUpload(payload);

                    if (validationError) {
                        wrap.find('#ht-export-bar').css('background', '#e74c3c');
                        setProgress(100, 'Экспорт невозможен', validationError);
                        Utils.notify(validationError, true);
                        finish();
                        return;
                    }

                    // Отрисовываем сводку по всем 8 спискам и карточкам
                    var gridHtml = '<div class="ht-grid-8">' +
                        '<div class="ht-grid-cell"><span>Карточки (card)</span><strong>' + payload.favorite.card.length + '</strong></div>';
                    FAVORITE_LIST_KEYS.forEach(function (k) {
                        gridHtml += '<div class="ht-grid-cell"><span>' + LIST_LABELS[k] + '</span><strong>' + payload.favorite[k].length + '</strong></div>';
                    });
                    gridHtml += '</div>';
                    wrap.find('#ht-export-breakdown').html(gridHtml);

                    setProgress(60, 'Вычисление SHA-256 и отправка в Cloudflare D1...');
                    var payloadStr = JSON.stringify(payload);

                    Utils.sha256(payloadStr).then(function (checksum) {
                        return ApiClient.uploadBackup(payload, checksum, payload.source_account.label);
                    }).then(function (res) {
                        var b = res.backup;
                        setProgress(
                            100,
                            'Резервная копия успешно сохранена!',
                            'Полных карточек: ' + b.cards_count + ' | Истории: ' + b.history_count +
                            ' | Таймкодов: ' + b.episodes_count + ' (' + Utils.formatBytes(b.size_bytes) + ')'
                        );
                        Utils.notify('История и все списки успешно сохранены!');
                        finish();
                    }).catch(function (err) {
                        wrap.find('#ht-export-bar').css('background', '#e74c3c');
                        setProgress(100, 'Ошибка при сохранении', err.message || 'Сбой сети');
                        Utils.notify(err.message || 'Ошибка экспорта', true);
                        finish();
                    });
                }, 150);
            }, function () { self.openMainMenu(); });
        },

        /**
         * ПРЕДВАРИТЕЛЬНАЯ ПРОВЕРКА ПЕРЕД ИМПОРТОМ И ПОЛУЧЕНИЕ СОГЛАСИЯ ПОЛЬЗОВАТЕЛЯ (п. 5)
         */
        prepareImportFlow: function () {
            var self = this;
            if (!Utils.isAuthorized()) {
                Utils.notify('Сначала авторизуйтесь в системе History Transfer', true);
                this.openAccountScreen(function () { self.prepareImportFlow(); });
                return;
            }

            var htmlLoading = [
                '<div class="ht-header">',
                '  <div class="ht-title">📥 Подготовка к восстановлению</div>',
                '  <span class="ht-badge">Анализ</span>',
                '</div>',
                '<p style="color:rgba(255,255,255,0.75);">Загрузка метаданных резервной копии и сравнение с текущим аккаунтом...</p>'
            ].join('');

            this.openScreen(htmlLoading, function () {
                ApiClient.downloadBackup()
                    .then(function (res) {
                        var backup = res.backup;
                        if (Number(backup.schema_version) > SCHEMA_VERSION) {
                            throw new Error('Версия резервной копии новее текущей версии плагина. Обновите плагин.');
                        }

                        var localFav = TransferEngine.readNormalizedFavorite();
                        var localStats = TransferEngine.getFavoriteStats(localFav);
                        var backupStats = TransferEngine.getFavoriteStats(backup.payload.favorite || {});
                        var targetAcc = Utils.getCurrentLampaAccountInfo();

                        var rowsHtml = FAVORITE_LIST_KEYS.map(function (k) {
                            return '<tr><td>' + LIST_LABELS[k] + '</td><td>' + backupStats.byList[k] + '</td><td>' + localStats.byList[k] + '</td></tr>';
                        }).join('');

                        var confirmHtml = [
                            '<div class="ht-header">',
                            '  <div class="ht-title">📥 Подтверждение восстановления</div>',
                            '  <span class="ht-badge ht-badge--ok">Копия готова</span>',
                            '</div>',
                            '<p style="font-size:0.9em;color:rgba(255,255,255,0.75);margin-bottom:0.8em;">',
                            '  Источник: <strong>' + Utils.escapeHtml(backup.source_account_label) + '</strong> (' + Utils.formatDate(backup.updated_at) + ')<br>',
                            '  Целевой профиль: <strong>' + Utils.escapeHtml(targetAcc.label) + '</strong>',
                            '</p>',
                            '<table class="ht-info-table">',
                            '  <thead><tr><th>Раздел</th><th>В облаке (бэкап)</th><th>Сейчас на аккаунте</th></tr></thead>',
                            '  <tbody>',
                            '    <tr><td><strong>Полные карточки (card)</strong></td><td><strong>' + backupStats.cards + '</strong></td><td><strong>' + localStats.cards + '</strong></td></tr>',
                            rowsHtml,
                            '  </tbody>',
                            '</table>',
                            '<div class="ht-menu-list" style="margin-top:1em;">',
                            '  <div class="ht-menu-item selector" data-mode="merge">',
                            '    <div class="ht-menu-left">',
                            '      <div class="ht-menu-icon">🔀</div>',
                            '      <div>',
                            '        <div class="ht-menu-text-title">Объединить без дубликатов (Рекомендуется)</div>',
                            '        <div class="ht-menu-text-desc">Сохранить существующие записи нового аккаунта и добавить отсутствующие из копии</div>',
                            '      </div>',
                            '    </div>',
                            '    <div class="ht-menu-arrow">❯</div>',
                            '  </div>',
                            '  <div class="ht-menu-item selector" data-mode="replace">',
                            '    <div class="ht-menu-left">',
                            '      <div class="ht-menu-icon">♻️</div>',
                            '      <div>',
                            '        <div class="ht-menu-text-title">Заменить данные нового аккаунта</div>',
                            '        <div class="ht-menu-text-desc">Полностью перезаписать списки текущего аккаунта данными из резервной копии</div>',
                            '      </div>',
                            '    </div>',
                            '    <div class="ht-menu-arrow">❯</div>',
                            '  </div>',
                            '</div>',
                            '<div class="ht-btn-row">',
                            '  <div class="ht-btn selector" data-mode="cancel">Отмена</div>',
                            '</div>'
                        ].join('');

                        self.openScreen(confirmHtml, function (wrap) {
                            wrap.find('[data-mode="merge"]').on('hover:enter click', function () {
                                self.executeImportFlow(backup, 'merge');
                            });
                            wrap.find('[data-mode="replace"]').on('hover:enter click', function () {
                                self.executeImportFlow(backup, 'replace');
                            });
                            wrap.find('[data-mode="cancel"]').on('hover:enter click', function () {
                                self.openMainMenu();
                            });
                        }, function () { self.openMainMenu(); });
                    })
                    .catch(function (err) {
                        Utils.notify(err.message || 'Не удалось получить резервную копию', true);
                        self.openMainMenu();
                    });
            }, function () { self.openMainMenu(); });
        },

        /**
         * ВЫПОЛНЕНИЕ ИМПОРТА С ОТОБРАЖЕНИЕМ ПРОГРЕССА
         */
        executeImportFlow: function (backup, mode) {
            var self = this;
            var targetAcc = Utils.getCurrentLampaAccountInfo();

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">📥 Восстановление истории</div>',
                '  <span class="ht-badge">' + (mode === 'replace' ? 'Замена' : 'Слияние') + '</span>',
                '</div>',
                '<div class="ht-progress-wrap">',
                '  <div id="ht-import-step">Инициализация переноса...</div>',
                '  <div class="ht-progress-bar-bg"><div class="ht-progress-bar-fill" id="ht-import-bar"></div></div>',
                '  <div id="ht-import-details" style="font-size:0.85em;color:rgba(255,255,255,0.65);">Не закрывайте Lampa до завершения синхронизации.</div>',
                '</div>',
                '<div id="ht-import-result-grid"></div>',
                '<div class="ht-btn-row" id="ht-import-actions" style="display:none;">',
                '  <div class="ht-btn selector" data-act="back">Готово (в главное меню)</div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                var setProgress = function (pct, text, details) {
                    wrap.find('#ht-import-bar').css('width', pct + '%');
                    wrap.find('#ht-import-step').text(text);
                    if (details !== undefined) wrap.find('#ht-import-details').text(details);
                };

                var finish = function () {
                    wrap.find('#ht-import-actions').show();
                    Lampa.Controller.collectionSet(wrap);
                    var btn = wrap.find('.selector').first()[0];
                    if (btn) Lampa.Controller.collectionFocus(btn, wrap);
                    wrap.find('[data-act="back"]').on('hover:enter click', function () { self.openMainMenu(); });
                };

                TransferEngine.restoreBackupToLocal(backup, mode, function (pct, msg) {
                    setProgress(pct, msg);
                }).then(function (stats) {
                    ApiClient.confirmImport(targetAcc.label, stats.totalSyncedItems + stats.mergedEpisodes).catch(function () {});

                    var gridHtml = '<div class="ht-grid-8">' +
                        '<div class="ht-grid-cell"><span>Добавлено карточек</span><strong>+' + stats.addedCards + '</strong></div>';
                    FAVORITE_LIST_KEYS.forEach(function (k) {
                        gridHtml += '<div class="ht-grid-cell"><span>' + LIST_LABELS[k] + '</span><strong>+' + (stats.addedPerList[k] || 0) + '</strong></div>';
                    });
                    gridHtml += '</div>';
                    wrap.find('#ht-import-result-grid').html(gridHtml);

                    var syncNote = stats.cubSynced
                        ? 'Синхронизация с облаком CUB запущена.'
                        : 'Данные сохранены в профиле Lampa.';

                    setProgress(
                        100,
                        'Восстановление успешно завершено!',
                        'Перенесено записей: ' + stats.totalSyncedItems + ' | Таймкодов серий: +' + stats.mergedEpisodes + '. ' + syncNote
                    );
                    Utils.notify('История просмотров успешно перенесена!');
                    finish();
                }).catch(function (err) {
                    wrap.find('#ht-import-bar').css('background', '#e74c3c');
                    setProgress(100, 'Ошибка при восстановлении', err.message || 'Неизвестная ошибка');
                    Utils.notify(err.message || 'Ошибка импорта', true);
                    finish();
                });
            }, function () { self.openMainMenu(); });
        },

        /**
         * МОЙ АККАУНТ
         */
        openAccountScreen: function (onAuthSuccess) {
            var self = this;
            if (!Utils.isAuthorized()) {
                var htmlGuest = [
                    '<div class="ht-header">',
                    '  <div class="ht-title">👤 Мой аккаунт History Transfer</div>',
                    '  <span class="ht-badge ht-badge--warn">Гость</span>',
                    '</div>',
                    '<p style="color:rgba(255,255,255,0.75);line-height:1.45;margin-bottom:1.2em;">',
                    '  Создайте отдельный аккаунт для переноса истории или войдите в существующий. ',
                    '  Пароли от Lampa/CUB не запрашиваются и не передаются.',
                    '</p>',
                    '<div class="ht-menu-list">',
                    '  <div class="ht-menu-item selector" data-auth="login">',
                    '    <div class="ht-menu-left"><div class="ht-menu-icon">🔑</div><div><div class="ht-menu-text-title">Войти в существующий аккаунт</div><div class="ht-menu-text-desc">Использовать логин и пароль History Transfer</div></div></div>',
                    '    <div class="ht-menu-arrow">❯</div>',
                    '  </div>',
                    '  <div class="ht-menu-item selector" data-auth="register">',
                    '    <div class="ht-menu-left"><div class="ht-menu-icon">✨</div><div><div class="ht-menu-text-title">Зарегистрировать новый аккаунт</div><div class="ht-menu-text-desc">Создать учётную запись в облаке переноса</div></div></div>',
                    '    <div class="ht-menu-arrow">❯</div>',
                    '  </div>',
                    '</div>',
                    '<div class="ht-btn-row"><div class="ht-btn selector" data-auth="back">Назад в меню</div></div>'
                ].join('');

                this.openScreen(htmlGuest, function (wrap) {
                    wrap.find('[data-auth="login"]').on('hover:enter click', function () { self.promptCredentials('login', onAuthSuccess); });
                    wrap.find('[data-auth="register"]').on('hover:enter click', function () { self.promptCredentials('register', onAuthSuccess); });
                    wrap.find('[data-auth="back"]').on('hover:enter click', function () { self.openMainMenu(); });
                }, function () { self.openMainMenu(); });
                return;
            }

            var user = Utils.getUser();
            var htmlUser = [
                '<div class="ht-header">',
                '  <div class="ht-title">👤 Мой аккаунт</div>',
                '  <span class="ht-badge ht-badge--ok">' + Utils.escapeHtml(user.username) + '</span>',
                '</div>',
                '<div id="ht-account-profile-body">Загрузка профиля...</div>',
                '<div class="ht-btn-row">',
                '  <div class="ht-btn selector" data-acc="logout">Выйти</div>',
                '  <div class="ht-btn ht-btn--danger selector" data-acc="delete_account">Удалить аккаунт</div>',
                '  <div class="ht-btn selector" data-acc="back">Назад</div>',
                '</div>'
            ].join('');

            this.openScreen(htmlUser, function (wrap) {
                ApiClient.getProfile().then(function (res) {
                    var logsHtml = '';
                    if (res.logs && res.logs.length > 0) {
                        logsHtml = '<div style="margin-top:1em;font-weight:600;">Последние операции:</div><table class="ht-info-table">';
                        res.logs.slice(0, 5).forEach(function (l) {
                            logsHtml += '<tr><td>' + Utils.escapeHtml(l.action) + ' (' + Utils.escapeHtml(l.target_account_label || '') + ')</td>' +
                                '<td style="text-align:right;">' + l.items_processed + ' зап. • ' + Utils.formatDate(l.created_at) + '</td></tr>';
                        });
                        logsHtml += '</table>';
                    }
                    wrap.find('#ht-account-profile-body').html([
                        '<table class="ht-info-table">',
                        '  <tr><td>Логин</td><td style="text-align:right;">' + Utils.escapeHtml(res.user.username) + '</td></tr>',
                        '  <tr><td>Дата регистрации</td><td style="text-align:right;">' + Utils.formatDate(res.user.created_at) + '</td></tr>',
                        '  <tr><td>Резервная копия</td><td style="text-align:right;">' + (res.backup ? res.backup.cards_count + ' карт. / ' + res.backup.history_count + ' в истории' : 'Нет копии') + '</td></tr>',
                        '</table>',
                        logsHtml
                    ].join(''));
                }).catch(function (err) {
                    wrap.find('#ht-account-profile-body').text('Ошибка: ' + err.message);
                });

                wrap.find('[data-acc="logout"]').on('hover:enter click', function () {
                    ApiClient.logout().catch(function () {});
                    Lampa.Storage.set(STORAGE_KEYS.TOKEN, '');
                    Lampa.Storage.set(STORAGE_KEYS.USER, null);
                    Utils.notify('Вы вышли из аккаунта');
                    self.openMainMenu();
                });

                wrap.find('[data-acc="delete_account"]').on('hover:enter click', function () {
                    self.confirmAction('Удалить аккаунт навсегда?', 'Все ваши резервные копии и история операций на сервере будут удалены.', function () {
                        ApiClient.deleteAccount().then(function () {
                            Lampa.Storage.set(STORAGE_KEYS.TOKEN, '');
                            Lampa.Storage.set(STORAGE_KEYS.USER, null);
                            Utils.notify('Аккаунт удалён');
                            self.openMainMenu();
                        }).catch(function (err) { Utils.notify(err.message, true); });
                    });
                });

                wrap.find('[data-acc="back"]').on('hover:enter click', function () { self.openMainMenu(); });
            }, function () { self.openMainMenu(); });
        },

        promptCredentials: function (mode, onAuthSuccess) {
            var self = this;
            var isReg = mode === 'register';
            Lampa.Modal.close();

            Lampa.Input.edit({
                title: isReg ? 'Придумайте логин (латиница, 3-32 симв.)' : 'Введите логин History Transfer',
                value: '',
                free: true,
                nosave: true
            }, function (username) {
                username = String(username || '').trim();
                if (!username) { self.openAccountScreen(onAuthSuccess); return; }

                setTimeout(function () {
                    Lampa.Input.edit({
                        title: isReg ? 'Придумайте пароль (минимум 6 символов)' : 'Введите пароль',
                        value: '',
                        free: true,
                        nosave: true
                    }, function (password) {
                        password = String(password || '');
                        if (!password) { self.openAccountScreen(onAuthSuccess); return; }

                        Utils.notify(isReg ? 'Регистрация...' : 'Вход...');
                        var req = isReg ? ApiClient.register(username, password) : ApiClient.login(username, password);
                        req.then(function (res) {
                            Lampa.Storage.set(STORAGE_KEYS.TOKEN, res.token);
                            Lampa.Storage.set(STORAGE_KEYS.USER, res.user);
                            Utils.notify('Успешный вход: ' + res.user.username);
                            if (typeof onAuthSuccess === 'function') onAuthSuccess();
                            else self.openMainMenu();
                        }).catch(function (err) {
                            Utils.notify(err.message || 'Ошибка авторизации', true);
                            self.openAccountScreen(onAuthSuccess);
                        });
                    });
                }, 200);
            });
        },

        /**
         * ОБЛАЧНОЕ ХРАНИЛИЩЕ
         */
        openCloudStorageScreen: function () {
            var self = this;
            if (!Utils.isAuthorized()) {
                Utils.notify('Войдите в аккаунт для просмотра хранилища', true);
                this.openAccountScreen(function () { self.openCloudStorageScreen(); });
                return;
            }

            var html = [
                '<div class="ht-header">',
                '  <div class="ht-title">☁️ Облачное хранилище</div>',
                '  <span class="ht-badge">Cloudflare D1</span>',
                '</div>',
                '<div id="ht-cloud-body">Загрузка информации...</div>',
                '<div class="ht-btn-row" id="ht-cloud-btns">',
                '  <div class="ht-btn selector" data-cloud="back">Назад в меню</div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                ApiClient.getBackupStatus().then(function (res) {
                    if (!res.exists || !res.backup) {
                        wrap.find('#ht-cloud-body').html('<p style="color:rgba(255,255,255,0.7);padding:1em 0;">Резервная копия отсутствует.</p>');
                        return;
                    }
                    var b = res.backup;
                    wrap.find('#ht-cloud-body').html([
                        '<table class="ht-info-table">',
                        '  <tr><td>Исходный аккаунт</td><td style="text-align:right;">' + Utils.escapeHtml(b.source_account_label) + '</td></tr>',
                        '  <tr><td>Записей в истории (history)</td><td style="text-align:right;">' + b.history_count + '</td></tr>',
                        '  <tr><td>Полных карточек (card)</td><td style="text-align:right;">' + b.cards_count + '</td></tr>',
                        '  <tr><td>Таймкодов серий</td><td style="text-align:right;">' + b.episodes_count + '</td></tr>',
                        '  <tr><td>Размер копии</td><td style="text-align:right;">' + Utils.formatBytes(b.size_bytes) + '</td></tr>',
                        '  <tr><td>Обновлено</td><td style="text-align:right;">' + Utils.formatDate(b.updated_at) + '</td></tr>',
                        '  <tr><td>SHA-256</td><td style="text-align:right;">' + Utils.escapeHtml((b.checksum || '').slice(0, 16)) + '...</td></tr>',
                        '</table>'
                    ].join(''));

                    wrap.find('#ht-cloud-btns').prepend('<div class="ht-btn ht-btn--danger selector" data-cloud="delete">Удалить копию</div>');
                    Lampa.Controller.collectionSet(wrap);

                    wrap.find('[data-cloud="delete"]').on('hover:enter click', function () {
                        self.confirmAction('Удалить резервную копию из облака?', 'Локальные данные на устройстве останутся без изменений.', function () {
                            ApiClient.deleteBackup().then(function () {
                                Utils.notify('Резервная копия удалена');
                                self.openCloudStorageScreen();
                            }).catch(function (err) { Utils.notify(err.message, true); });
                        });
                    });
                }).catch(function (err) {
                    wrap.find('#ht-cloud-body').text('Ошибка: ' + err.message);
                });

                wrap.find('[data-cloud="back"]').on('hover:enter click', function () { self.openMainMenu(); });
            }, function () { self.openMainMenu(); });
        },

        /**
         * НАСТРОЙКИ
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
                '    <div class="ht-menu-left"><div class="ht-menu-icon">🌐</div><div><div class="ht-menu-text-title">Адрес сервера API</div><div class="ht-menu-text-desc">' + Utils.escapeHtml(apiUrl) + '</div></div></div>',
                '    <div class="ht-menu-arrow">✎</div>',
                '  </div>',
                '  <div class="ht-menu-item selector" data-set="test_api">',
                '    <div class="ht-menu-left"><div class="ht-menu-icon">📡</div><div><div class="ht-menu-text-title">Проверить соединение с сервером</div><div class="ht-menu-text-desc">Проверка Cloudflare Worker и D1</div></div></div>',
                '    <div class="ht-menu-arrow">❯</div>',
                '  </div>',
                '  <div class="ht-menu-item selector" data-set="toggle_timeline">',
                '    <div class="ht-menu-left"><div class="ht-menu-icon">⏱️</div><div><div class="ht-menu-text-title">Переносить таймкоды и просмотренные серии</div><div class="ht-menu-text-desc">Дополнительно к 9 разделам favorite</div></div></div>',
                '    <div class="ht-badge">' + (incTimeline ? 'ВКЛ' : 'ВЫКЛ') + '</div>',
                '  </div>',
                '  <div class="ht-menu-item selector" data-set="toggle_sync">',
                '    <div class="ht-menu-left"><div class="ht-menu-icon">🔄</div><div><div class="ht-menu-text-title">Автосинхронизация с CUB после импорта</div><div class="ht-menu-text-desc">Отправлять восстановленные списки в облако нового аккаунта CUB</div></div></div>',
                '    <div class="ht-badge">' + (autoSync ? 'ВКЛ' : 'ВЫКЛ') + '</div>',
                '  </div>',
                '</div>',
                '<div class="ht-btn-row"><div class="ht-btn selector" data-set="back">Назад в меню</div></div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('[data-set="api_url"]').on('hover:enter click', function () {
                    Lampa.Modal.close();
                    Lampa.Input.edit({
                        title: 'URL вашего Cloudflare Worker',
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

                wrap.find('[data-set="test_api"]').on('hover:enter click', function () {
                    Utils.notify('Проверка соединения...');
                    ApiClient.health()
                        .then(function (res) { Utils.notify('Сервер доступен! База D1: ' + (res.database || 'OK')); })
                        .catch(function (err) { Utils.notify('Ошибка: ' + err.message, true); });
                });

                wrap.find('[data-set="toggle_timeline"]').on('hover:enter click', function () {
                    Lampa.Storage.set(STORAGE_KEYS.INCLUDE_TIMELINE, !incTimeline);
                    self.openSettingsScreen();
                });

                wrap.find('[data-set="toggle_sync"]').on('hover:enter click', function () {
                    Lampa.Storage.set(STORAGE_KEYS.AUTO_SYNC_CUB, !autoSync);
                    self.openSettingsScreen();
                });

                wrap.find('[data-set="back"]').on('hover:enter click', function () { self.openMainMenu(); });
            }, function () { self.openMainMenu(); });
        },

        confirmAction: function (title, message, onConfirm) {
            var self = this;
            var html = [
                '<div class="ht-header"><div class="ht-title">' + Utils.escapeHtml(title) + '</div></div>',
                '<p style="color:rgba(255,255,255,0.8);line-height:1.5;margin-bottom:1.2em;">' + Utils.escapeHtml(message) + '</p>',
                '<div class="ht-btn-row">',
                '  <div class="ht-btn ht-btn--danger selector" data-cfm="yes">Подтвердить</div>',
                '  <div class="ht-btn selector" data-cfm="no">Отмена</div>',
                '</div>'
            ].join('');

            this.openScreen(html, function (wrap) {
                wrap.find('[data-cfm="yes"]').on('hover:enter click', onConfirm);
                wrap.find('[data-cfm="no"]').on('hover:enter click', function () { self.openMainMenu(); });
            }, function () { self.openMainMenu(); });
        }
    };

    /**
     * ========================================================================
     * ИНИЦИАЛИЗАЦИЯ ПЛАГИНА
     * ========================================================================
     */
    function startPlugin() {
        injectStyles();

        var menuButton = $([
            '<li class="menu__item selector" data-action="' + PLUGIN_ID + '">',
            '  <div class="menu__ico">',
            '    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
            '      <polyline points="17 1 21 5 17 9"></polyline>',
            '      <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>',
            '      <polyline points="7 23 3 19 7 15"></polyline>',
            '      <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>',
            '    </svg>',
            '  </div>',
            '  <div class="menu__text">History Transfer</div>',
            '</li>'
        ].join(''));

        menuButton.on('hover:enter click', function () {
            UI.openMainMenu();
        });

        $('.menu .menu__list').eq(0).append(menuButton);

        if (Lampa.SettingsApi) {
            Lampa.SettingsApi.addComponent({
                component: PLUGIN_ID,
                name: 'History Transfer',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>'
            });

            Lampa.SettingsApi.addParam({
                component: PLUGIN_ID,
                param: { name: 'ht_open_manager', type: 'button' },
                field: {
                    name: 'Открыть менеджер переноса истории',
                    description: 'Экспорт и импорт всех разделов профиля Lampa/CUB'
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