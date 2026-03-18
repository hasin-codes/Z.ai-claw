// lib/rewriter.js
const { chat } = require('./cloudflare');

const REWRITER_PROMPT = `You are a search query optimizer for a product support knowledge base.

Given a user message and recent conversation history, output a JSON object with:
- "query": a clean semantic search query (or null if no search needed)
- "needsRag": true or false
- "reason": one short sentence explaining your decision

Rules for needsRag: false (do NOT search):
- Message is a status check ("any update?", "when will this be fixed?")
- Message is conversational follow-up to something already answered
- Message is clarification of something already in the conversation
- Message asks about their specific issue (not general product questions)

Rules for needsRag: true (DO search):
- Message asks a general product question (features, pricing, how-to, policies)
- Message describes a problem and needs solution from docs
- Message asks about something not yet discussed in the conversation

Query optimization rules:
- Remove emotional language ("frustrated", "annoying", "please")
- Remove filler ("I want to know", "can you tell me", "I was wondering")  
- Resolve pronouns using conversation history ("it" → the actual thing)
- Keep technical terms, product names, action verbs
- Output 3-8 words maximum
- Use noun phrases not full sentences

Example inputs and outputs:
User: "what payment methods do you accept?"
History: []
Output: {"query": "accepted payment methods", "needsRag": true, "reason": "General product question about payments"}

User: "ugh still having the same problem as before"
History: [{"role":"user","content":"my login keeps failing"}, {"role":"assistant","content":"..."}]
Output: {"query": "login failure authentication error", "needsRag": true, "reason": "Complaint about login issue needing docs"}

User: "any update on my issue?"
History: [...]
Output: {"query": null, "needsRag": false, "reason": "Status check, not a knowledge question"}

User: "ok thanks that makes sense"
History: [...]
Output: {"query": null, "needsRag": false, "reason": "Conversational acknowledgement"}

User: "when does the refund come through?"
History: [{"role":"assistant","content":"Refunds take 5-10 business days..."}]
Output: {"query": null, "needsRag": false, "reason": "Already answered in conversation"}

Respond with ONLY valid JSON. No markdown, no explanation outside the JSON.`;

async function rewriteQuery(userMessage, history) {
  const historyText = history
    .slice(-6) // last 6 messages for context
    .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
    .join('\n');

  const input = `Conversation history:\n${historyText || '(none)'}\n\nUser message: ${userMessage}`;

  try {
    const result = await chat(REWRITER_PROMPT, [
      { role: 'user', content: input }
    ]);

    // Parse JSON — handle if LLM wraps in markdown code blocks
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed  = JSON.parse(cleaned);

    // Validate shape
    if (typeof parsed.needsRag !== 'boolean') parsed.needsRag = true;
    if (parsed.needsRag && !parsed.query)     parsed.query = userMessage.slice(0, 100);

    console.log(`[rewriter] needsRag: ${parsed.needsRag} | query: "${parsed.query}" | reason: ${parsed.reason}`);
    return parsed;

  } catch (err) {
    console.error('[rewriter] Failed:', err.message);
    // Safe fallback: search with raw message
    return {
      query:    userMessage.slice(0, 100),
      needsRag: true,
      reason:   'Fallback — rewriter failed'
    };
  }
}

module.exports = { rewriteQuery };
