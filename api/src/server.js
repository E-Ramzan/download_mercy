import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { makeQueue } from "./queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUBLIC_DIR =
  process.env.PUBLIC_DIR || path.resolve(__dirname, "../../public");
const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || path.join(process.cwd(), "downloaded");

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
};

const fastify = Fastify({
  logger: true,
  disableRequestLogging: false,
});

const queue = makeQueue(REDIS_CONFIG);

await fastify.register(rateLimit, {
  max: 600,
  timeWindow: "1 minute",
});

if (!fs.existsSync(PUBLIC_DIR)) {
  console.error(`[Fatal] Папка PUBLIC_DIR не найдена по пути: ${PUBLIC_DIR}`);
  process.exit(1);
}

await fastify.register(staticPlugin, {
  root: PUBLIC_DIR,
  prefix: "/",
});

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
    const job = await queue.add("download", { url, kind, quality });
    return { jobId: job.id };
  },
);

fastify.get("/api/jobs/:id", async (req, reply) => {
  const job = await queue.getJob(req.params.id);

  if (!job) {
    return reply.code(404).send({ status: "not_found" });
  }

  const state = await job.getState();
  const result = job.returnvalue || {};
  const error =
    job.failedReason || (state === "failed" ? "Unknown error" : null);

  return {
    id: job.id,
    status: state,
    url: job.data.url,
    file: result.file || null,
    progress: job.progress,
    error: error,
  };
});

fastify.get("/api/download/:filename", async (req, reply) => {
  const { filename } = req.params;
  const safeName = path.basename(filename);
  const filePath = path.join(DOWNLOAD_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    return reply.code(404).send({ error: "Файл не найден" });
  }

  reply.header("Content-Disposition", `attachment; filename="${safeName}"`);
  return reply.send(fs.createReadStream(filePath));
});

try {
  const port = Number(process.env.APP_PORT || 3000);
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`Сервер запущен: http://0.0.0.0:${port}`);
  console.log(`Frontend раздается из: ${PUBLIC_DIR}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
