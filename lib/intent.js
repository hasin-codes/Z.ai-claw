// lib/intent.js
const { chatFast } = require('./cloudflare');

const INTENT_PROMPT = `You are an intent classifier for a product support system.
Classify the user message into exactly one of these intents:

CASUAL - greetings, thanks, acknowledgements, small talk
QUESTION - asking about product features, pricing, how things work, documentation
COMPLAINT - reporting something broken, expressing frustration about a bug or issue
STATUS - asking about status of their specific issue, when it will be fixed, any updates
UNCLEAR - too vague or ambiguous to classify

Respond with ONLY the intent word. Nothing else. No explanation.

Examples:
"hi there" → CASUAL
"thanks!" → CASUAL
"how do I reset my password?" → QUESTION
"what payment methods do you accept?" → QUESTION
"my app keeps crashing" → COMPLAINT
"this is so frustrating, nothing works" → COMPLAINT
"any update on my issue?" → STATUS
"when will this be fixed?" → STATUS
"ok" → CASUAL
"..." → UNCLEAR`;

const CASUAL_REPLIES = {
  greeting: [
    "Hey! I'm here to help. What can I assist you with?",
    "Hello! How can I help you today?",
    "Hi there! What's going on?"
  ],
  thanks: [
    "You're welcome! Let me know if there's anything else I can help with.",
    "Happy to help! Anything else?",
    "Of course! Feel free to ask if you need anything else."
  ],
  bye: [
    "Goodbye! If your issue isn't resolved yet, a team member will follow up.",
    "Take care! We'll keep working on your issue."
  ],
  general: [
    "Got it! Let me know if you have any questions.",
    "Understood. I'm here if you need anything."
  ]
};

function getCasualReply(message) {
  const lower = message.toLowerCase().trim();
  if (/^(hi|hey|hello|hiya|heya|howdy|sup|yo|greetings)\b/.test(lower)) {
    const replies = CASUAL_REPLIES.greeting;
    return replies[Math.floor(Math.random() * replies.length)];
  }
  if (/^(bye|goodbye|see you|cya|later|ttyl|gotta go)\b/.test(lower)) {
    const replies = CASUAL_REPLIES.bye;
    return replies[Math.floor(Math.random() * replies.length)];
  }
  if (/^(thanks|thank you|thx|ty|cheers|appreciate|grateful)\b/.test(lower)) {
    const replies = CASUAL_REPLIES.thanks;
    return replies[Math.floor(Math.random() * replies.length)];
  }
  const replies = CASUAL_REPLIES.general;
  return replies[Math.floor(Math.random() * replies.length)];
}

async function classifyIntent(message) {
  // Fast path: very short messages are almost always CASUAL
  // Avoids LLM call for obvious cases
  const trimmed = message.trim();
  if (trimmed.length <= 6) {
    return { intent: 'CASUAL', reply: getCasualReply(trimmed) };
  }

  // Fast-path: vague "facing a problem" style messages with no specifics → UNCLEAR
  if (/^(but\s+)?(i[' ]?m\s+)?(facing|having|experiencing)\s+(a\s+)?(bigger|different|another|new|serious|major|other)\s+problem/i.test(trimmed)) {
    return { intent: 'UNCLEAR', reply: null };
  }

  let intent;
  try {
    const result = await chatFast(INTENT_PROMPT, [
      { role: 'user', content: trimmed }
    ]);

    // Guard against null/empty LLM response
    if (!result || typeof result !== 'string' || !result.trim()) {
      console.warn('[intent] LLM returned empty/null — defaulting to QUESTION');
      intent = 'QUESTION';
    } else {
      intent = result.trim().toUpperCase().split(/\s+/)[0];
      if (!['CASUAL', 'QUESTION', 'COMPLAINT', 'STATUS', 'UNCLEAR'].includes(intent)) {
        intent = 'QUESTION';
      }
    }
  } catch (err) {
    console.error('[intent] Classification failed:', err.message);
    intent = 'QUESTION';
  }

  const reply = intent === 'CASUAL' ? getCasualReply(trimmed) : null;
  return { intent, reply };
}

module.exports = { classifyIntent };
