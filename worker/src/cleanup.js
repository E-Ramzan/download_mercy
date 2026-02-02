import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.resolve(process.cwd(), "downloaded");

// Удаляем ТОЛЬКО файлы с этим префиксом. Чужое не трогаем.
const FILE_PREFIX = "dmercy_";

// Переводим часы из .env в миллисекунды.
const TTL_HOURS = Number(process.env.FILE_TTL_HOURS || 12);
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

const CHECK_INTERVAL_MIN = Number(process.env.CLEANUP_INTERVAL_MIN || 30);
const CHECK_INTERVAL = CHECK_INTERVAL_MIN * 60 * 1000;

async function cleanup() {
  try {
    await fs.access(DOWNLOAD_DIR);
  } catch {
    console.log(`[Cleanup] Папки ${DOWNLOAD_DIR} нет. Отдыхаем.`);
    return;
  }

  let deletedCount = 0;
  let errorsCount = 0;
  const now = Date.now();

  try {
    const files = await fs.readdir(DOWNLOAD_DIR);

    for (const file of files) {
      if (file.startsWith(".")) continue; // Скрытые файлы пропускаем.

      // ГЛАВНАЯ ПРОВЕРКА: Если файл не наш (нет префикса), мы его НЕ трогаем.
      if (!file.startsWith(FILE_PREFIX)) continue;

      const filePath = path.join(DOWNLOAD_DIR, file);

      try {
        const stats = await fs.stat(filePath);

        // Если файл старый - удаляем.
        if (stats.isFile() && now - stats.mtimeMs > TTL_MS) {
          await fs.unlink(filePath);
          console.log(`[Cleanup] Удалил старье: ${file}`);
          deletedCount++;
        }
      } catch (err) {
        console.error(`[Cleanup] Не смог удалить ${file}:`, err.message);
        errorsCount++;
      }
    }
  } catch (err) {
    console.error("[Cleanup] Ошибка при сканировании папки:", err);
  }

  if (deletedCount > 0 || errorsCount > 0) {
    console.log(
      `[Cleanup] Итог: удалено ${deletedCount}, ошибок ${errorsCount}`,
    );
  }
}

export function startCleanupService() {
  console.log(
    "[Cleanup] Запущен. Буду удалять старые файлы с префиксом 'dmercy_'",
  );

  // Проверяем сразу при старте.
  cleanup();
  // И потом по таймеру.
  setInterval(cleanup, CHECK_INTERVAL);
}
