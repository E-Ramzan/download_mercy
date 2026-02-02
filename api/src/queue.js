import { Queue } from "bullmq";

// Настраиваем подключение к Redis
export function makeQueue({ host, port }) {
  // "downloads" - имя очереди, воркер будет слушать именно её
  return new Queue("downloads", {
    connection: { host, port },
    defaultJobOptions: {
      // Чтобы Redis не распухал, храним только последние 100 записей
      // о том, что скачалось успешно или упало.
      removeOnComplete: 100,
      removeOnFail: 100,

      // Если сеть моргнула или YouTube отверг запрос - пробуем еще 3 раза
      attempts: 3,
      backoff: {
        type: "exponential", // задержка растет: 1с - 2с - 4с...
        delay: 1000,
      },
    },
  });
}
