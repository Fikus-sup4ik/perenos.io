/**
 * Пример конфигурации Lampa History Transfer.
 * Скопируйте нужные значения в настройки плагина в Lampa или в wrangler.toml.
 */
module.exports = {
  // URL развёрнутого Cloudflare Worker (обязательно HTTPS в продакшене)
  serverUrl: 'https://lampa-history-transfer.your-subdomain.workers.dev',

  // Таймаут сетевых запросов (мс)
  requestTimeoutMs: 15000,

  // Максимальный размер резервной копии (10 МБ)
  maxBackupBytes: 10 * 1024 * 1024,

  // Задержка между запросами к CUB API при восстановлении (мс),
  // чтобы не превысить лимиты сервера CUB
  cubWriteDelayMs: 120,

  // Версия формата резервной копии
  backupFormatVersion: '2.0.0'
};
