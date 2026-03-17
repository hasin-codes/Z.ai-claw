const { QdrantClient } = require('@qdrant/js-client-rest');

const client = new QdrantClient({
  url:    process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY
});

// Collection names — one per tier
const COLLECTIONS = {
  docs:     'docs_chunks',       // Tier 1 — your markdown docs
  cases:    'resolved_cases',    // Tier 2 — resolved issue summaries (V7)
  tribal:   'tribal_knowledge',  // Tier 3 — staff solutions (V8)
  community:'community_knowledge' // V8 — bad-report channel indexing
};

const VECTOR_SIZE = 1024; // Qwen3-embedding-0.6b output dimension

// Create a collection if it doesn't exist
async function ensureCollection(name) {
  try {
    await client.getCollection(name);
    console.log(`[qdrant] Collection "${name}" already exists`);
  } catch {
    await client.createCollection(name, {
      vectors: {
        size:     VECTOR_SIZE,
        distance: 'Cosine'
      }
    });
    console.log(`[qdrant] Collection "${name}" created`);
  }
}

// Upsert points into a collection
async function upsert(collectionName, points) {
  await client.upsert(collectionName, {
    wait:   true,
    points
  });
}

// Search a collection — returns top K results with scores
async function search(collectionName, vector, limit = 5, filter = null) {
  const params = { vector, limit, with_payload: true };
  if (filter) params.filter = filter;

  const results = await client.search(collectionName, params);
  return results;
}

// Initialize all collections on startup
async function initCollections() {
  for (const name of Object.values(COLLECTIONS)) {
    await ensureCollection(name);
  }
}

module.exports = { client, COLLECTIONS, upsert, search, initCollections };
