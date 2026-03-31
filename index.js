require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  ChannelType,
  MessageFlags
} = require('discord.js');
const fs = require('fs');
const pino = require('pino');

const log = pino({ level: 'info' }, pino.destination(1));

const {
  createIssue,
  attachThread,
  saveMessage,
  isAtIssueLimit,
  findSimilarOpenIssue,
  getAllThreadIssues
} = require('./lib/issues');

const { forwardToTeam, pingRoleInThread } = require('./lib/forward');
const { createReportThread } = require('./lib/forum');
const { runReminderJob } = require('./lib/reminders');
const { startWorkers, stopWorkers } = require('./lib/workers');
const { addForwardJob } = require('./lib/queue');
const { initCollections, ensureCollection } = require('./lib/qdrant');
const { runAgent } = require('./lib/agent');

// ── Auto-reply timer: accumulate user messages, answer after 45s of silence ──
const AUTO_REPLY_DELAY_MS = 45_000;
// threadId → { timer, accumulatedMessages: string[], issue, discordClient, member }
const _pendingAutoReplies = new Map();

function scheduleAutoReply(threadId, discordClient, issue, userMessage, member) {
  // Clear any existing timer for this thread
  if (_pendingAutoReplies.has(threadId)) {
    clearTimeout(_pendingAutoReplies.get(threadId).timer);
  }

  const entry = {
    timer: null,
    accumulatedMessages: [userMessage],
    issue,
    discordClient,
    member
  };

  entry.timer = setTimeout(async () => {
    _pendingAutoReplies.delete(threadId);
    try {
      const liveThread = await discordClient.channels.fetch(threadId);
      if (!liveThread) return;
      await liveThread.sendTyping();
      const combined = entry.accumulatedMessages.join('\n\n');
      await runAgent(discordClient, liveThread, issue, combined, member);
      console.log(`[autoReply] Sent RAG reply in thread ${threadId} for ${issue.short_id} (${entry.accumulatedMessages.length} messages accumulated)`);
    } catch (err) {
      console.error(`[autoReply] Failed in thread ${threadId}:`, err.message);
    }
  }, AUTO_REPLY_DELAY_MS);

  _pendingAutoReplies.set(threadId, entry);
}

/**
 * Append a follow-up message to the pending auto-reply and reset the 45s timer.
 * Returns true if a pending auto-reply existed (caller should NOT run agent).
 * Returns false if no pending auto-reply (caller should run agent normally).
 */
function accumulateAutoReply(threadId, newMessage) {
  if (!_pendingAutoReplies.has(threadId)) return false;
  const entry = _pendingAutoReplies.get(threadId);
  clearTimeout(entry.timer);
  entry.accumulatedMessages.push(newMessage);
  entry.timer = setTimeout(async () => {
    _pendingAutoReplies.delete(threadId);
    try {
      const liveThread = await discordClient.channels.fetch(threadId);
      if (!liveThread) return;
      await liveThread.sendTyping();
      const combined = entry.accumulatedMessages.join('\n\n');
      await runAgent(entry.discordClient, liveThread, entry.issue, combined, entry.member);
      console.log(`[autoReply] Sent RAG reply in thread ${threadId} for ${entry.issue.short_id} (${entry.accumulatedMessages.length} messages accumulated)`);
    } catch (err) {
      console.error(`[autoReply] Failed in thread ${threadId}:`, err.message);
    }
  }, AUTO_REPLY_DELAY_MS);
  return true;
}
const {} = require('./lib/context'); // thread brief exports disabled
const supabase = require('./lib/supabase');
const ingestion = require('./lib/ingestion');

// ─── Client setup ────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel]
});

// ─── Load commands ────────────────────────────────────────────────────
client.commands = new Collection();
const commandFiles = fs.readdirSync('./commands').filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.data.name, command);
  console.log(`Loaded command: /${command.data.name}`);
}

