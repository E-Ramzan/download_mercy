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

const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || path.resolve(process.cwd(), "downloaded");
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);

const BINARIES = {
  ytdlp: process.env.YTDLP_BIN || "yt-dlp",
  ffmpeg: process.env.FFMPEG_BIN || "ffmpeg",
  node: process.env.JS_RUNTIMES || "node",
};

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

startCleanupService();

function spawnProcess(cmd, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    let stdoutBuffer = "";

    const processOutput = (chunk) => {
      const text = chunk.toString();
      if (!onProgress) return;

      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r\n|\n|\r/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const progressData = parseProgress(line);
        if (progressData) onProgress(progressData);
      }
    };

    child.stdout.on("data", processOutput);
    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      processOutput(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`Process ${cmd} exited with code ${code}. Error: ${stderr}`)
        );
    });
  });
}

function parseProgress(line) {
  // [download] 45.5% of 10.00MiB at 2.5MiB/s ETA 00:05
  const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (match) {
    return { pct: Number(match[1]), phase: "download" };
  }
  if (line.includes("[ExtractAudio]")) return { pct: 99, phase: "convert" };
  if (line.includes("[Merger]")) return { pct: 99, phase: "merge" };
  return null;
}

function findOutputFile(fileId) {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const found = files.find(
      (f) =>
        f.startsWith(`${fileId}.`) &&
        !f.endsWith(".part") &&
        !f.endsWith(".ytdl")
    );
    return found ? found : null;
  } catch (e) {
    return null;
  }
}

async function convertToAacIfNeeded(filename) {
  const inputPath = path.join(DOWNLOAD_DIR, filename);
  const tempName = `aac_${filename}`;
  const outputPath = path.join(DOWNLOAD_DIR, tempName);

  const args = [
    "-y",
    "-i",
    inputPath,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  await spawnProcess(BINARIES.ffmpeg, args);

  fs.unlinkSync(inputPath);
  fs.renameSync(outputPath, inputPath);

  return filename;
}

const worker = new Worker(
  "downloads",
  async (job) => {
    const { url, kind = "video", quality = "best" } = job.data;

    if (!url) throw new Error("URL остуствует");

    const fileId = crypto.randomBytes(8).toString("hex");
    const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

    const args = [
      url,
      "--no-playlist",
      "--js-runtimes",
      BINARIES.node,
      "--newline",
      "-o",
      outputTemplate,
    ];

    if (kind === "audio" || kind === "mp3") {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    } else if (kind === "thumb") {
      args.push(
        "--skip-download",
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg"
      );
    } else {
      if (quality !== "best" && !isNaN(quality)) {
        args.push("-f", `bv*[height<=${quality}]+ba/b[height<=${quality}]/b`);
      } else {
        args.push("-f", "bv*+ba/b");
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

    await spawnProcess(BINARIES.ytdlp, args, updateJobProgress);

    let filename = findOutputFile(fileId);
    if (!filename) {
      throw new Error("Закачка окончена, но файл не найден.");
    }

    if (kind === "video" && filename.endsWith(".mp4")) {
      await job.updateProgress({ pct: 100, phase: "processing" });
      try {
        await convertToAacIfNeeded(filename);
      } catch (err) {
        console.error(`[FFmpeg] `, err);
      }
    }

    return { file: filename };
  },
  {
    connection: REDIS_CONFIG,
    concurrency: CONCURRENCY,
    lockDuration: 30000,
  }
);

worker.on("ready", () => {
  console.log(`[Worker] Запущен. Чекаем 'downloads'`);
  console.log(`[Config] Сохраняем в папку: ${DOWNLOAD_DIR}`);
});

worker.on("completed", (job, result) => {
  console.log(`[Job ${job.id}] Завершен. Файл: ${result.file}`);
});

worker.on("failed", (job, err) => {
  console.error(`[Job ${job.id}] Провал: ${err.message}`);
});
