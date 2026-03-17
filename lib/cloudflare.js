const OpenAI = require('openai');

const cf = new OpenAI({
  apiKey:  process.env.CF_API_TOKEN,
  baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/v1`
});

const EMBEDDING_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
const CHAT_MODEL      = '@cf/qwen/qwen3-30b-a3b-fp8';

// Embed a single string — returns a float array
async function embed(text) {
  const response = await cf.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000) // safety trim
  });
  return response.data[0].embedding;
}

// Embed multiple strings in one call — returns array of float arrays
async function embedBatch(texts) {
  const response = await cf.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map(t => t.slice(0, 8000))
  });
  return response.data.map(d => d.embedding);
}

// Chat completion with strict system prompt
async function chat(systemPrompt, messages) {
  const response = await cf.chat.completions.create({
    model:       CHAT_MODEL,
    temperature: 0.1, // low temp = more deterministic, less hallucination
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ]
  });
  return response.choices[0].message.content;
}

module.exports = { embed, embedBatch, chat, EMBEDDING_MODEL };