// ─── Ready ────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  log.info({ tag: client.user.tag, guilds: client.guilds.cache.size }, 'Bot online');

  // Init Qdrant collections (bot collections + pipeline collection)
  await initCollections();
  // Ensure pipeline collection exists for context block storage
  const pipelineCollection = process.env.QDRANT_PIPELINE_COLLECTION || 'pipeline_contexts';
  await ensureCollection(pipelineCollection, false);

  // Start BullMQ workers — pass client so workers can call Discord API
  startWorkers(client);

  // Init message ingestion system (backfill + batch writer)
  await ingestion.init(client);

  // ─── Reminder job (stays in bot — needs Discord client) ──────────
  // Runs every hour + once 30s after startup
  setInterval(() => runReminderJob(client), 60 * 60 * 1000);
  setTimeout(() => runReminderJob(client), 30 * 1000);

  // ─── Cleaning: handled by Supabase Edge Function ───────────────────
  // See: supabase/functions/cleaning-cron/     (every 5 min via pg_cron)
  //      supabase/functions/retention-cleanup/ (daily via pg_cron)
  //      sql/setup_cron_jobs.sql               (cron schedule definitions)

  // ─── Pipeline: runs on Railway (needs compute + Python + no timeout) ──
  // The pipeline processes cleaned messages from Supabase, does:
  //   1. Embed all messages (Cloudflare AI)
  //   2. TextTiling boundary detection for topic segmentation
  //   3. LLM classification of segments into topic clusters
  //   4. Store results to Supabase (pipeline_clusters, pipeline_cluster_messages, pipeline_topic_summaries)
  //   5. Embed context blocks and upsert to Qdrant (pipeline_contexts collection)
  //
  // On startup: run pipeline once to process existing/new cleaned messages
  // Then schedule to run every 12 hours for incremental processing
  const { runPipeline } = require('./pipeline/src/index');

  // Check if pipeline should run (controlled via Railway environment variable)
  const autoRunPipeline = process.env.AUTO_RUN_PIPELINE !== 'false';

  if (autoRunPipeline) {
    // Schedule pipeline every 12h
    setInterval(async () => {
      try {
        log.info('[pipeline] Running scheduled pipeline...');
        await runPipeline();
        log.info('[pipeline] Scheduled pipeline complete');
      } catch (err) {
        log.error('[pipeline] Scheduled pipeline failed:', {
          message: err.message,
          stack: err.stack?.slice(0, 500),
        });
        // Don't crash bot — retry at next interval
      }
    }, 12 * 60 * 60 * 1000); // 12 hours

    // Run immediately on startup (1 min delay to let bot fully initialize)
    setTimeout(async () => {
      try {
        log.info('[pipeline] Running initial pipeline on startup...');
        await runPipeline();
        log.info('[pipeline] Initial pipeline complete');
      } catch (err) {
        log.error('[pipeline] Initial pipeline failed:', {
          message: err.message,
          stack: err.stack?.slice(0, 1000),
          code: err.code,
        });
        // Don't crash bot — will retry in 12 hours
      }
    }, 60000);

    log.info('Bot ready — pipeline runs on Railway, cleaning/retention via edge functions');
  } else {
    log.info('Bot ready — pipeline disabled (AUTO_RUN_PIPELINE=false), cleaning/retention via edge functions only');
  }
});

// Graceful shutdown — close workers cleanly when process exits
process.on('SIGTERM', async () => {
  log.info('SIGTERM received — shutting down gracefully');
  await ingestion.shutdown();
  await stopWorkers();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received — shutting down gracefully');
  await ingestion.shutdown();
  await stopWorkers();
  process.exit(0);
});

