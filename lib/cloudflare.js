const OpenAI = require('openai');

// Native Cloudflare fetch — used for embeddings because the OpenAI-compatible
// endpoint has issues with some embedding models
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run`;
const EMBEDDING_MODEL  = '@cf/baai/bge-large-en-v1.5';
const RERANKER_MODEL   = '@cf/baai/bge-reranker-base';
const INTENT_MODEL     = '@cf/meta/llama-3.1-8b-instruct-fast';
const CHAT_MODEL       = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// Fetch with timeout — prevents cold-start hangs
async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// OpenAI SDK pointed at Cloudflare — only used for chat completions
const cf = new OpenAI({
  apiKey:  process.env.CF_API_TOKEN,
  baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/v1`
});

// Embed using native Cloudflare API (not OpenAI-compatible endpoint)
// Returns a single float array
async function embed(text) {
  const res = await fetchWithTimeout(`${CF_BASE}/${EMBEDDING_MODEL}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      text:    [text.slice(0, 8000)],
      pooling: 'cls'
    })
  }, 10000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cloudflare embed failed: ${res.status} ${err}`);
  }

  const json = await res.json();

  // Native API response: { result: { data: [[...floats...]] } }
  const vector = json?.result?.data?.[0];
  if (!vector || vector.length === 0) {
    throw new Error(`Empty embedding returned. Full response: ${JSON.stringify(json)}`);
  }

  return vector;
}

// Embed multiple strings — returns array of float arrays
async function embedBatch(texts) {
  const res = await fetchWithTimeout(`${CF_BASE}/${EMBEDDING_MODEL}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      text:    texts.map(t => t.slice(0, 8000)),
      pooling: 'cls'
    })
  }, 30000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cloudflare embedBatch failed: ${res.status} ${err}`);
  }

  const json = await res.json();
  const vectors = json?.result?.data;

  if (!vectors || vectors.length === 0) {
    throw new Error(`Empty embeddings returned. Full response: ${JSON.stringify(json)}`);
  }

  return vectors;
}

// Reranker — reads query AND document together for more accurate relevance scores
// Returns array of { index, score } sorted best first (raw logits)
async function rerank(query, documents) {
  const res = await fetchWithTimeout(`${CF_BASE}/${RERANKER_MODEL}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      query,
      contexts: documents.map(d => ({ text: d })),
      top_k:    documents.length
    })
  }, 15000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Reranker failed: ${res.status} ${err}`);
  }

  const json = await res.json();

  // Cloudflare reranker returns: { result: { response: [{id, score}] } }
  // NOT: { result: [{id, score}] }
  const results = json?.result?.response || json?.result || json?.response || [];

  if (!Array.isArray(results) || results.length === 0) {
    console.warn('[rerank] Empty or unexpected response:', JSON.stringify(json).slice(0, 200));
    return [];
  }

  return results;
}

// For intent + rewriter (fast, cheap model)
async function chatFast(systemPrompt, messages) {
  const response = await cf.chat.completions.create({
    model:       INTENT_MODEL,
    temperature: 0.1,
    messages:    [{ role: 'system', content: systemPrompt }, ...messages]
  });
  return response.choices[0].message.content;
}

// For responder (full quality model)
async function chat(systemPrompt, messages) {
  const response = await cf.chat.completions.create({
    model:       CHAT_MODEL,
    temperature: 0.1,
    messages:    [{ role: 'system', content: systemPrompt }, ...messages]
  });
  return response.choices[0].message.content;
}

module.exports = { embed, embedBatch, rerank, chat, chatFast, EMBEDDING_MODEL };
