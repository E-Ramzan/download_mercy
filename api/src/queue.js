import { Queue } from "bullmq";

export function makeQueue({ host, port }) {
  return new Queue("downloads", {
    connection: { host, port },
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 100,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
    },
  });
}
