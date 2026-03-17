const { embed, chat }          = require('./cloudflare');
const { search, COLLECTIONS }  = require('./qdrant');
const { pingRoleInThread }     = require('./forward');
const { saveMessage }          = require('./issues');
const supabase                 = require('./supabase');

const THRESHOLD_ANSWER   = 0.80;
const THRESHOLD_CAUTIOUS = 0.40; // lowered — qwen3-embedding scores are typically lower

// Casual messages the bot should respond to directly without hitting RAG
const CASUAL_PATTERNS = [
  { pattern: /^(hi|hey|hello|hiya|heya|howdy|sup|yo)\b/i,
    reply: `Hey! I'm here to help. What can I assist you with today?` },
  { pattern: /^(thanks|thank you|thx|ty|cheers|appreciate it|great|awesome|perfect|got it|ok|okay|sounds good|noted|sure)\b/i,
    reply: `You're welcome! Let me know if there's anything else I can help with.` },
  { pattern: /^(bye|goodbye|see you|cya|later|ttyl)\b/i,
    reply: `Goodbye! If your issue isn't resolved yet, a team member will follow up here.` },
  { pattern: /^(good morning|good afternoon|good evening|good night)\b/i,
    reply: `Hello! How can I help you today?` },
];

const SYSTEM_PROMPT = `You are a friendly support assistant for our product.
You help users by answering their questions based on the provided context.
You can also respond naturally to greetings and casual messages.

Rules:
1. For questions about the product, ONLY answer using the provided context.
2. If the context does not contain enough information to answer a product question, respond with exactly: ESCALATE
3. For greetings, thanks, or casual messages, respond naturally and warmly.
4. Never make up product features, policies, or procedures not in the context.
5. Keep answers concise and friendly.

Context:
{CONTEXT}`;

async function hasBeenEscalated(issueId) {
  const { data } = await supabase
    .from('issue_messages')
    .select('id')
    .eq('issue_id', issueId)
    .eq('role', 'system')
    .ilike('content', 'RAG escalation%')
    .limit(1);

  return data && data.length > 0;
}

async function answerInThread(client, thread, issue, userMessage) {

  // Handle casual messages directly — no need to hit RAG
  for (const { pattern, reply } of CASUAL_PATTERNS) {
    if (pattern.test(userMessage.trim())) {
      try {
        const msg = await thread.send({ content: reply });
        await saveMessage({
          issueId:      issue.id,
          role:         'assistant',
          content:      reply,
          discordMsgId: msg.id
        });
      } catch (err) {
        console.error('[rag] Failed to send casual reply:', err.message);
      }
      return true;
    }
  }

  // Everything else goes through RAG
  let embedding;
  try {
    embedding = await embed(userMessage);
  } catch (err) {
    console.error('[rag] Embedding failed:', err.message);
    return false;
  }

  // Search Tier 1 — docs
  let tier1Results = [];
  try {
    tier1Results = await search(COLLECTIONS.docs, embedding, 4);
  } catch (err) {
    console.error('[rag] Tier 1 search failed:', err.message);
  }

  // Search Tier 2 — resolved cases (may be empty in V6)
  let tier2Results = [];
  try {
    tier2Results = await search(
      COLLECTIONS.cases,
      embedding,
      3,
      issue.department ? {
        must: [{ key: 'department', match: { value: issue.department } }]
      } : null
    );
  } catch {
    // Empty in V6 — not an error
  }

  const allResults = [...tier1Results, ...tier2Results];
  const bestScore  = allResults.length > 0
    ? Math.max(...allResults.map(r => r.score))
    : 0;

  console.log(`[rag] ${issue.short_id} — best score: ${bestScore.toFixed(3)} (${allResults.length} results)`);

  if (bestScore < THRESHOLD_CAUTIOUS || allResults.length === 0) {
    await escalate(client, thread, issue, userMessage);
    return true;
  }

  // Build context from top results
  const contextParts = allResults
    .filter(r => r.score >= THRESHOLD_CAUTIOUS)
    .slice(0, 5)
    .map(r => `[Source: ${r.payload.source || 'documentation'}]\n${r.payload.content}`)
    .join('\n\n---\n\n');

  const prompt = SYSTEM_PROMPT.replace('{CONTEXT}', contextParts);

  let answer;
  try {
    answer = await chat(prompt, [{ role: 'user', content: userMessage }]);
  } catch (err) {
    console.error('[rag] LLM call failed:', err.message);
    await escalate(client, thread, issue, userMessage);
    return true;
  }

  if (answer.trim().toUpperCase().startsWith('ESCALATE')) {
    await escalate(client, thread, issue, userMessage);
    return true;
  }

  const lines = [answer];
  if (bestScore < THRESHOLD_ANSWER) {
    lines.push('');
    lines.push(`*Based on a similar past case — if this doesn't match your situation exactly, a team member can help further.*`);
  }

  try {
    const msg = await thread.send({ content: lines.join('\n') });
    await saveMessage({
      issueId:      issue.id,
      role:         'assistant',
      content:      answer,
      discordMsgId: msg.id
    });
  } catch (err) {
    console.error('[rag] Failed to send answer:', err.message);
  }

  return true;
}

async function escalate(client, thread, issue, userMessage) {
  console.log(`[rag] Escalating ${issue.short_id}`);

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
      console.error('[rag] Failed to send escalation message:', err.message);
    }

    await pingRoleInThread(client, thread, issue, 'escalation');
  } else {
    try {
      await thread.send({
        content: `I still don't have an answer for that in my documentation. A team member has already been notified and will assist you shortly.`
      });
    } catch (err) {
      console.error('[rag] Failed to send follow-up message:', err.message);
    }
  }

  await saveMessage({
    issueId: issue.id,
    role:    'system',
    content: `RAG escalation — no answer found for: "${userMessage.slice(0, 200)}"`
  });
}

module.exports = { answerInThread };