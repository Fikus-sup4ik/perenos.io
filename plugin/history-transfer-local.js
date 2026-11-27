/**
 * Lampa History Transfer LOCAL
 * Автономный экспорт/импорт профиля Lampa/CUB через JSON-файл.
 * Без облачного сервера, регистрации и стороннего backend.
 * Версия 1.0.0
 *
 * Важно:
 * - Экспортирует доступные bookmarks/dump и timeline/dump.
 * - Импорт работает в безопасном режиме объединения: существующие записи не удаляются.
 * - Серверную историю просмотра можно восстановить только в той мере, в какой она
 *   представлена в bookmarks/dump и поддерживается bookmarks/add.
 * - Требуется авторизованный аккаунт CUB с включённой синхронизацией.
 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var CATEGORIES = ['history', 'book', 'like', 'wath', 'look', 'viewed', 'scheduled', 'continued', 'thrown'];
  var BUSY = false;

  function logError(error) {
    try {
      if (root.console && console.error) console.error('[History Transfer Local]', error);
    } catch (e) {}
  }

  function getAccount(Lampa) {
    var account = {};
    try {
      account = Lampa.Storage.get('account', '{}');
      if (typeof account === 'string') account = JSON.parse(account);
    } catch (e) { account = {}; }

    var profileId = account && account.profile && account.profile.id ? account.profile.id : 0;
    var token = account && account.token ? account.token : '';
    var sync = false;

    try {
      sync = !!(Lampa.Account && Lampa.Account.Permit && Lampa.Account.Permit.sync);
    } catch (e) {}

    if (!sync) {
      try { sync = !!(token && Lampa.Storage.field('account_use')); } catch (e) {}
    }

    return {
      token: token,
      profileId: profileId,
      profileName: account && account.profile && account.profile.name ? account.profile.name : 'Основной',
      sync: sync
    };
  }

  function cubBase(Lampa) {
    var protocol = 'https://';
    var domain = 'cub.rip';
    try {
      if (Lampa.Utils && typeof Lampa.Utils.protocol === 'function') protocol = Lampa.Utils.protocol();
      if (Lampa.Manifest && Lampa.Manifest.cub_domain) domain = Lampa.Manifest.cub_domain;
    } catch (e) {}
    return protocol + domain + '/api/';
  }

  function request(Lampa, path, method, data, isForm, callback, fail) {
    var account = getAccount(Lampa);
    if (!account.token || !account.profileId) {
      fail(new Error('Сначала войдите в аккаунт CUB и выберите профиль.'));
      return;
    }

    var xhr = new XMLHttpRequest();
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      try { xhr.abort(); } catch (e) {}
      fail(new Error('Истекло время ожидания ответа CUB.'));
    }, 25000);

    xhr.open(method || 'GET', cubBase(Lampa) + path, true);
    xhr.setRequestHeader('token', account.token);
    xhr.setRequestHeader('profile', String(account.profileId));
    if (method === 'POST' && !isForm) {
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
    }

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || done) return;
      done = true;
      clearTimeout(timer);

      if (xhr.status >= 200 && xhr.status < 300) {
        var result = xhr.responseText || '{}';
        try { result = JSON.parse(result); } catch (e) {}
        callback(result);
      } else {
        fail(new Error('CUB API вернул HTTP ' + xhr.status + ' (' + path + ').'));
      }
    };
    xhr.onerror = function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fail(new Error('Сетевая ошибка при обращении к CUB (' + path + ').'));
    };

    if (isForm) {
      xhr.send(data);
    } else if (method === 'POST' && data) {
      var pairs = [];
      Object.keys(data).forEach(function (key) {
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(data[key]));
      });
      xhr.send(pairs.join('&'));
    } else {
      xhr.send();
    }
  }

  function emptyProfile() {
    var profile = { card: [] };
    CATEGORIES.forEach(function (category) { profile[category] = []; });
    return profile;
  }

  function parseBookmarks(response) {
    if (typeof response === 'string') response = JSON.parse(response);
    if (!response || !Array.isArray(response.bookmarks)) {
      throw new Error('CUB вернул неизвестный формат bookmarks/dump.');
    }

    var profile = emptyProfile();
    var cards = {};
    response.bookmarks.slice().sort(function (a, b) {
      return (Number(b && b.time) || 0) - (Number(a && a.time) || 0);
    }).forEach(function (item) {
      if (!item || CATEGORIES.indexOf(String(item.type)) < 0) return;
      var card = null;
      try {
        card = typeof item.data === 'string' ? JSON.parse(item.data) : item.data;
      } catch (e) { card = null; }

      var id = item.card_id !== undefined && item.card_id !== null
        ? item.card_id : (card && card.id !== undefined ? card.id : null);
      if (id === null || id === undefined) return;

      if (card && typeof card === 'object') {
        if (card.id === undefined || card.id === null) card.id = id;
        delete card.params;
        delete card.active;
        if (!cards[String(card.id)]) {
          cards[String(card.id)] = true;
          profile.card.push(card);
        }
      }
      if (profile[item.type].map(String).indexOf(String(id)) < 0) profile[item.type].push(id);
    });

    return profile;
  }

  function parseTimeline(response) {
    if (typeof response === 'string') response = JSON.parse(response);
    if (!response || !response.timelines || typeof response.timelines !== 'object') return {};
    return response.timelines;
  }

  function makeBackup(profile, timeline, Lampa) {
    var account = getAccount(Lampa);
    return {
      app: 'Lampa History Transfer Local',
      formatVersion: '1.0.0',
      pluginVersion: VERSION,
      createdAt: new Date().toISOString(),
      source: {
        profileName: account.profileName,
        profileId: account.profileId
      },
      profile: profile,
      timeline: timeline
    };
  }

  function downloadBackup(backup) {
    var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = 'lampa-history-backup-' + stamp + '.json';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      try { document.body.removeChild(link); } catch (e) {}
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function readBackupFile(callback, fail) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) {
        document.body.removeChild(input);
        return;
      }
      if (file.size > 30 * 1024 * 1024) {
        document.body.removeChild(input);
        fail(new Error('Файл больше 30 МБ. Импорт отменён.'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var backup = JSON.parse(reader.result);
          if (!backup || backup.app !== 'Lampa History Transfer Local' ||
              backup.formatVersion !== '1.0.0' || !backup.profile ||
              !Array.isArray(backup.profile.card) || !backup.timeline ||
              typeof backup.timeline !== 'object') {
            throw new Error('Это не резервная копия History Transfer Local или файл повреждён.');
          }
          callback(backup);
        } catch (e) { fail(e); }
        try { document.body.removeChild(input); } catch (e) {}
      };
      reader.onerror = function () {
        try { document.body.removeChild(input); } catch (e) {}
        fail(new Error('Не удалось прочитать выбранный файл.'));
      };
      reader.readAsText(file);
    };
    input.oncancel = function () {
      try { document.body.removeChild(input); } catch (e) {}
    };
    input.click();
  }

  function uniqueList(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).filter(function (id) {
      if (id === null || id === undefined || id === '') return false;
      var key = String(id);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function importBackup(Lampa, backup, progress, complete, fail) {
    var incoming = backup.profile;
    var cardMap = {};
    (incoming.card || []).forEach(function (card) {
      if (card && card.id !== undefined && card.id !== null) cardMap[String(card.id)] = card;
    });

    request(Lampa, 'bookmarks/dump', 'GET', null, false, function (dump) {
      var current;
      try { current = parseBookmarks(dump); } catch (e) { fail(e); return; }

      var existing = {};
      CATEGORIES.forEach(function (category) {
        existing[category] = {};
        uniqueList(current[category]).forEach(function (id) { existing[category][String(id)] = true; });
      });

      var operations = [];
      CATEGORIES.forEach(function (category) {
        uniqueList(incoming[category]).slice().reverse().forEach(function (id) {
          if (existing[category][String(id)]) return;
          var card = cardMap[String(id)] || { id: id };
          operations.push({ type: category, card_id: id, card: card });
        });
      });

      var index = 0;
      var written = 0;
      var errors = [];
      function writeNext() {
        if (index >= operations.length) {
          writeTimeline();
          return;
        }
        var operation = operations[index++];
        if (progress) progress('Запись закладок и истории: ' + index + ' из ' + operations.length);
        request(Lampa, 'bookmarks/add', 'POST', {
          type: operation.type,
          data: JSON.stringify(operation.card),
          card_id: operation.card_id,
          id: 0
        }, false, function () {
          written++;
          setTimeout(writeNext, 120);
        }, function (error) {
          errors.push(error.message);
          setTimeout(writeNext, 120);
        });
      }

      function writeTimeline() {
        var timelines = backup.timeline || {};
        var keys = Object.keys(timelines);
        if (!keys.length) {
          complete({ written: written, skipped: operations.length - written, timelineCount: 0, errors: errors });
          return;
        }

        // Объединяем прогресс с локально известным прогрессом: импортируемые значения
        // не должны обнулить существующие таймкоды.
        var localKey = 'file_view_' + getAccount(Lampa).profileId;
        var local = {};
        try { local = Lampa.Storage.get(localKey, {}) || {}; } catch (e) {}
        if (typeof local === 'string') {
          try { local = JSON.parse(local); } catch (e) { local = {}; }
        }
        var merged = {};
        Object.keys(local).forEach(function (key) { merged[key] = local[key]; });
        keys.forEach(function (key) {
          var oldItem = merged[key];
          var newItem = timelines[key];
          if (!oldItem || (Number(newItem.updated) || 0) >= (Number(oldItem.updated) || 0) ||
              (Number(newItem.percent) || 0) > (Number(oldItem.percent) || 0)) {
            merged[key] = newItem;
          }
        });

        try {
          Lampa.Storage.set(localKey, merged);
          if (Lampa.Timeline && typeof Lampa.Timeline.read === 'function') Lampa.Timeline.read();
        } catch (e) {}

        if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
          var form = new FormData();
          form.append('file', new Blob([JSON.stringify(merged)], { type: 'application/json' }), 'timelines.json');
          request(Lampa, 'timeline/import', 'POST', form, true, function () {
            complete({ written: written, skipped: operations.length - written, timelineCount: keys.length, errors: errors });
          }, function (error) {
            errors.push('Импорт таймкодов: ' + error.message);
            complete({ written: written, skipped: operations.length - written, timelineCount: 0, errors: errors });
          });
        } else {
          errors.push('На этом устройстве нет поддержки FormData/Blob для импорта таймкодов.');
          complete({ written: written, skipped: operations.length - written, timelineCount: 0, errors: errors });
        }
      }

      writeNext();
    }, fail);
  }

  function notify(Lampa, message) {
    try {
      if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
      else alert(message);
    } catch (e) { alert(message); }
  }

  function showMenu(Lampa) {
    if (!Lampa.Select || !Lampa.Select.show) {
      notify(Lampa, 'Меню Lampa недоступно. Перезапустите приложение.');
      return;
    }

    Lampa.Select.show({
      title: 'HISTORY TRANSFER LOCAL',
      items: [
        { title: 'Экспорт в JSON-файл', subtitle: 'Скачать резервную копию текущего профиля', action: 'export' },
        { title: 'Импорт из JSON-файла', subtitle: 'Безопасно объединить данные с текущим профилем', action: 'import' },
        { title: 'О плагине', subtitle: 'Версия ' + VERSION + ' · Без облачного сервера', action: 'about' },
        { title: 'Назад', action: 'back' }
      ],
      onSelect: function (item) {
        if (item.action === 'export') doExport(Lampa);
        else if (item.action === 'import') doImport(Lampa);
        else if (item.action === 'about') {
          Lampa.Modal.open({
            title: 'History Transfer Local',
            html: '<div style="padding:1em;line-height:1.6">Автономный перенос через JSON-файл.<br>Экспортируйте данные на старом аккаунте, затем выберите этот файл на новом аккаунте.<br><br>Импорт объединяет данные и не очищает существующие записи.</div>',
            size: 'medium'
          });
        }
      },
      onBack: function () { try { Lampa.Controller.toggle('content'); } catch (e) {} }
    });
  }

  function doExport(Lampa) {
    if (BUSY) return;
    BUSY = true;
    notify(Lampa, 'Получение закладок и истории из CUB...');
    request(Lampa, 'bookmarks/dump', 'GET', null, false, function (bookmarks) {
      var profile;
      try { profile = parseBookmarks(bookmarks); } catch (e) {
        BUSY = false; notify(Lampa, e.message); return;
      }
      request(Lampa, 'timeline/dump', 'GET', null, false, function (timelineDump) {
        try {
          var timeline = parseTimeline(timelineDump);
          var backup = makeBackup(profile, timeline, Lampa);
          downloadBackup(backup);
          var categoriesCount = CATEGORIES.reduce(function (sum, key) {
            return sum + profile[key].length;
          }, 0);
          notify(Lampa, 'Экспорт готов: карточек ' + profile.card.length +
            ', записей категорий ' + categoriesCount + ', таймкодов ' + Object.keys(timeline).length + '.');
        } catch (e) { notify(Lampa, 'Ошибка подготовки файла: ' + e.message); }
        BUSY = false;
      }, function (error) {
        // Если CUB не отдал timeline, не делаем неполный backup молча.
        BUSY = false;
        notify(Lampa, 'Не удалось получить прогресс просмотра: ' + error.message);
      });
    }, function (error) {
      BUSY = false;
      notify(Lampa, error.message);
    });
  }

  function doImport(Lampa) {
    if (BUSY) return;
    var account = getAccount(Lampa);
    if (!account.token || !account.profileId) {
      notify(Lampa, 'Сначала войдите в новый аккаунт CUB.');
      return;
    }

    readBackupFile(function (backup) {
      if (!confirm('Импортировать резервную копию в текущий профиль?\n\nРежим: безопасное объединение. Существующие записи не удаляются.')) return;
      BUSY = true;
      notify(Lampa, 'Начинаю безопасный импорт...');
      importBackup(Lampa, backup, function (message) {
        try { notify(Lampa, message); } catch (e) {}
      }, function (result) {
        BUSY = false;
        var message = 'Импорт завершён. Записано: ' + result.written +
          '. Ошибок: ' + result.errors.length +
          '. Таймкодов в копии: ' + result.timelineCount + '.';
        if (result.errors.length) message += ' Некоторые данные могли не перенестись.';
        try {
          if (Lampa.Favorite && typeof Lampa.Favorite.read === 'function') Lampa.Favorite.read();
          if (Lampa.Account && Lampa.Account.Bookmarks && typeof Lampa.Account.Bookmarks.update === 'function') {
            Lampa.Account.Bookmarks.update();
          }
        } catch (e) {}
        notify(Lampa, message);
      }, function (error) {
        BUSY = false;
        notify(Lampa, 'Ошибка импорта: ' + error.message);
      });
    }, function (error) { notify(Lampa, error.message); });
  }

  function init(Lampa) {
    if (!Lampa || root.__lampaHistoryTransferLocalReady) return;
    root.__lampaHistoryTransferLocalReady = true;

    function addButton() {
      try {
        var $ = root.jQuery || root.$;
        if (!$ || !$('.menu .menu__list').length) return;
        if ($('[data-action="history_transfer_local"]').length) return;
        var item = $('<li class="menu__item selector" data-action="history_transfer_local">' +
          '<div class="menu__ico"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></div>' +
          '<div class="menu__text">History Transfer Local</div></li>');
        item.on('hover:enter', function () { showMenu(Lampa); });
        $('.menu .menu__list').eq(0).append(item);
      } catch (e) { logError(e); }
    }

    if (root.appready) addButton();
    else if (Lampa.Listener && Lampa.Listener.follow) {
      Lampa.Listener.follow('app', function (event) {
        if (event.type === 'ready') addButton();
      });
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { version: VERSION, parseBookmarks: parseBookmarks, parseTimeline: parseTimeline };
  } else if (root.Lampa) {
    init(root.Lampa);
  } else if (root.document) {
    root.document.addEventListener('DOMContentLoaded', function () {
      if (root.Lampa) init(root.Lampa);
    });
  }
})(typeof window !== 'undefined' ? window : this);
