// lib/agent.js
const { classifyIntent }  = require('./intent');
const { fetchContext }    = require('./memory');
const { rewriteQuery }    = require('./rewriter');
const { generateResponse } = require('./responder');
const { embed, rerank }   = require('./cloudflare');
const { search, COLLECTIONS } = require('./qdrant');
const { saveMessage }     = require('./issues');
const supabase            = require('./supabase');

// Split multi-question messages into individual questions
// Handles: numbered lists, bullets, and the most common Discord pattern
// ("how do I X? how do I Y?") — conservative by design
function splitQuestions(message) {
  const trimmed = message.trim();
  const questionCount = (trimmed.match(/\?/g) || []).length;

  // Single question — no split needed
  if (questionCount <= 1) return [trimmed];

  // Try numbered list: "1. question? 2. question?"
  const numberedParts = trimmed.split(/\s+(?=\d+[\.\)]\s)/);
  const filtered = numberedParts.filter(p => p.trim().includes('?'));
  if (filtered.length >= 2) return filtered.map(p => p.trim());

  // Try bullet pattern: "- question? - question?"
  const bulletParts = trimmed.split(/\n\s*[-•]\s*/);
  const filteredBullets = bulletParts.filter(p => p.trim().includes('?'));
  if (filteredBullets.length >= 2) return filteredBullets.map(p => p.trim());

  // Split on "? " followed by a question word — the most common Discord pattern
  // e.g. "how do I contact support? how do I cancel my subscription?"
  const sentenceParts = trimmed.split(/\?\s+(?=how|what|why|when|where|can|do|is|are|will|would|could|should|i need|i want|does)/i);
  if (sentenceParts.length >= 2) {
    // Re-add the ? that was consumed by the split
    const withQ = sentenceParts.map((p, i) => {
      const cleaned = p.trim();
      // Last part already has ? if original ended with ?
      // All other parts need ? added back
      if (i < sentenceParts.length - 1 && !cleaned.endsWith('?')) {
        return cleaned + '?';
      }
      return cleaned;
    });
    return withQ.filter(p => p.length > 5);
  }

  // Multiple ? but no clear delimiter — don't risk splitting
  return [trimmed];
}

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

