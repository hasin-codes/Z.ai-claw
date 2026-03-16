const { Queue, Worker, QueueEvents } = require('bullmq');
const pino = require('pino');

const log = pino({ level: 'info' }, pino.destination(1));

// Redis connection config — reads from env
const connection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379'
};

// ─── Queues ───────────────────────────────────────────────────────────
// One queue per job type keeps things clean and debuggable
const issueQueue    = new Queue('issue-processing', { connection });
const forwardQueue  = new Queue('issue-forwarding', { connection });
const notifyQueue   = new Queue('user-notification', { connection });
const reminderQueue = new Queue('reminders',         { connection });

// ─── Add jobs ─────────────────────────────────────────────────────────
async function addIssueJob(data) {
  await issueQueue.add('process-issue', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
  log.info({ jobType: 'process-issue', userId: data.userId }, 'Issue job queued');
}

async function addForwardJob(data) {
  await forwardQueue.add('forward-issue', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
  log.info({ jobType: 'forward-issue', shortId: data.shortId }, 'Forward job queued');
}

async function addNotifyJob(data) {
  await notifyQueue.add('notify-user', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  });
  log.info({ jobType: 'notify-user', shortId: data.shortId }, 'Notify job queued');
}

async function addReminderJob(data) {
  await reminderQueue.add('send-reminder', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 }
  });
}

module.exports = {
  issueQueue,
  forwardQueue,
  notifyQueue,
  reminderQueue,
  addIssueJob,
  addForwardJob,
  addNotifyJob,
  addReminderJob,
  connection,
  log
};