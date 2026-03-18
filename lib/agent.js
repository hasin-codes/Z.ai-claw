// lib/agent.js
const { classifyIntent }  = require('./intent');
const { fetchContext }    = require('./memory');
const { rewriteQuery }    = require('./rewriter');
const { generateResponse, THRESHOLD_HIGH } = require('./responder');
const { embed }           = require('./cloudflare');
const { search, COLLECTIONS } = require('./qdrant');
const { pingRoleInThread } = require('./forward');
const { saveMessage }     = require('./issues');
const supabase            = require('./supabase');

// Check if this issue has already been escalated — prevents repeat role pings
async function hasBeenEscalated(issueId) {
  const { data } = await supabase
    .from('issue_messages')
    .select('id')
    .eq('issue_id', issueId)
    .eq('role', 'system')
    .ilike('content', 'AGENT escalation%')
    .limit(1);

  return data && data.length > 0;
}

// Build a human-readable status reply from issue data
function buildStatusReply(issue) {
  const STATUS_LABELS = {
    open:         '🔴 Open — waiting for a team member to pick this up',
    acknowledged: '🟡 Acknowledged — a team member has seen your issue',
    in_progress:  '🔵 In progress — someone is actively working on this',
    resolved:     '🟢 Resolved',
    closed:       '⚪ Closed'
  };

  const label   = STATUS_LABELS[issue.status] || issue.status;
  const created = new Date(issue.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  return [
    `**Status of ${issue.short_id}:** ${label}`,
    `Reported: ${created}`,
    issue.status === 'open' || issue.status === 'acknowledged'
      ? `\nA team member will respond here as soon as possible.`
      : ''
  ].join('\n').trim();
}

async function runAgent(discordClient, thread, issue, userMessage) {
  console.log(`[agent] ${issue.short_id} — processing: "${userMessage.slice(0, 60)}"`);

  // ── Layer 1: Intent classification ──────────────────────────────────
  const { intent, reply: casualReply } = await classifyIntent(userMessage);
  console.log(`[agent] Intent: ${intent}`);

  // CASUAL — reply directly, no LLM or RAG needed
  if (intent === 'CASUAL') {
    try {
      const msg = await thread.send({ content: casualReply });
      await saveMessage({
        issueId:      issue.id,
        role:         'assistant',
        content:      casualReply,
        discordMsgId: msg.id
      });
    } catch (err) {
      console.error('[agent] Failed to send casual reply:', err.message);
    }
    return;
  }

  // STATUS — query DB and reply directly
  if (intent === 'STATUS') {
    const statusReply = buildStatusReply(issue);
    try {
      const msg = await thread.send({ content: statusReply });
      await saveMessage({
        issueId:      issue.id,
        role:         'assistant',
        content:      statusReply,
        discordMsgId: msg.id
      });
    } catch (err) {
      console.error('[agent] Failed to send status reply:', err.message);
    }
    return;
  }

  // ── Layer 2: Context assembly ────────────────────────────────────────
  const context = await fetchContext(issue);
  console.log(`[agent] History: ${context.messageCount} messages`);

  // ── Layer 3: Query rewriting ─────────────────────────────────────────
  const { query, needsRag } = await rewriteQuery(userMessage, context.history);

  // ── Qdrant search (if needed) ─────────────────────────────────────────
  let ragResults = [];
  if (needsRag && query) {
    try {
      const queryVector = await embed(query);
      ragResults = await search(COLLECTIONS.docs, queryVector, 5);

      // Also search resolved cases (Tier 2) — filter by department
      try {
        const tier2 = await search(
          COLLECTIONS.cases,
          queryVector,
          3,
          issue.department ? {
            must: [{ key: 'department', match: { value: issue.department } }]
          } : null
        );
        ragResults = [...ragResults, ...tier2];
      } catch {
        // Tier 2 may be empty — not an error
      }

      const bestScore = ragResults.length > 0
        ? Math.max(...ragResults.map(r => r.score))
        : 0;
      console.log(`[agent] RAG best score: ${bestScore.toFixed(3)} across ${ragResults.length} results`);

    } catch (err) {
      console.error('[agent] Search failed:', err.message);
    }
  } else {
    console.log('[agent] Skipping RAG — rewriter said not needed');
  }

  // ── Layer 4: Response generation ──────────────────────────────────────
  const answer = await generateResponse(userMessage, ragResults, context);

  if (answer.toUpperCase().startsWith('ESCALATE')) {
    await escalate(discordClient, thread, issue, userMessage);
    return;
  }

  // Send answer
  try {
    const msg = await thread.send({ content: answer });
    await saveMessage({
      issueId:      issue.id,
      role:         'assistant',
      content:      answer,
      discordMsgId: msg.id
    });
    console.log(`[agent] ${issue.short_id} — answered successfully`);
  } catch (err) {
    console.error('[agent] Failed to send answer:', err.message);
  }
}

async function escalate(discordClient, thread, issue, userMessage) {
  console.log(`[agent] Escalating ${issue.short_id}`);

  const alreadyEscalated = await hasBeenEscalated(issue.id);

  if (!alreadyEscalated) {
    try {
      await thread.send({
        content: [
          `I wasn't able to find a clear answer in our documentation or past cases.`,
          ``,
          `I've flagged this for a team member who will follow up here shortly.`
        ].join('\n')
      });
    } catch (err) {
      console.error('[agent] Failed to send escalation message:', err.message);
    }
    await pingRoleInThread(discordClient, thread, issue, 'escalation');
  } else {
    try {
      await thread.send({
        content: `I still don't have an answer for that. A team member has already been notified and will assist you shortly.`
      });
    } catch (err) {
      console.error('[agent] Failed to send follow-up escalation:', err.message);
    }
  }

  await saveMessage({
    issueId: issue.id,
    role:    'system',
    content: `AGENT escalation — no answer found for: "${userMessage.slice(0, 200)}"`
  });
}

module.exports = { runAgent };
