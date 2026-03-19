// lib/rewriter.js
const { chatFast } = require('./cloudflare');

// ── Rewrite-only prompt (no history context, empty history path) ──────────────
// No examples — examples teach the model wrong vocabulary
// Pure instruction-based with strict constraints
const REWRITE_ONLY_PROMPT = `You are a search query extractor for a product support knowledge base.

Extract the searchable core from the user message. Remove noise while keeping the specific terms that would appear in documentation.

PRESERVE — these are critical for matching:
- Error codes (429, 1113, 1302, 401, etc.)
- Product terms (coding plan, API key, subscription, pay-as-you-go, quota, etc.)
- Feature names (rate limit, billing, auto-renewal, refund, endpoint, etc.)
- Technical terms (authentication, embedding, token consumption, etc.)

STRIP — these hurt matching:
- Frustration and emotion ("this is unacceptable", "so annoying")
- Filler words ("man", "like", "basically", "just")
- Pleasantries ("hey", "thanks", "please help")
- Redundancy and repetition

Rules:
- Output ONLY the extracted search phrase. Nothing else.
- No explanations, no parenthetical notes, no meta-commentary, no prefixes.
- 4 to 12 words maximum — be descriptive enough for the reranker to match
- Multiple topics → pick the FIRST topic only, ignore the rest`;

// ── Full rewriter prompt (has conversation history) ───────────────────────────
const REWRITER_PROMPT = `You are a search decision engine for a product support system.

Given a user message and conversation history, decide:
1. Does this need a knowledge base search? (needsRag)
2. If yes, what phrase should be searched?

Output ONLY a JSON object. No explanation, no markdown.

JSON format:
{"query": "phrase here or null", "needsRag": true or false, "reason": "one sentence"}

Decision rules for needsRag false — do NOT search:
- The user is asking about their specific ticket status or timeline
- The exact question was already answered in the conversation history
- The message is a greeting, acknowledgement, or casual reply

Decision rules for needsRag true — DO search:
- The user asks about product features, pricing, or policies
- The user describes a problem or error they are experiencing
- The question has not been answered yet in the conversation

Query generation rules when needsRag is true:
- Extract the searchable core from the user message — preserve specific terms
- KEEP: error codes, product terms, feature names, technical terms
- STRIP: frustration, filler words, pleasantries, redundancy
- 4 to 12 words maximum — be descriptive enough for the reranker to match
- Focus on the core topic only`;

// ── Robust JSON extractor ─────────────────────────────────────────────────────
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  let jsonStr = text.slice(start, end + 1);
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// ── Null-safe chatFast call ───────────────────────────────────────────────────
async function safeChatFast(prompt, messages, fallback) {
  try {
    const result = await chatFast(prompt, messages);
    if (!result || typeof result !== 'string' || !result.trim()) {
      console.warn('[rewriter] LLM returned empty — using fallback');
      return fallback;
    }
    return result.trim();
  } catch (err) {
    console.error('[rewriter] chatFast failed:', err.message);
    return fallback;
  }
}

// ── Strip contact-method contamination from any query ────────────────────────
function cleanQuery(query) {
  if (!query) return query;
  return query
    // Strip markdown formatting (bold, italic) that wraps prefixes
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    // Strip ALL known LLM prefix variants — exhaustive list
    .replace(/^here\s+is\s+(?:the\s+)?(?:extracted\s+)?(?:search\s+)?(?:phrase|query|keywords?)\s*[:\-–]\s*\*{0,2}/i, '')
    .replace(/^(extracted\s+search\s+phrase|search\s+phrase|query|keywords?|search)\s*[:\-–]\s*\*{0,2}/i, '')
    // Strip parenthetical meta-commentary: "(Note: ...", "(I've ...", etc.
    .replace(/\s*\([^)]*(?:note|removed|stripped|focused|extracted|filtered|kept|based)[^)]*\).*$/i, '')
    // Strip stray leading/trailing quotes (matched or unmatched)
    .replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, '')
    .replace(/\bdiscord\b/gi, '')
    .replace(/\/report\b/gi, '')
    .replace(/\bemail\b/gi, '')
    .replace(/\bphone\b/gi, '')
    .replace(/\blive chat\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Degenerate queries that mean "nothing to search for"
const DEGENERATE_QUERIES = /^(no (?:relevant )?(?:terms|search phrase|phrase)|nothing to search|n\/a|null|none|not applicable)$/i;

// Check if the rewriter output shares at least one content word with the original message
// Catches hallucinations where the rewriter outputs an unrelated topic
function hasOverlap(query, originalMessage) {
  const STOP = new Set(['the','a','an','is','are','was','were','be','been','do','does','did','have','has','had',
    'i','my','me','we','you','your','it','its','this','that','what','how','why','when','where','can','could',
    'would','should','will','to','of','in','on','for','and','or','but','if','so','not','no','with','from',
    'at','by','up','out','just','also','still','only','very','too','than','then','about','into','over','after',
    'get','got','getting','keep','keeps','going','go','make','made','put','set','use','using','used']);
  const queryWords = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 1 && !STOP.has(w)));
  const msgWords = new Set(originalMessage.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !STOP.has(w)));
  for (const w of queryWords) {
    if (msgWords.has(w)) return true;
    // Also check if query word is a substring of any msg word (handles "referral" matching "referral")
  }
  return false;
}

