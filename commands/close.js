const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getIssueByShortId, updateStatus } = require('../lib/issues');
const { addNotifyJob } = require('../lib/queue');

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
    const reason  = interaction.options.getString('reason') || 'Closed by support team.';
    const issue   = await getIssueByShortId(shortId);

    if (!issue) {
      return interaction.editReply({ content: `No issue found with ID **${shortId}**.` });
    }

    if (issue.status === 'resolved' || issue.status === 'closed') {
      return interaction.editReply({
        content: `**${issue.short_id}** is already ${issue.status}.`
      });
    }

    const success = await updateStatus({
      issueId:   issue.id,
      newStatus: 'closed',
      changedBy: interaction.user.id,
      note:      reason
    });

    if (!success) {
      return interaction.editReply({ content: `Failed to close issue. Try again.` });
    }

    await addNotifyJob({
      issueId:   issue.short_id,
      newStatus: 'closed',
      note:      reason
    });

    await interaction.editReply({
      content: `**${issue.short_id}** has been closed. User will be notified.`
    });
  }
};