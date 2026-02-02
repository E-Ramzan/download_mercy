import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Worker } from "bullmq";
import { spawn } from "node:child_process";

import { startCleanupService } from "./cleanup.js";

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
};

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.resolve(process.cwd(), "downloaded");

// ВАЖНО: Все наши файлы будут начинаться с этого префикса.
// Это нужно, чтобы клинер случайно не удалил пользовательские файлы,
// если вдруг папку Downloads настроят неправильно.
const FILE_PREFIX = "dmercy_";

const CONCURRENCY = Number(process.env.CONCURRENCY || 2);

const BINARIES = {
  ytdlp: process.env.YTDLP_BIN || "yt-dlp",
  node: process.env.JS_RUNTIMES || "node",
};

// Создаем папку, если её нет.
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Запускаем фоновый сервис очистки (см. cleanup.js).
startCleanupService();

// Обертка для запуска внешних команд (в нашем случае yt-dlp).
function spawnProcess(cmd, args, onProgress) {
  return new Promise((resolve, reject) => {
    // stdio: 'pipe' нужен, чтобы читать вывод программы.
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdoutBuffer = "";
    let stderrLog = "";

    const processOutput = (chunk) => {
      if (onProgress) {
        stdoutBuffer += chunk.toString();
        // Разбиваем вывод на строки, чтобы выловить проценты закачки (ну то сколько уже скачалось видео).
        const lines = stdoutBuffer.split(/\r\n|\n|\r/);
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const progressData = parseProgress(line);
          if (progressData) onProgress(progressData);
        }
      }
    };

    child.stdout.on("data", processOutput);
    child.stderr.on("data", (d) => {
      stderrLog += d.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Process ${cmd} exited with code ${code}.\nStderr: ${stderrLog}`,
          ),
        );
    });
  });
}

// Парсим вывод yt-dlp, чтобы найти "[download] 45.5%".
function parseProgress(line) {
  const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (match) {
    return { pct: Number(match[1]), phase: "download" };
  }
  return null;
}

// Ищем созданный файл. Ищем по ID, так как расширение может быть разным (mp4, mkv, webm).
function findOutputFile(fileId) {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    return (
      files.find(
        (f) =>
          f.startsWith(`${fileId}.`) && // ID уже содержит наш префикс.
          !f.endsWith(".part") && // Игнорируем недокачанные куски.
          !f.endsWith(".ytdl") &&
          !f.endsWith(".f137"),
      ) || null
    );
  } catch (e) {
    return null;
  }
}

// Воркер. Берет задачи из Redis и качает видео.
const worker = new Worker(
  "downloads",
  async (job) => {
    const { url, kind = "video", quality = "best" } = job.data;
    if (!url) throw new Error("Нет URL");

    // Генерируем случайный ID и добавляем наш защитный префикс.
    const rawId = crypto.randomBytes(8).toString("hex");
    const fileId = `${FILE_PREFIX}${rawId}`;

    const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

    const args = [
      url,
      "--no-playlist", // Качаем только одно видео.
      "--js-runtimes",
      BINARIES.node, // Помогает обходить защиту YouTube.
      "--newline", // Вывод построчно для удобного парсинга.
      "-o",
      outputTemplate,
      "--no-mtime", // Не сохранять оригинальную дату файла (мешает клинеру).
    ];

    if (kind === "audio" || kind === "mp3") {
      // Только звук в mp3.
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    } else if (kind === "thumb") {
      // Только картинка.
      args.push(
        "--skip-download",
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
      );
    } else {
      // ВИДЕО
      // Выбор форматов для скорости:
      if (quality !== "best" && !isNaN(quality)) {
        // Если указали качество, ищем видео, этому качеству + звук m4a (чтобы не перекодировать)
        args.push(
          "-f",
          `bv*[height<=${quality}]+ba[ext=m4a]/b[height<=${quality}] / bv*+ba/b`,
        );
      } else {
        // Лучшее качество. Приоритет mp4 контейнеру.
        args.push("-f", "bv*+ba[ext=m4a]/b[ext=mp4] / bv*+ba/b");
      }
      // Принудительно упаковываем в mp4, это быстро.
      args.push("--merge-output-format", "mp4");
    }

    // Обновляем прогресс в Redis, но не слишком часто, чтобы не спамить и не перенагружать систему.
    let lastUpdate = 0;
    const updateJobProgress = async (data) => {
      const now = Date.now();
      if (now - lastUpdate > 500 || data.pct === 100) {
        lastUpdate = now;
        await job.updateProgress(data);
      }
    };

    console.log(`[Start] ${kind} ${url}`);

    await spawnProcess(BINARIES.ytdlp, args, updateJobProgress);

    const filename = findOutputFile(fileId);
    if (!filename)
      throw new Error("Скачивание завершено, но файла нет. Странно.");

    return { file: filename };
  },
  {
    connection: REDIS_CONFIG,
    concurrency: CONCURRENCY,
    lockDuration: 60000, // Если задача висит минуту без ответа — считаем зависшей.
  },
);

worker.on("ready", () =>
  console.log(`[Worker] Готов к труду. Папка: ${DOWNLOAD_DIR}`),
);
worker.on("completed", (job, result) =>
  console.log(`[Job ${job.id}] Готово: ${result.file}`),
);
worker.on("failed", (job, err) =>
  console.error(`[Job ${job.id}] Ошибка: ${err.message}`),
);
