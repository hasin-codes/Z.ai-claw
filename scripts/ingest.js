require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { embedBatch }          = require('../lib/cloudflare');
const { upsert, ensureCollection, COLLECTIONS } = require('../lib/qdrant');
const { v4: uuidv4 }          = require('uuid');

const DOCS_DIR    = path.join(__dirname, '../docs');
const CHUNK_SIZE  = 400;  // words per chunk
const CHUNK_OVERLAP = 50; // word overlap between chunks

function chunkText(text, size, overlap) {
  const words  = text.split(/\s+/);
  const chunks = [];

  for (let i = 0; i < words.length; i += (size - overlap)) {
    const chunk = words.slice(i, i + size).join(' ');
    if (chunk.trim().length > 50) { // skip tiny chunks
      chunks.push(chunk);
    }
    if (i + size >= words.length) break;
  }

  return chunks;
}

async function ingestFile(filePath) {
  const filename = path.basename(filePath);
  const raw      = fs.readFileSync(filePath, 'utf8');

  console.log(`\nIngesting: ${filename} (${raw.length} chars)`);

  const chunks = chunkText(raw, CHUNK_SIZE, CHUNK_OVERLAP);
  console.log(`  → ${chunks.length} chunks`);

  if (chunks.length === 0) {
    console.log(`  → Skipped (no content)`);
    return;
  }

  // Embed all chunks in one batch call
  const embeddings = await embedBatch(chunks);

  // Build Qdrant points
  const points = chunks.map((chunk, i) => ({
    id:      uuidv4(),
    vector:  embeddings[i],
    payload: {
      content:  chunk,
      source:   filename,
      chunk_index: i,
      ingested_at: new Date().toISOString()
    }
  }));

  await upsert(COLLECTIONS.docs, points);
  console.log(`  → Upserted ${points.length} points into Qdrant`);
}

async function main() {
  console.log('Starting doc ingestion...');

  // Make sure the collection exists
  await ensureCollection(COLLECTIONS.docs);

  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    console.log(`Created /docs folder — add your markdown files there and run again`);
    return;
  }

  const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));

  if (files.length === 0) {
    console.log('No .md files found in /docs — add some and run again');
    return;
  }

  for (const file of files) {
    await ingestFile(path.join(DOCS_DIR, file));
  }

  console.log('\nIngestion complete.');
}

main().catch(err => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