// ─── Forum thread auto-detection ─────────────────────────────────────
// Fires when someone manually creates a post directly in the forum channel
// without using /report — we still log it as an issue automatically
client.on('threadCreate', async (thread, newlyCreated) => {

  // Only process brand new threads — skip replays on restart
  if (!newlyCreated) return;

  const forumChannelId = process.env.BAD_REPORT_CHANNEL_ID;
  if (!forumChannelId) return;

  // Only handle threads inside our report forum channel
  if (!thread.parentId || thread.parentId !== forumChannelId) return;

  // Skip threads the bot itself created (via /report) to avoid double processing
  if (thread.ownerId === client.user.id) {
    console.log(`[threadCreate] Skipping bot-created thread: ${thread.name}`);
    return;
  }

  console.log(`[threadCreate] User-created thread detected: ${thread.name}`);

  // Give Discord time to attach the starter message
  await new Promise(resolve => setTimeout(resolve, 2000));

  let starterMessage;
  try {
    starterMessage = await thread.fetchStarterMessage();
  } catch (err) {
    console.error('[threadCreate] Could not fetch starter message:', err.message);
    return;
  }

  if (!starterMessage) {
    console.log('[threadCreate] No starter message found, skipping');
    return;
  }

  const user = starterMessage.author;
  const threadTitle = thread.name;
  const threadContent = starterMessage.content || 'No description provided';

  // Skip bot authors
  if (user.bot) return;

  console.log(`[threadCreate] Processing issue from ${user.username}: "${threadTitle}"`);

  // Check open issue limit
  const atLimit = await isAtIssueLimit(user.id);
  if (atLimit) {
    await thread.send({
      content: [
        `<@${user.id}> you already have 3 open issues — the maximum allowed.`,
        `A team member needs to resolve one before you can open another.`,
        `Use \`/myissues\` to see your current open issues.`
      ].join('\n')
    });
    return;
  }

  // Check for similar existing issue
  const similar = await findSimilarOpenIssue(user.id, threadTitle);
  if (similar) {
    await thread.send({
      content: [
        `<@${user.id}> you may already have a similar open issue: **${similar.short_id}** — "${similar.title}"`,
        ``,
        `If this is the same problem, use \`/status ${similar.short_id}\` to check on it.`,
        `If this is genuinely different, please add more specific detail to the title and try again.`
      ].join('\n')
    });
    return;
  }

  // Create issue in DB
  // Use thread.parentId as channel_id — do NOT pass the thread itself
  let issue;
  try {
    issue = await createIssue({
      user,
      guild: thread.guild,
      channel: { id: thread.parentId },
      title: threadTitle,
      description: threadContent,
      stepsTried: null
    });
  } catch (err) {
    console.error('[threadCreate] createIssue failed:', err.message);
    await thread.send({
      content: `<@${user.id}> there was an error logging your issue. Please try again or use \`/report\`.`
    });
    return;
  }

  await saveMessage({
    issueId: issue.id,
    role: 'user',
    content: `Title: ${threadTitle}\nDescription: ${threadContent}`
  });

  await attachThread(issue.id, thread.id);
  issue.thread_id = thread.id;

  await saveMessage({
    issueId: issue.id,
    role: 'assistant',
    content: `Issue ${issue.short_id} auto-detected from user-created forum thread.`,
    discordMsgId: thread.id
  });

  // Confirm issue to user inside the thread
  await thread.send({
    content: [
      `<@${user.id}> your issue has been logged as **${issue.short_id}**.`,
      `**Department:** ${issue.department}`,
      ``,
      `Use \`/status ${issue.short_id}\` to check for updates.`,
      `Use \`/myissues\` to see all your open issues.`
    ].join('\n')
  });

  // Wait before pinging role — thread needs to be fully initialized
  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    const liveThread = await client.channels.fetch(thread.id);
    await pingRoleInThread(client, liveThread, issue, 'new_issue');
  } catch (err) {
    console.error('[threadCreate] Could not ping role:', err.message);
  }

  // Schedule auto-reply: answer the user's initial message after 45s if they don't send another
  scheduleAutoReply(thread.id, client, issue, threadContent, { id: user.id });

  // Queue the forward job instead of calling directly
  await addForwardJob({
    issueId: issue.short_id,
    userId: user.id
  });

  // Fix 2: Create initial thread brief — DISABLED
  // try {
  //   const allIssues = await getAllThreadIssues(thread.id);
  //   await updateThreadBrief(thread, allIssues, client.user.id);
  // } catch (err) {
  //   console.warn('[threadCreate] Could not create initial brief:', err.message);
  // }

  console.log(`[threadCreate] Issue ${issue.short_id} created and processed`);
});

// ─── Thread message listener ──────────────────────────────────────────
client.on('messageCreate', async message => {
  // Community message ingestion (non-blocking, filtered internally)
  ingestion.handleMessage(message);

  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  const thread = message.channel;
  if (thread.parentId !== process.env.BAD_REPORT_CHANNEL_ID) return;

  const content = message.content.trim();
  if (!content) return;

  // If there's a pending auto-reply, accumulate this message and reset the 45s timer
  // (don't run agent — the timer will fire after silence)
  if (accumulateAutoReply(thread.id, content)) {
    // Still save the message to DB for history, using the issue from the pending entry
    const pendingEntry = _pendingAutoReplies.get(thread.id);
    if (pendingEntry) {
      await saveMessage({ issueId: pendingEntry.issue.id, role: 'user', content, discordMsgId: message.id });
    }
    return;
  }

  // ── Fix 1: Multi-user routing ──────────────────────────────────────
  // First, look for the PRIMARY issue in this thread
  const { data: primaryIssue } = await supabase
    .from('issues')
    .select('*')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!primaryIssue) return;

  // Check if this author already has their OWN issue in this thread (sub-issue)
  const { findIssueForAuthorInThread } = require('./lib/issues');
  const authorIssue = await findIssueForAuthorInThread(thread.id, message.author.id);

  // Use the author's own issue if it exists, otherwise use the primary issue
  // (The agent will detect if a new user needs a sub-issue created)
  const issue = authorIssue || primaryIssue;

  if (issue.status === 'resolved' || issue.status === 'closed') {
    // If the author's own sub-issue is resolved but the primary isn't,
    // still let the message through under the primary issue
    if (authorIssue && primaryIssue.status !== 'resolved' && primaryIssue.status !== 'closed') {
      // Fall through with primary issue
    } else {
      return;
    }
  }

  // Determine the effective issue for this message
  const effectiveIssue = (issue.status === 'resolved' || issue.status === 'closed')
    ? primaryIssue
    : issue;

  // Save user message BEFORE running agent so history is complete
  await saveMessage({
    issueId: effectiveIssue.id,
    role: 'user',
    content,
    discordMsgId: message.id
  });

  await thread.sendTyping();
  // Pass member for staff role check; fall back to author ID if member not cached
  // Always pass the PRIMARY issue to runAgent — it handles sub-issue routing internally
  await runAgent(client, thread, primaryIssue, content, message.member || { id: message.author.id });
});

