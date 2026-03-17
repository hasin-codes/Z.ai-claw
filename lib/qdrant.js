const { QdrantClient } = require('@qdrant/js-client-rest');

const client = new QdrantClient({
  url:    process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY
});

const COLLECTIONS = {
  docs:      'docs_chunks',
  cases:     'resolved_cases',
  tribal:    'tribal_knowledge',
  community: 'community_knowledge'
};

// Qwen3-embedding-0.6b outputs 1024 dimensions
const VECTOR_SIZE = 1024;

async function ensureCollection(name, silent = false) {
  try {
    await client.getCollection(name);
    if (!silent) console.log(`[qdrant] Collection "${name}" already exists`);
  } catch {
    await client.createCollection(name, {
      vectors: {
        size:     VECTOR_SIZE,
        distance: 'Cosine'
      }
    });
    if (!silent) console.log(`[qdrant] Collection "${name}" created`);
  }
}

// Delete and recreate collection with correct vector size
async function resetCollection(name, silent = false) {
  try {
    await client.deleteCollection(name);
    if (!silent) console.log(`[qdrant] Collection "${name}" deleted`);
  } catch (err) {
    if (!silent) console.log(`[qdrant] Collection "${name}" did not exist`);
  }
  await ensureCollection(name, silent);
}

async function upsert(collectionName, points) {
  await client.upsert(collectionName, {
    wait:   true,
    points
  });
}

async function search(collectionName, vector, limit = 5, filter = null) {
  const params = { vector, limit, with_payload: true };
  if (filter) params.filter = filter;
  const results = await client.search(collectionName, params);
  return results;
}

async function initCollections() {
  for (const name of Object.values(COLLECTIONS)) {
    await ensureCollection(name);
  }
}

module.exports = {
  client,
  COLLECTIONS,
  VECTOR_SIZE,
  ensureCollection,
  resetCollection,
  upsert,
  search,
  initCollections
};