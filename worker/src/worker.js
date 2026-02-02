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

const FILE_PREFIX = "dmercy_";

const CONCURRENCY = Number(process.env.CONCURRENCY || 2);

const BINARIES = {
  ytdlp: process.env.YTDLP_BIN || "yt-dlp",
  node: process.env.JS_RUNTIMES || "node",
};

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

startCleanupService();

function spawnProcess(cmd, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdoutBuffer = "";
    let stderrLog = "";

    const processOutput = (chunk) => {
      if (onProgress) {
        stdoutBuffer += chunk.toString();
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
            `Процесс ${cmd} прервался с кодом ${code}.\nStderr: ${stderrLog}`,
          ),
        );
    });
  });
}

function parseProgress(line) {
  const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (match) {
    return { pct: Number(match[1]), phase: "download" };
  }
  return null;
}

function findOutputFile(fileId) {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    return (
      files.find(
        (f) =>
          f.startsWith(`${fileId}.`) &&
          !f.endsWith(".part") &&
          !f.endsWith(".ytdl") &&
          !f.endsWith(".f137"),
      ) || null
    );
  } catch (e) {
    return null;
  }
}

const worker = new Worker(
  "downloads",
  async (job) => {
    const { url, kind = "video", quality = "best" } = job.data;
    if (!url) throw new Error("URL отсутствует");

    const rawId = crypto.randomBytes(8).toString("hex");
    const fileId = `${FILE_PREFIX}${rawId}`;

    const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

    const args = [
      url,
      "--no-playlist",
      "--js-runtimes",
      BINARIES.node,
      "--newline",
      "-o",
      outputTemplate,
      "--no-mtime",
    ];

    if (kind === "audio" || kind === "mp3") {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    } else if (kind === "thumb") {
      args.push(
        "--skip-download",
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
      );
    } else {
      if (quality !== "best" && !isNaN(quality)) {
        args.push(
          "-f",
          `bv*[height<=${quality}]+ba[ext=m4a]/b[height<=${quality}] / bv*+ba/b`,
        );
      } else {
        args.push("-f", "bv*+ba[ext=m4a]/b[ext=mp4] / bv*+ba/b");
      }
      args.push("--merge-output-format", "mp4");
    }

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
    if (!filename) throw new Error("Файл не найден после загрузки.");

    return { file: filename };
  },
  {
    connection: REDIS_CONFIG,
    concurrency: CONCURRENCY,
    lockDuration: 60000,
  },
);

worker.on("ready", () => console.log(`[Worker] Готов. Папка: ${DOWNLOAD_DIR}`));
worker.on("completed", (job, result) =>
  console.log(`[Job ${job.id}] Успех: ${result.file}`),
);
worker.on("failed", (job, err) =>
  console.error(`[Job ${job.id}] Ошибка: ${err.message}`),
);
