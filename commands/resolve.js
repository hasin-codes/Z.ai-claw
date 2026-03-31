const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getIssueByShortId, updateStatus, getAllThreadIssues } = require('../lib/issues');
const { addNotifyJob } = require('../lib/queue');
const { unpinEscalationEmbed, updateThreadBrief } = require('../lib/context');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resolve')
    .setDescription('Mark an issue as resolved (team only)')
    .addStringOption(opt =>
      opt.setName('issue_id')
        .setDescription('Issue ID e.g. ISS-1001')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('note')
        .setDescription('Resolution note to share with the user')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const shortId = interaction.options.getString('issue_id');
    const note = interaction.options.getString('note') || 'Your issue has been resolved.';
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
      newStatus: 'resolved',
      changedBy: interaction.user.id,
      note
    });

    if (!success) {
      return interaction.editReply({ content: `Failed to update status. Try again.` });
    }

    // V6.81: Unpin escalation embed when issue is resolved
    if (issue.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(issue.thread_id);
        if (thread) {
          await unpinEscalationEmbed(thread);
          // Fix 5: Update thread brief on resolve — DISABLED
          // const allIssues = await getAllThreadIssues(issue.thread_id);
          // await updateThreadBrief(thread, allIssues, interaction.client.user.id);
        }
      } catch (err) {
        console.warn(`[resolve] Could not update thread for ${issue.short_id}:`, err.message);
      }
    }

    // Queue notification instead of calling directly
    await addNotifyJob({
      issueId: issue.short_id,
      newStatus: 'resolved',
      note
    });

    await interaction.editReply({
      content: `**${issue.short_id}** marked as resolved. User will be notified.`
    });
  }
};