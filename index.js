require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  ChannelType,
  MessageFlags
} = require('discord.js');
const fs   = require('fs');
const pino = require('pino');

const log = pino({ level: 'info' }, pino.destination(1));

const {
  createIssue,
  attachThread,
  saveMessage,
  isAtIssueLimit,
  findSimilarOpenIssue
} = require('./lib/issues');

const { forwardToTeam, pingRoleInThread } = require('./lib/forward');
const { createReportThread }              = require('./lib/forum');
const { runReminderJob }                  = require('./lib/reminders');
const { startWorkers, stopWorkers }       = require('./lib/workers');
const { addForwardJob }                   = require('./lib/queue');
const { initCollections }                 = require('./lib/qdrant');
const { answerInThread }                  = require('./lib/rag');

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

  // Init Qdrant collections
  await initCollections();

  // Start BullMQ workers — pass client so workers can call Discord API
  startWorkers(client);

  // Reminder job every hour + once 30s after startup
  setInterval(() => runReminderJob(client), 60 * 60 * 1000);
  setTimeout(() => runReminderJob(client), 30 * 1000);
});

// Graceful shutdown — close workers cleanly when process exits
process.on('SIGTERM', async () => {
  log.info('SIGTERM received — shutting down gracefully');
  await stopWorkers();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received — shutting down gracefully');
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

  const user          = starterMessage.author;
  const threadTitle   = thread.name;
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
      guild:       thread.guild,
      channel:     { id: thread.parentId },
      title:       threadTitle,
      description: threadContent,
      stepsTried:  null
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
    role:    'user',
    content: `Title: ${threadTitle}\nDescription: ${threadContent}`
  });

  await attachThread(issue.id, thread.id);
  issue.thread_id = thread.id;

  await saveMessage({
    issueId:      issue.id,
    role:         'assistant',
    content:      `Issue ${issue.short_id} auto-detected from user-created forum thread.`,
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

  // Queue the forward job instead of calling directly
  await addForwardJob({
    issueId: issue.short_id,
    userId:  user.id
  });

  console.log(`[threadCreate] Issue ${issue.short_id} created and processed`);
});

// ─── Thread message listener ──────────────────────────────────────────
// Watches messages inside issue threads and triggers RAG answering
client.on('messageCreate', async message => {

  // Ignore bots (including itself)
  if (message.author.bot) return;

  // Only care about messages inside threads
  if (!message.channel.isThread()) return;

  const thread = message.channel;

  // Only handle threads that are inside our forum channel
  if (thread.parentId !== process.env.BAD_REPORT_CHANNEL_ID) return;

  const content = message.content.trim();
  if (!content) return;

  const isMention = message.mentions.has(client.user.id);

  // If mentioned — answer immediately regardless
  // If not mentioned — only answer if message looks like a question
  const isQuestion = content.endsWith('?') ||
    /^(how|what|why|when|where|can|does|is|are|do|will|should|could)/i.test(content);

  if (!isMention && !isQuestion) return;

  // Find the issue this thread belongs to
  const supabase = require('./lib/supabase');
  const { data: issue } = await supabase
    .from('issues')
    .select('*')
    .eq('thread_id', thread.id)
    .maybeSingle();

  if (!issue) return; // thread not linked to an issue — ignore

  // Don't answer already resolved/closed issues
  if (issue.status === 'resolved' || issue.status === 'closed') return;

  // Save user message to history
  await saveMessage({
    issueId:      issue.id,
    role:         'user',
    content,
    discordMsgId: message.id
  });

  // Show typing indicator while we work
  await thread.sendTyping();

  // Run RAG
  await answerInThread(client, thread, issue, content);
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
        flags:   MessageFlags.Ephemeral
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

  const title       = interaction.fields.getTextInputValue('issue_title');
  const description = interaction.fields.getTextInputValue('issue_description');
  const stepsTried  = interaction.fields.getTextInputValue('issue_steps') || null;
  const user        = interaction.user;

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
      guild:   interaction.guild,
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
    role:    'user',
    content: `Title: ${title}\nDescription: ${description}\nSteps tried: ${stepsTried || 'None'}`
  });

  // Create forum post (or text thread fallback)
  const thread = await createReportThread(interaction.client, issue, user);

  if (thread) {
    await attachThread(issue.id, thread.id);
    issue.thread_id = thread.id;

    await saveMessage({
      issueId:      issue.id,
      role:         'assistant',
      content:      `Issue ${issue.short_id} thread created via /report.`,
      discordMsgId: thread.id
    });

    // Wait for thread to fully initialize before sending into it
    await new Promise(resolve => setTimeout(resolve, 1500));

    try {
      const liveThread = await interaction.client.channels.fetch(thread.id);
      await pingRoleInThread(interaction.client, liveThread, issue, 'new_issue');
    } catch (err) {
      console.error('Could not ping role in thread:', err.message);
    }
  }

  // Queue the forward job instead of calling directly
  await addForwardJob({
    issueId: issue.short_id,
    userId:  user.id
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