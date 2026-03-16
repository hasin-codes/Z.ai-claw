const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getIssueByShortId, updateStatus } = require('../lib/issues');
const { addNotifyJob } = require('../lib/queue');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('acknowledge')
    .setDescription('Mark an issue as acknowledged (team only)')
    .addStringOption(opt =>
      opt.setName('issue_id')
        .setDescription('Issue ID e.g. ISS-1001')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const shortId = interaction.options.getString('issue_id');
    const issue   = await getIssueByShortId(shortId);

    if (!issue) {
      return interaction.editReply({ content: `No issue found with ID **${shortId}**.` });
    }

    if (issue.status !== 'open') {
      return interaction.editReply({
        content: `**${issue.short_id}** is already ${issue.status}.`
      });
    }

    await updateStatus({
      issueId:   issue.id,
      newStatus: 'acknowledged',
      changedBy: interaction.user.id,
      note:      'Issue acknowledged by team'
    });

    await addNotifyJob({
      issueId:   issue.short_id,
      newStatus: 'acknowledged',
      note:      'A team member has seen your issue and will look into it.'
    });

    await interaction.editReply({
      content: `**${issue.short_id}** marked as acknowledged. User will be notified.`
    });
  }
};