// ─── Interaction handler ──────────────────────────────────────────────
client.on('interactionCreate', async interaction => {

  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Error in /${interaction.commandName}:`, err);
      const msg = {
        content: 'Something went wrong. Please try again.',
        flags: MessageFlags.Ephemeral
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'report_modal') {
    await handleReportModal(interaction);
    return;
  }
});

// ─── /report modal handler ────────────────────────────────────────────
async function handleReportModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const title = interaction.fields.getTextInputValue('issue_title');
  const description = interaction.fields.getTextInputValue('issue_description');
  const stepsTried = interaction.fields.getTextInputValue('issue_steps') || null;
  const user = interaction.user;

  // Check open issue limit
  const atLimit = await isAtIssueLimit(user.id);
  if (atLimit) {
    return interaction.editReply({
      content: [
        `You already have 3 open issues — the maximum allowed.`,
        `Use \`/myissues\` to see them. A team member needs to resolve one before you can open another.`
      ].join('\n')
    });
  }

  // Check for duplicate
  const similar = await findSimilarOpenIssue(user.id, title);
  if (similar) {
    return interaction.editReply({
      content: [
        `You may already have a similar open issue: **${similar.short_id}** — "${similar.title}"`,
        ``,
        `If this is the same problem, use \`/status ${similar.short_id}\` to check on it.`,
        `If this is genuinely different, please make the title more specific and try again.`
      ].join('\n')
    });
  }

  // Create issue in DB
  let issue;
  try {
    issue = await createIssue({
      user,
      guild: interaction.guild,
      channel: interaction.channel,
      title,
      description,
      stepsTried
    });
  } catch (err) {
    console.error('createIssue failed:', err.message);
    return interaction.editReply({
      content: 'Something went wrong saving your issue. Please try again in a moment.'
    });
  }

  // Save initial user message
  await saveMessage({
    issueId: issue.id,
    role: 'user',
    content: `Title: ${title}\nDescription: ${description}\nSteps tried: ${stepsTried || 'None'}`
  });

  // Create forum post (or text thread fallback)
  const thread = await createReportThread(interaction.client, issue, user);

  if (thread) {
    await attachThread(issue.id, thread.id);
    issue.thread_id = thread.id;

    await saveMessage({
      issueId: issue.id,
      role: 'assistant',
      content: `Issue ${issue.short_id} thread created via /report.`,
      discordMsgId: thread.id
    });

    // Wait for thread to fully initialize before sending into it
    await new Promise(resolve => setTimeout(resolve, 1500));

    try {
      const liveThread = await interaction.client.channels.fetch(thread.id);
      await pingRoleInThread(interaction.client, liveThread, issue, 'new_issue');

      // Fix 2: Create initial thread brief — DISABLED
      // const allIssues = await getAllThreadIssues(thread.id);
      // await updateThreadBrief(liveThread, allIssues, interaction.client.user.id);
    } catch (err) {
      console.error('Could not ping role or create brief in thread:', err.message);
    }

    // Schedule auto-reply: answer the user's initial message after 45s if they don't send another
    const initialContent = `Title: ${title}\nDescription: ${description}${stepsTried ? `\nSteps tried: ${stepsTried}` : ''}`;
    scheduleAutoReply(thread.id, interaction.client, issue, initialContent, { id: user.id });
  }

  // Queue the forward job instead of calling directly
  await addForwardJob({
    issueId: issue.short_id,
    userId: user.id
  });

  // Ephemeral reply to user
  const lines = [
    `Your issue has been reported as **${issue.short_id}**.`,
    `Department: **${issue.department}**`,
    ``
  ];

  if (thread) lines.push(`Your thread: <#${thread.id}>`);

  lines.push(`Use \`/status ${issue.short_id}\` to check for updates.`);
  lines.push(`Use \`/myissues\` to see all your open issues.`);

  await interaction.editReply({ content: lines.join('\n') });
}

// ─── Login ────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);