// ── Empty history path — always searches, no JSON overhead ───────────────────
async function rewriteQueryOnly(userMessage) {
  const result = await safeChatFast(
    REWRITE_ONLY_PROMPT,
    [{ role: 'user', content: userMessage.slice(0, 500) }],
    userMessage.slice(0, 100)
  );

  let query = cleanQuery(
    result
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/[.!?]$/, '')
      .trim()
      .slice(0, 120)
  );

  // If rewriter produced a degenerate "no match" response, skip search
  if (!query || DEGENERATE_QUERIES.test(query)) {
    console.log(`[rewriter] rewriteQueryOnly -> degenerate "${query}", skipping search`);
    return { query: null, needsRag: false, reason: 'No extractable terms' };
  }

  // If rewriter output is too short (< 2 words), it's useless for matching
  // Single-word queries like "quota" never score well enough
  const wordCount = query.split(/\s+/).length;
  if (wordCount < 2) {
    const fallback = userMessage
      .replace(/[?.!]+$/, '')
      .trim()
      .split(/\s+/)
      .slice(0, 12)
      .join(' ');
    console.log(`[rewriter] rewriteQueryOnly -> too short (${wordCount} words), fallback: "${fallback}"`);
    return { query: fallback, needsRag: true, reason: 'Rewriter too short — using original' };
  }

  // If rewriter hallucinated an unrelated topic, fall back to original message
  if (!hasOverlap(query, userMessage)) {
    const fallback = userMessage
      .replace(/[?.!]+$/, '')
      .trim()
      .split(/\s+/)
      .slice(0, 12)
      .join(' ');
    console.log(`[rewriter] rewriteQueryOnly -> no overlap with input, fallback: "${fallback}"`);
    return { query: fallback, needsRag: true, reason: 'Rewriter hallucinated — using original' };
  }

  console.log(`[rewriter] rewriteQueryOnly -> "${query}"`);
  return { query, needsRag: true, reason: 'No history — must search docs' };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function rewriteQuery(userMessage, history, intent = 'QUESTION') {

  // No history — must search, use lightweight single-output rewrite
  if (history.length === 0 && ['QUESTION', 'COMPLAINT', 'UNCLEAR'].includes(intent)) {
    return rewriteQueryOnly(userMessage);
  }

  // Has history — use full JSON rewriter to decide if search is needed
  const historyText = history
    .slice(-6)
    .map(m => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${m.content.slice(0, 150)}`)
    .join('\n');

  const input = [
    'Conversation so far:',
    historyText || '(none)',
    '',
    `New message: ${userMessage.slice(0, 400)}`
  ].join('\n');

  const raw = await safeChatFast(
    REWRITER_PROMPT,
    [{ role: 'user', content: input }],
    null
  );

  if (!raw) {
    return { query: userMessage.slice(0, 100), needsRag: true, reason: 'LLM failed — fallback' };
  }

  const parsed = extractJSON(raw);
  if (!parsed) {
    console.warn('[rewriter] JSON parse failed — searching with raw message');
    return { query: userMessage.slice(0, 100), needsRag: true, reason: 'JSON parse failed' };
  }

  // Normalize null values
  if (parsed.query === 'null' || parsed.query === '' || parsed.query === null) {
    parsed.query = null;
  }
  if (typeof parsed.needsRag !== 'boolean') parsed.needsRag = true;
  if (parsed.needsRag && !parsed.query) parsed.query = userMessage.slice(0, 100);

  // Clean contamination from query
  if (parsed.query) {
    parsed.query = cleanQuery(parsed.query) || userMessage.slice(0, 100);
  }

  // If rewriter produced a degenerate "no match" response, skip search
  if (parsed.query && DEGENERATE_QUERIES.test(parsed.query)) {
    parsed.query = null;
    parsed.needsRag = false;
  }

  console.log(`[rewriter] needsRag: ${parsed.needsRag} | query: "${parsed.query}" | reason: ${parsed.reason}`);
  return parsed;
}

module.exports = { rewriteQuery };