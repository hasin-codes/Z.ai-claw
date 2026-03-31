const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getIssueByShortId, updateStatus, getAllThreadIssues } = require('../lib/issues');
const { addNotifyJob } = require('../lib/queue');
const { unpinEscalationEmbed, updateThreadBrief } = require('../lib/context');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close an issue without resolving (team only)')
    .addStringOption(opt =>
      opt.setName('issue_id')
        .setDescription('Issue ID e.g. ISS-1001')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('reason')
        .setDescription('Why this is being closed')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const shortId = interaction.options.getString('issue_id');
    const reason = interaction.options.getString('reason') || 'Closed by support team.';
    const issue = await getIssueByShortId(shortId);

    if (!issue) {
      return interaction.editReply({ content: `No issue found with ID **${shortId}**.` });
    }

    if (issue.status === 'resolved' || issue.status === 'closed') {
      return interaction.editReply({
        content: `**${issue.short_id}** is already ${issue.status}.`
      });
    }

    const success = await updateStatus({
      issueId: issue.id,
      newStatus: 'closed',
      changedBy: interaction.user.id,
      note: reason
    });

    if (!success) {
      return interaction.editReply({ content: `Failed to close issue. Try again.` });
    }

    // V6.81: Unpin escalation embed when issue is closed
    if (issue.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(issue.thread_id);
        if (thread) {
          await unpinEscalationEmbed(thread);
          // Fix 5: Update thread brief on close — DISABLED
          // const allIssues = await getAllThreadIssues(issue.thread_id);
          // await updateThreadBrief(thread, allIssues, interaction.client.user.id);
        }
      } catch (err) {
        console.warn(`[close] Could not update thread for ${issue.short_id}:`, err.message);
      }
    }

    await addNotifyJob({
      issueId: issue.short_id,
      newStatus: 'closed',
      note: reason
    });

    await interaction.editReply({
      content: `**${issue.short_id}** has been closed. User will be notified.`
    });
  }
};