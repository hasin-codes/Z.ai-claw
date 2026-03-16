const { getStaleIssues, markReminded } = require('./issues');
const { pingRoleInThread } = require('./forward');
const { addNotifyJob, log: queueLog } = require('./queue');
const pino = require('pino');

const log = pino({ level: 'info' }, pino.destination(1));

async function runReminderJob(client) {
  log.info('[reminders] Checking for stale issues...');

  const staleIssues = await getStaleIssues();

  if (staleIssues.length === 0) {
    log.info('[reminders] No stale issues found');
    return;
  }

  log.info(`[reminders] Found ${staleIssues.length} stale issue(s)`);

  for (const issue of staleIssues) {
    if (!issue.thread_id) {
      log.warn({ shortId: issue.short_id }, '[reminders] No thread_id — skipping');
      continue;
    }

    let thread;
    try {
      thread = await client.channels.fetch(issue.thread_id);
    } catch (err) {
      log.error({ shortId: issue.short_id, err: err.message }, '[reminders] Could not fetch thread');
      continue;
    }

    if (!thread) continue;

    try {
      await thread.send({
        content: [
          `**Reminder — ${issue.short_id} has had no update in 48 hours.**`,
          ``,
          `This issue is still **${issue.status}** and the user is waiting.`,
          `Use \`/acknowledge ${issue.short_id}\` or \`/resolve ${issue.short_id}\` to update it.`
        ].join('\n')
      });
    } catch (err) {
      log.error({ shortId: issue.short_id, err: err.message }, '[reminders] Failed to post reminder');
      continue;
    }

    await pingRoleInThread(client, thread, issue, 'new_issue');
    await markReminded(issue.id);

    log.info({ shortId: issue.short_id, count: (issue.reminder_count || 0) + 1 }, '[reminders] Reminded');

    await new Promise(r => setTimeout(r, 1000));
  }

  log.info('[reminders] Job complete');
}

module.exports = { runReminderJob };