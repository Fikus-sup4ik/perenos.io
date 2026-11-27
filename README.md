# Lampa History Transfer

Универсальный плагин Lampa и облачный бэкенд (Cloudflare Workers + D1) для безопасного переноса истории просмотров, закладок, полных карточек и прогресса серий между двумя разными аккаунтами Lampa/CUB.

## Архитектура

```
Старый аккаунт CUB ──(GET bookmarks/dump + GET timeline/dump)──▶ Плагин history-transfer.js
                                                                        │
                                                         (POST /api/backups, HTTPS + Bearer)
                                                                        ▼
                                                         Cloudflare Worker + D1 (изоляция)
                                                                        │
                                                         (GET /api/backups/:id)
                                                                        ▼
Новый аккаунт CUB ◀──(POST bookmarks/add + POST timeline/import)── Плагин history-transfer.js
```

## Реальная структура данных Lampa/CUB

На основе анализа официального исходного кода Lampa (`yumata/lampa-source`):

1. **Профиль (`Lampa.Favorite`, `src/core/favorite.js`)**:
   - Содержит 10 массивов: `card`, `like`, `wath` (оригинальное написание сохранено), `book`, `history`, `look` (дополнительная категория в ядре Lampa), `viewed`, `scheduled`, `continued`, `thrown`.
   - `history` (история открытия карточек) и `viewed` (статус «Просмотрено») хранятся раздельно.
   - При активной синхронизации CUB данные читаются через `GET /api/bookmarks/dump` и записываются через `POST /api/bookmarks/add` и `POST /api/bookmarks/clear`.
2. **Прогресс фильмов и серий (`Lampa.Timeline`, `src/interaction/timeline.js`, `src/core/account/timeline.js`)**:
   - Хранится отдельно от `favorite` в словаре `{ [hash]: { duration, time, percent, profile, updated, card, season, episode } }` (`file_view_<profile_id>`).
   - Синхронизируется через `GET /api/timeline/dump` и `POST /api/timeline/import` (`multipart/form-data` с `timelines.json`) / `POST /api/timeline/update`.

## Установка и развёртывание сервера (Cloudflare Workers + D1)

1. Создайте базу данных D1:
   ```bash
   cd server
   npx wrangler d1 create lampa-history-transfer
   ```
2. Укажите полученный `database_id` в `server/wrangler.toml`.
3. Инициализируйте схему БД:
   ```bash
   npm run db:init:remote
   ```
4. Задайте секрет для дополнительного хеширования токенов:
   ```bash
   npx wrangler secret put TOKEN_PEPPER
   ```
5. Разверните Worker:
   ```bash
   npm run deploy
   ```

## Установка плагина в Lampa

1. Разместите `plugin/history-transfer.js` на HTTPS-хостинге (например, GitHub Pages или Cloudflare Pages).
2. В Lampa перейдите в **Настройки → Расширения → Добавить плагин** и вставьте URL файла `history-transfer.js`.
3. Откройте **History Transfer** в боковом меню, укажите URL вашего Cloudflare Worker в разделе **⚙️ Настройки**, зарегистрируйте аккаунт History Transfer и сохраните историю.
4. На новом аккаунте Lampa установите тот же плагин, войдите в свой аккаунт History Transfer и нажмите **📥 Восстановить историю**.

## Запуск тестов

```bash
node --test tests/*.test.js
```