// Process a single question through L2→L3→L4 pipeline
// Returns { answer: string } or { escalate: true }
async function processSingleQuestion(question, context, issue, intent) {
  // L3: Query rewriting with actual intent from classification
  const { query, needsRag } = await rewriteQuery(question, context.history, intent);

  // ── Qdrant search ─────────────────────────────────────────
  let ragResults = [];
  if (needsRag && query && query.length > 3) {
    try {
      const queryVector = await embed(query);
      // Fetch more candidates than needed — reranker will filter down
      const candidates = await search(COLLECTIONS.docs, queryVector, 10);

      const tier2 = await search(COLLECTIONS.cases, queryVector, 5,
        issue.department ? {
          must: [{ key: 'department', match: { value: issue.department } }]
        } : null
      ).catch(() => []);

      const allCandidates = [...candidates, ...tier2];
      const bestVectorScore = allCandidates.length > 0
        ? Math.max(...allCandidates.map(r => r.score))
        : 0;

      console.log(`[agent] Vector search: ${allCandidates.length} candidates, best: ${bestVectorScore.toFixed(3)}`);

      // ── Reranking step ──────────────────────────────────────
      if (allCandidates.length > 0) {
        // Reranker scores against full section (problem + solution) for better keyword matching
        const docTexts = allCandidates.map(r => r.payload.content);

        try {
          const reranked = await rerank(query, docTexts);

          // Map reranker scores back to original results
          // Reranker returns { id, score } — id = input index, score is raw logit, apply sigmoid
          const sigmoid = x => 1 / (1 + Math.exp(-x));

          ragResults = reranked
            .map(r => ({
              ...allCandidates[r.id],
              score:          sigmoid(r.score),
              vector_score:   allCandidates[r.id].score,
              reranker_score: sigmoid(r.score)
            }))
            .sort((a, b) => b.reranker_score - a.reranker_score)
            .slice(0, 5);

          const bestReranked = ragResults[0]?.reranker_score || 0;
          console.log(`[agent] After reranking: best score ${bestReranked.toFixed(3)}`);

        } catch (err) {
          // Reranker failed — fall back to vector results
          console.warn('[agent] Reranker failed, using vector results:', err.message);
          ragResults = allCandidates.slice(0, 5);
        }
      }

      // For complaints, the contact-support chunk is a redirect not a solution
      // Only accept it if it scores very high (genuine match) or if no other results exist
      if (intent === 'COMPLAINT') {
        const nonContactResults = ragResults.filter(r => {
          const content = (r.payload.content || '').toLowerCase();
          const isContactChunk = content.includes('/report command') &&
            !content.includes('error') &&
            !content.includes('rate limit') &&
            !content.includes('unauthorized');
          return !isContactChunk || r.reranker_score > 0.85;
        });
        // Only apply filter if it doesn't remove everything
        if (nonContactResults.length > 0) {
          ragResults = nonContactResults;
          console.log(`[agent] COMPLAINT filter: ${ragResults.length} results after removing contact-only chunks`);
        }
      }

    } catch (err) {
      console.error('[agent] Search failed:', err.message);
    }
  } else {
    console.log('[agent] Skipping RAG — rewriter said not needed');
  }

  // L4: Response generation
  const answer = await generateResponse(question, ragResults, context, needsRag);
  if (answer.toUpperCase().startsWith('ESCALATE')) {
    return { escalate: true };
  }
  return { answer };
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

  // UNCLEAR — ask for clarification immediately, skip full pipeline
  if (intent === 'UNCLEAR') {
    const clarifyReply = `I'm not quite sure what you're asking. Could you give me a bit more detail? For example, what specific part of the product are you having trouble with?`;
    try {
      const msg = await thread.send({ content: clarifyReply });
      await saveMessage({
        issueId:      issue.id,
        role:         'assistant',
        content:      clarifyReply,
        discordMsgId: msg.id
      });
    } catch (err) {
      console.error('[agent] Failed to send clarification request:', err.message);
    }
    return;
  }

  // ── Layer 2: Context assembly ────────────────────────────────────────
  const context = await fetchContext(issue);
  console.log(`[agent] History: ${context.messageCount} messages`);

  // ── Fix 2: Multi-question splitting ─────────────────────────────────
  // Split on clear delimiters (numbered lists, bullets) — conservative
  const questions = splitQuestions(userMessage);
  const isMulti = questions.length > 1;
  if (isMulti) {
    console.log(`[agent] Split into ${questions.length} sub-questions`);
  }

  // ── Layer 3 + 4: Process each question through rewriter → RAG → responder ──
  const answers = [];
  let needsEscalation = false;

  for (const q of questions) {
    const result = await processSingleQuestion(q, context, issue, intent);
    if (result.escalate) {
      needsEscalation = true;
      break; // One escalation = escalate the whole message
    }
    answers.push(result.answer);
  }

  if (needsEscalation) {
    await escalate(discordClient, thread, issue, userMessage, context);
    return;
  }

  // Send answer(s) — numbered if multi-question, plain if single
  const finalAnswer = isMulti
    ? answers.map((a, i) => `**${i + 1}.** ${a}`).join('\n\n')
    : answers[0];

  try {
    const msg = await thread.send({ content: finalAnswer });
    await saveMessage({
      issueId:      issue.id,
      role:         'assistant',
      content:      finalAnswer,
      discordMsgId: msg.id
    });
    console.log(`[agent] ${issue.short_id} — answered successfully`);
  } catch (err) {
    console.error('[agent] Failed to send answer:', err.message);
  }
}

// Fix 4: Enriched escalation context — gives team members a quick brief
async function escalate(discordClient, thread, issue, userMessage, context) {
  console.log(`[agent] Escalating ${issue.short_id}`);

  const alreadyEscalated = await hasBeenEscalated(issue.id);

  // Build a concise brief for the team member
  const historyBrief = context.history.length > 0
    ? context.history.slice(-4).map(m => `${m.role}: ${m.content.slice(0, 80)}`).join('\n')
    : '(no prior messages)';

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
    // Build role IDs map from env
    const DEPT_ROLES = {
      billing:      process.env.ROLE_BILLING,
      technical:    process.env.ROLE_TECHNICAL,
      product:      process.env.ROLE_PRODUCT,
      unclassified: process.env.ROLE_UNCLASSIFIED
    };
    const dept   = issue.department || 'unclassified';
    const roleId = DEPT_ROLES[dept] || DEPT_ROLES.unclassified;

    const contextBrief = [
      roleId ? `<@&${roleId}>` : `Team`,
      ``,
      `**${issue.short_id} needs human attention.**`,
      `**User asked:** "${userMessage.slice(0, 300)}"`,
      `**Department:** ${dept} | **Status:** ${issue.status}`,
      `**Original issue:** ${issue.title}`,
      ``,
      `The bot could not find an answer in documentation. Please review the conversation above and respond here.`,
      `Use \`/resolve ${issue.short_id}\` once handled.`
    ].join('\n');

    try {
      await thread.send({ content: contextBrief });
    } catch (err) {
      console.error('[agent] Failed to send context brief:', err.message);
    }
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
    content: [
      `AGENT escalation — no answer found for: "${userMessage.slice(0, 200)}"`,
      `Issue: ${issue.short_id} | Dept: ${issue.department || 'unassigned'} | Status: ${issue.status}`,
      `Recent context:\n${historyBrief}`
    ].join('\n')
  });
}

module.exports = { runAgent };
