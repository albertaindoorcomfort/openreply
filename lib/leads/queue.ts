import { Queue, Worker } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { runCarla } from "./carla";

export const CARLA_QUEUE = "lead-assist";

interface CarlaJob {
  workspaceId: string;
  conversationId: string;
  messageId: string;
}

let queue: Queue<CarlaJob> | null = null;
function getQueue() {
  queue ??= new Queue<CarlaJob>(CARLA_QUEUE, { connection: getRedisConnection() });
  return queue;
}

/** One job per inbound message. A burst collapses: only the newest message's job does work. */
export async function enqueueCarla(job: CarlaJob) {
  await getQueue().add("assess", job, {
    jobId: `carla_${job.conversationId}_${job.messageId}`,
    delay: Number(process.env.CARLA_DEBOUNCE_MS ?? 3000),
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

export async function processCarlaJob(job: CarlaJob) {
  const newest = await prisma.message.findFirst({
    where: { conversationId: job.conversationId, direction: "INBOUND" },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  if (newest?.id !== job.messageId) return { skipped: "newer message queued" };
  const conversation = await prisma.conversation.findUnique({ where: { id: job.conversationId }, select: { mode: true } });
  if (!conversation || conversation.mode === "MANUAL_ONLY") return { skipped: "manual only" };
  return runCarla(job.workspaceId, job.conversationId);
}

export function createCarlaWorker() {
  const worker = new Worker<CarlaJob>(CARLA_QUEUE, async (job) => processCarlaJob(job.data), {
    connection: getRedisConnection(),
    concurrency: 3,
  });
  worker.on("failed", (job, err) => console.error(`[Carla] job ${job?.id} failed:`, err.message));
  return worker;
}
