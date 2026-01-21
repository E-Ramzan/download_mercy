import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.resolve(process.cwd(), "downloaded");

const TTL_HOURS = Number(process.env.FILE_TTL_HOURS || 12);
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

const CHECK_INTERVAL_MIN = Number(process.env.CLEANUP_INTERVAL_MIN || 30);
const CHECK_INTERVAL = CHECK_INTERVAL_MIN * 60 * 1000;

async function cleanup() {
  try {
    await fs.access(DOWNLOAD_DIR);
  } catch {
    console.log(
      `[Cleanup] Папка ${DOWNLOAD_DIR} не найдена. Пропускаем проверку.`
    );
    return;
  }

  let deletedCount = 0;
  let errorsCount = 0;
  const now = Date.now();

  try {
    const files = await fs.readdir(DOWNLOAD_DIR);

    for (const file of files) {
      if (file.startsWith(".")) continue;

      const filePath = path.join(DOWNLOAD_DIR, file);

      try {
        const stats = await fs.stat(filePath);

        if (stats.isFile() && now - stats.mtimeMs > TTL_MS) {
          await fs.unlink(filePath);
          console.log(`[Cleanup] Удалён старый файл: ${file}`);
          deletedCount++;
        }
      } catch (err) {
        console.error(`[Cleanup] Не удалось удалить ${file}:`, err.message);
        errorsCount++;
      }
    }
  } catch (err) {
    console.error("[Cleanup] Критическая ошибка сканирования:", err);
  }

  if (deletedCount > 0 || errorsCount > 0) {
    console.log(
      `[Cleanup] Готово. Удалено: ${deletedCount}, Ошибок: ${errorsCount}`
    );
  }
}

export function startCleanupService() {
  console.log("[Cleanup] Сервис очистки запущен.");

  cleanup();

  setInterval(cleanup, CHECK_INTERVAL);
}
