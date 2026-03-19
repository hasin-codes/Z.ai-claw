const { chat } = require('./cloudflare');

// Reranker scores are sigmoid-normalized [0,1]
// 0.60 filters out neutral/noise results (sigmoid of ~0.4 raw logit)
// Below this, results are indistinguishable from random — passing them poisons LLM context
const THRESHOLD_HIGH = 0.60;

const RESPONDER_PROMPT = `You are a support assistant for our product ONLY.

Issue context:
{ISSUE_SUMMARY}

{RAG_SECTION}

STRICT RULES — follow these without exception:
1. ONLY answer using information from the documentation context provided above.
2. ONLY answer using information from the conversation history.
3. If the question is NOT answerable from the documentation or conversation history — respond with exactly: ESCALATE
4. If the question is about general knowledge unrelated to the product — respond with exactly: ESCALATE
5. If the documentation context is empty or irrelevant — respond with exactly: ESCALATE
6. NEVER use your general training knowledge to answer product questions.
7. NEVER invent features, prices, policies, timelines, or contact details not explicitly stated.
8. Keep answers concise — 2-4 sentences for simple questions.
9. Be friendly and acknowledge frustration briefly if the user seems upset.
10. Do not repeat information already given earlier in the conversation.

When in doubt — ESCALATE. Always better to escalate than to guess.`;

async function callWithRetry(systemPrompt, messages, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await chat(systemPrompt, messages);

      // Guard against null/empty returns
      if (!result || typeof result !== 'string' || !result.trim()) {
        console.warn(`[responder] LLM returned empty/null on attempt ${attempt + 1}`);
        if (attempt === maxRetries) return 'ESCALATE';
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      return result.trim();
    } catch (err) {
      console.error(`[responder] LLM call failed attempt ${attempt + 1}:`, err.message);
      if (attempt === maxRetries) return 'ESCALATE';
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return 'ESCALATE';
}

// needsRagWasAttempted: true if Layer 3 decided to search Qdrant
// This distinguishes "searched and found nothing" from "search was skipped intentionally"
async function generateResponse(userMessage, ragResults, context, needsRagWasAttempted = false) {
  const { history, issueSummary } = context;

  const usableResults = (ragResults || []).filter(r => r.score >= THRESHOLD_HIGH);
  const bestScore = ragResults && ragResults.length > 0
    ? Math.max(...ragResults.map(r => r.score))
    : 0;

  console.log(`[responder] Usable RAG: ${usableResults.length} (best: ${bestScore.toFixed(3)}) | RAG attempted: ${needsRagWasAttempted}`);

  let ragSection;

  // Safety check: if score passed but payload is missing, the reranker mapping is broken
  const payloadMissing = (ragResults || []).filter(r => r.score >= THRESHOLD_HIGH && !r?.payload);
  if (payloadMissing.length > 0) {
    console.error(`[responder] BUG: ${payloadMissing.length} results passed score threshold but have no payload — check reranker mapping (r.id vs r.index)`);
  }

  if (usableResults.length > 0) {
    // Good RAG results — use them
    const contextText = usableResults
      .filter(r => r?.payload)
      .slice(0, 4)
      .map(r => `[From: ${r.payload.source || 'documentation'}]\n${r.payload.content}`)
      .join('\n\n---\n\n');
    ragSection = `Documentation context (use this to answer):\n${contextText}`;

  } else if (needsRagWasAttempted) {
    // RAG was searched but nothing relevant found — knowledge gap, must escalate
    // Do NOT let LLM answer from history or general knowledge
    console.log('[responder] RAG attempted but no usable results — forcing ESCALATE');
    return 'ESCALATE';

  } else if (history.length > 0) {
    // Only use history if it has meaningful content (at least 2 messages)
    // and RAG was intentionally skipped (follow-up, status check)
    if (history.length < 2) {
      console.log('[responder] History too short to answer from — forcing ESCALATE');
      return 'ESCALATE';
    }
    ragSection = `No documentation context needed. Answer from conversation history only. If the question requires product knowledge not in the conversation history, respond with ESCALATE.`;

  } else {
    // No RAG, no history — must escalate
    console.log('[responder] No context at all — forcing ESCALATE');
    return 'ESCALATE';
  }

  const systemPrompt = RESPONDER_PROMPT
    .replace('{ISSUE_SUMMARY}', issueSummary)
    .replace('{RAG_SECTION}', ragSection);

  const messages = [
    ...history.slice(-10),
    { role: 'user', content: userMessage }
  ];

  const answer = await callWithRetry(systemPrompt, messages);
  return answer;
}

module.exports = { generateResponse, THRESHOLD_HIGH };