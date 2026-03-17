const { embed, chat }     = require('./cloudflare');
const { search, COLLECTIONS } = require('./qdrant');
const { pingRoleInThread }    = require('./forward');
const { saveMessage }         = require('./issues');

// Confidence thresholds
const THRESHOLD_ANSWER   = 0.80; // above this → answer directly
const THRESHOLD_CAUTIOUS = 0.65; // above this → answer with caveat
                                  // below this → escalate

const SYSTEM_PROMPT = `You are a support assistant for our product.
Your job is to help users by answering questions based ONLY on the provided context.

Rules you must follow without exception:
1. ONLY answer using information from the context provided below.
2. If the context does not contain enough information to answer, respond with exactly: ESCALATE
3. Never guess, infer, or use knowledge outside the provided context.
4. Keep answers concise and friendly.
5. If you find a relevant answer, cite which document or past case it came from.
6. Never make up features, policies, or procedures that aren't in the context.

Context:
{CONTEXT}`;

async function answerInThread(client, thread, issue, userMessage) {
  let embedding;
  try {
    embedding = await embed(userMessage);
  } catch (err) {
    console.error('[rag] Embedding failed:', err.message);
    return false;
  }

  // Search Tier 1 (docs) — primary source
  let tier1Results = [];
  try {
    tier1Results = await search(COLLECTIONS.docs, embedding, 4);
  } catch (err) {
    console.error('[rag] Tier 1 search failed:', err.message);
  }

  // Search Tier 2 (resolved cases) — secondary source
  // Filter by same department for better relevance
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
  } catch (err) {
    // Tier 2 might be empty in V6 — not an error
    console.log('[rag] Tier 2 search skipped (empty or error):', err.message);
  }

  // Find the best score across both tiers
  const allResults  = [...tier1Results, ...tier2Results];
  const bestScore   = allResults.length > 0
    ? Math.max(...allResults.map(r => r.score))
    : 0;

  console.log(`[rag] Best score: ${bestScore.toFixed(3)} across ${allResults.length} results`);

  // Below threshold — escalate, don't try to answer
  if (bestScore < THRESHOLD_CAUTIOUS || allResults.length === 0) {
    await escalate(client, thread, issue, userMessage);
    return true;
  }

  // Build context string from top results
  const contextParts = allResults
    .filter(r => r.score >= THRESHOLD_CAUTIOUS)
    .slice(0, 5)
    .map(r => {
      const src = r.payload.source || 'documentation';
      return `[Source: ${src}]\n${r.payload.content}`;
    })
    .join('\n\n---\n\n');

  const prompt = SYSTEM_PROMPT.replace('{CONTEXT}', contextParts);

  // Call the LLM
  let answer;
  try {
    answer = await chat(prompt, [
      { role: 'user', content: userMessage }
    ]);
  } catch (err) {
    console.error('[rag] LLM call failed:', err.message);
    await escalate(client, thread, issue, userMessage);
    return true;
  }

  // LLM decided to escalate
  if (answer.trim().toUpperCase().startsWith('ESCALATE')) {
    await escalate(client, thread, issue, userMessage);
    return true;
  }

  // Build the reply based on confidence level
  const lines = [];

  if (bestScore >= THRESHOLD_ANSWER) {
    // High confidence — answer directly
    lines.push(answer);
  } else {
    // Medium confidence — answer with caveat
    lines.push(answer);
    lines.push('');
    lines.push(`*Based on a similar past case — if this doesn't match your situation exactly, a team member can help further.*`);
  }

  // Send answer in thread
  try {
    const msg = await thread.send({ content: lines.join('\n') });

    // Save bot response to issue_messages
    await saveMessage({
      issueId:      issue.id,
      role:         'assistant',
      content:      answer,
      discordMsgId: msg.id
    });
  } catch (err) {
    console.error('[rag] Failed to send answer in thread:', err.message);
  }

  return true;
}

async function escalate(client, thread, issue, userMessage) {
  console.log(`[rag] Escalating issue ${issue.short_id} — no answer found`);

  // Tell user what's happening — transparently
  const userLines = [
    `I wasn't able to find a clear answer to your question in our documentation or past cases.`,
    ``,
    `I've flagged this for a team member who will follow up here shortly.`
  ];

  try {
    await thread.send({ content: userLines.join('\n') });
  } catch (err) {
    console.error('[rag] Failed to send escalation message to user:', err.message);
  }

  // Ping role inside thread with context
  await pingRoleInThread(client, thread, issue, 'escalation');

  // Save escalation to messages
  await saveMessage({
    issueId: issue.id,
    role:    'system',
    content: `RAG escalation — no answer found for: "${userMessage}"`
  });
}

module.exports = { answerInThread };
