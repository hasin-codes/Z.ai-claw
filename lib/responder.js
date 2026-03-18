// lib/responder.js
const { chat } = require('./cloudflare');

const RESPONDER_PROMPT = `You are a friendly and knowledgeable support assistant for our product.

Issue context:
{ISSUE_SUMMARY}

{RAG_SECTION}

Instructions:
1. Answer the user's question using the documentation context provided above.
2. You may also use information from the conversation history.
3. If the answer is NOT in the documentation or conversation history, respond with exactly: ESCALATE
4. Never invent product features, policies, prices, or procedures not in the context.
5. Keep answers concise (2-4 sentences max for simple questions).
6. Be friendly and human — not robotic.
7. If the user is frustrated, acknowledge their frustration briefly before answering.
8. Do not repeat information already given earlier in the conversation.`;

const THRESHOLD_HIGH = 0.65; // above this → answer directly
// Note: no "medium confidence" tier needed — rewriter handles ambiguous cases

async function generateResponse(userMessage, ragResults, context) {
  const { history, issueSummary } = context;

  // Build RAG section
  let ragSection = '';
  if (ragResults && ragResults.length > 0) {
    const topResults = ragResults
      .filter(r => r.score >= THRESHOLD_HIGH)
      .slice(0, 4);

    if (topResults.length > 0) {
      const contextText = topResults
        .map(r => `[From: ${r.payload.source || 'documentation'}]\n${r.payload.content}`)
        .join('\n\n---\n\n');
      ragSection = `Documentation context:\n${contextText}`;
    }
  }

  // If no usable RAG results — still try to answer from conversation
  // history (the LLM will ESCALATE if it truly can't answer)
  if (!ragSection) {
    ragSection = '(No documentation context available for this query — answer from conversation history only, or ESCALATE if not possible)';
  }

  const systemPrompt = RESPONDER_PROMPT
    .replace('{ISSUE_SUMMARY}', issueSummary)
    .replace('{RAG_SECTION}', ragSection);

  // Build messages array: history + current message
  const messages = [
    ...history.slice(-10), // last 10 messages as context window
    { role: 'user', content: userMessage }
  ];

  try {
    const answer = await chat(systemPrompt, messages);
    return answer.trim();
  } catch (err) {
    console.error('[responder] LLM call failed:', err.message);
    return 'ESCALATE';
  }
}

module.exports = { generateResponse, THRESHOLD_HIGH };
