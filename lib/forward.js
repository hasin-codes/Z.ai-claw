const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const DEPT_CHANNELS = {
  billing:      process.env.DEPT_CHANNEL_BILLING,
  technical:    process.env.DEPT_CHANNEL_TECHNICAL,
  product:      process.env.DEPT_CHANNEL_PRODUCT,
  unclassified: process.env.DEPT_CHANNEL_UNCLASSIFIED
};

const DEPT_ROLES = {
  billing:      process.env.ROLE_BILLING,
  technical:    process.env.ROLE_TECHNICAL,
  product:      process.env.ROLE_PRODUCT,
  unclassified: process.env.ROLE_UNCLASSIFIED
};

const DEPT_COLORS = {
  billing:      0xEF9F27,
  technical:    0x378ADD,
  product:      0x1D9E75,
  unclassified: 0x888780
};

async function forwardToTeam(client, issue, user) {
  // Check if forwarding is enabled at all
  const shouldForward = await config.getBoolean('forward_to_internal', true);
  if (!shouldForward) return;

  const shouldPing = await config.getBoolean('ping_roles', true);

  const dept      = issue.department || 'unclassified';
  const channelId = DEPT_CHANNELS[dept] || DEPT_CHANNELS.unclassified;
  const roleId    = DEPT_ROLES[dept]    || DEPT_ROLES.unclassified;

  if (!channelId) {
    console.warn(`No internal channel configured for department: ${dept}`);
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    console.error(`Could not fetch dept channel ${channelId}:`, err.message);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(DEPT_COLORS[dept] || DEPT_COLORS.unclassified)
    .setTitle(`${issue.short_id} — ${issue.title}`)
    .addFields(
      { name: 'Department',  value: dept.charAt(0).toUpperCase() + dept.slice(1), inline: true },
      { name: 'Status',      value: 'Open',                                       inline: true },
      { name: 'Reported by', value: `<@${user.id}> (${user.username})`,           inline: true },
      { name: 'Description', value: issue.description.slice(0, 500) }
    )
    .setFooter({ text: `Use /resolve ${issue.short_id} to close` })
    .setTimestamp();

  if (issue.steps_tried) {
    embed.addFields({ name: 'Steps tried', value: issue.steps_tried.slice(0, 300) });
  }

  if (issue.thread_id) {
    embed.addFields({ name: 'Thread', value: `<#${issue.thread_id}>` });
  }

  const content = (shouldPing && roleId)
    ? `<@&${roleId}> New issue requires attention.`
    : `New issue requires attention.`;

  try {
    await channel.send({ content, embeds: [embed] });
  } catch (err) {
    console.error(`Failed to forward ${issue.short_id}:`, err.message);
  }
}

async function pingRoleInThread(client, thread, issue, reason = 'new_issue') {
  const shouldPing = await config.getBoolean('ping_roles', true);
  console.log(`[pingRoleInThread] ping_roles enabled: ${shouldPing}`);
  if (!shouldPing) {
    console.log('[pingRoleInThread] Skipping - ping_roles is disabled');
    return;
  }

  const dept   = issue.department || 'unclassified';
  const roleId = DEPT_ROLES[dept] || DEPT_ROLES.unclassified;

  console.log(`[pingRoleInThread] Department: ${dept}, Role ID: ${roleId || 'NOT SET'}`);

  if (!roleId) {
    console.warn(`[pingRoleInThread] No role configured for department: ${dept} — check your .env ROLE_* variables`);
    return;
  }

  const messages = {
    new_issue: [
      `<@&${roleId}>`,
    ].join('\n'),

    escalation: [
      `<@&${roleId}> the bot could not find an answer for this issue and needs a human.`,
      ``,
      `The user is waiting in this thread. Please review the context above and respond directly here.`,
      `Use \`/resolve ${issue.short_id}\` once handled.`,
    ].join('\n')
  };

  try {
    await thread.send({ content: messages[reason] || messages.new_issue });
  } catch (err) {
    console.error(`Failed to ping role in thread ${thread.id}:`, err.message);
  }
}

module.exports = { forwardToTeam, pingRoleInThread };
