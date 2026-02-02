import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { makeQueue } from "./queue.js";

// Получаем текущую директорию
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Настраиваем пути.
// Сначала смотрим в ENV (это для Докера), если там пусто - берем локальные папки (для разработки).
const PUBLIC_DIR =
  process.env.PUBLIC_DIR || path.resolve(__dirname, "../../public");
const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || path.join(process.cwd(), "downloaded");

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
};

// Запускаем Fastify с логами, чтобы видеть, кто и что запрашивает.
const fastify = Fastify({
  logger: true,
  disableRequestLogging: false,
});

const queue = makeQueue(REDIS_CONFIG);

// Защита от спама: не больше 600 запросов в минуту с одного IP.
await fastify.register(rateLimit, {
  max: 600,
  timeWindow: "1 minute",
});

// Если папки с фронтендом нет, сервер бесполезен. Лучше сразу упасть с ошибкой, чем тупить.
if (!fs.existsSync(PUBLIC_DIR)) {
  console.error(`[Fatal] Не нашел папку PUBLIC_DIR: ${PUBLIC_DIR}`);
  process.exit(1);
}

// Раздаем статику (HTML, CSS, JS).
await fastify.register(staticPlugin, {
  root: PUBLIC_DIR,
  prefix: "/",
});

// Ручка для создания задачи. Принимает URL и настройки.
fastify.post(
  "/api/jobs",
  {
    schema: {
      body: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", minLength: 1 },
          kind: {
            // Валидируем тип, чтобы не прислали ерунду.
            type: "string",
            enum: ["video", "audio", "mp3", "thumb"],
            default: "video",
          },
          quality: { type: "string", default: "best" },
        },
      },
    },
  },
  async (req, reply) => {
    const { url, kind, quality } = req.body;
    // Кидаем задачу в Redis и сразу возвращаем ID. Скачивание будет идти в фоне.
    const job = await queue.add("download", { url, kind, quality });
    return { jobId: job.id };
  },
);

// Ручка для проверки статуса (поллинг). Фронт дергает её, пока не получит status: completed.
fastify.get("/api/jobs/:id", async (req, reply) => {
  const job = await queue.getJob(req.params.id);

  if (!job) {
    return reply.code(404).send({ status: "not_found" });
  }

  const state = await job.getState(); // waiting, active, completed, failed
  const result = job.returnvalue || {};

  // Если упало, пытаемся достать текст ошибки.
  const error =
    job.failedReason || (state === "failed" ? "Unknown error" : null);

  return {
    id: job.id,
    status: state,
    url: job.data.url,
    file: result.file || null, // Имя файла будет только когда всё готово.
    progress: job.progress,
    error: error,
  };
});

// Скачивание готового файла.
fastify.get("/api/download/:filename", async (req, reply) => {
  const { filename } = req.params;

  // path.basename - защита от хакеров. Убирает слэши, чтобы нельзя было скачать иные файлы сервера.
  const safeName = path.basename(filename);
  const filePath = path.join(DOWNLOAD_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    return reply
      .code(404)
      .send({ error: "Файл не найден (возможно, удален уборщиком)" });
  }

  // Говорим браузеру "это файл, скачай его".
  reply.header("Content-Disposition", `attachment; filename="${safeName}"`);
  return reply.send(fs.createReadStream(filePath));
});

// Старт сервера.
try {
  const port = Number(process.env.APP_PORT || 3000);
  // 0.0.0.0 обязательно для Докера, иначе снаружи не достучаться.
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`Сервер запущен на порту ${port}`);
  console.log(`Фронтенд берем из: ${PUBLIC_DIR}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
