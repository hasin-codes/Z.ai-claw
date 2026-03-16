const { Worker } = require('bullmq');
const { connection, log } = require('./queue');
const { forwardToTeam, pingRoleInThread } = require('./forward');
const { notifyUser } = require('./notify');
const { getIssueByShortId } = require('./issues');

let forwardWorker;
let notifyWorker;

function startWorkers(client) {
  log.info('Starting BullMQ workers...');

  // ─── Forward worker ─────────────────────────────────────────────────
  // Handles posting issue embeds to department channels
  forwardWorker = new Worker('issue-forwarding', async job => {
    const { issueId, userId } = job.data;
    log.info({ issueId, jobId: job.id }, 'Processing forward job');

    const issue = await getIssueByShortId(issueId);
    if (!issue) {
      log.warn({ issueId }, 'Forward job: issue not found in DB');
      return;
    }

    // Fetch the Discord user object
    let user;
    try {
      user = await client.users.fetch(userId);
    } catch (err) {
      log.error({ userId, err: err.message }, 'Forward job: could not fetch user');
      throw err; // rethrow so BullMQ retries
    }

    await forwardToTeam(client, issue, user);
    log.info({ issueId: issue.short_id }, 'Forward job complete');

  }, {
    connection,
    concurrency: 5  // process up to 5 forward jobs simultaneously
  });

  // ─── Notify worker ──────────────────────────────────────────────────
  // Handles DMs and thread status update messages
  notifyWorker = new Worker('user-notification', async job => {
    const { issueId, newStatus, note } = job.data;
    log.info({ issueId, newStatus, jobId: job.id }, 'Processing notify job');

    const issue = await getIssueByShortId(issueId);
    if (!issue) {
      log.warn({ issueId }, 'Notify job: issue not found in DB');
      return;
    }

    await notifyUser(client, issue, newStatus, note);
    log.info({ issueId: issue.short_id, newStatus }, 'Notify job complete');

  }, {
    connection,
    concurrency: 10  // notifications can run more in parallel
  });

  // ─── Dead letter handling ───────────────────────────────────────────
  // When a job fails all retries, log it loudly so you know about it
  forwardWorker.on('failed', (job, err) => {
    log.error({
      jobId:    job?.id,
      issueId:  job?.data?.issueId,
      attempts: job?.attemptsMade,
      err:      err.message
    }, 'Forward job FAILED all retries — manual intervention needed');
  });

  notifyWorker.on('failed', (job, err) => {
    log.error({
      jobId:    job?.id,
      issueId:  job?.data?.issueId,
      attempts: job?.attemptsMade,
      err:      err.message
    }, 'Notify job FAILED all retries — manual intervention needed');
  });

  forwardWorker.on('error', err => {
    log.error({ err: err.message }, 'Forward worker error');
  });

  notifyWorker.on('error', err => {
    log.error({ err: err.message }, 'Notify worker error');
  });

  log.info('Workers started successfully');
}

async function stopWorkers() {
  log.info('Stopping workers...');
  if (forwardWorker) await forwardWorker.close();
  if (notifyWorker)  await notifyWorker.close();
  log.info('Workers stopped');
}

module.exports = { startWorkers, stopWorkers };