require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { embedBatch }                       = require('../lib/cloudflare');
const { upsert, ensureCollection, COLLECTIONS, VECTOR_SIZE } = require('../lib/qdrant');
const { v4: uuidv4 }                       = require('uuid');

const DOCS_DIR      = path.join(__dirname, '../docs');

// Split by markdown headers for better semantic chunking
function chunkBySections(text) {
  const sections = [];
  const lines = text.split('\n');
  let currentSection = '';
  let currentHeader = '';
  
  for (const line of lines) {
    // Detect markdown headers (## or ###)
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    
    if (headerMatch) {
      // Save previous section if it has content
      if (currentSection.trim().length > 50) {
        sections.push(currentSection.trim());
      }
      currentSection = line + '\n';
      currentHeader = headerMatch[2];
    } else {
      currentSection += line + '\n';
    }
  }
  
  // Don't forget the last section
  if (currentSection.trim().length > 50) {
    sections.push(currentSection.trim());
  }
  
  return sections;
}

// Legacy chunking for non-markdown files
function chunkText(text, size, overlap) {
  const words  = text.split(/\s+/);
  const chunks = [];

  for (let i = 0; i < words.length; i += (size - overlap)) {
    const chunk = words.slice(i, i + size).join(' ');
    if (chunk.trim().length > 50) {
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

  // Use section-based chunking for markdown files
  const chunks = filename.endsWith('.md') 
    ? chunkBySections(raw) 
    : chunkText(raw, 400, 50);
  console.log(`  → ${chunks.length} chunks`);

  if (chunks.length === 0) {
    console.log(`  → Skipped (no content)`);
    return;
  }

  // Embed all chunks
  console.log(`  → Embedding ${chunks.length} chunks via Cloudflare...`);
  let embeddings;
  try {
    embeddings = await embedBatch(chunks);
  } catch (err) {
    console.error(`  → Embedding failed:`, err.message);
    throw err;
  }

  // Verify dimensions match what Qdrant expects
  const actualDim = embeddings[0]?.length;
  if (actualDim !== VECTOR_SIZE) {
    console.error(`  → Dimension mismatch! Got ${actualDim}, expected ${VECTOR_SIZE}`);
    console.error(`  → Update VECTOR_SIZE in lib/qdrant.js to ${actualDim} and re-run`);
    throw new Error(`Vector dimension mismatch: got ${actualDim}, expected ${VECTOR_SIZE}`);
  }

  console.log(`  → Vector dimensions: ${actualDim} ✓`);

  const points = chunks.map((chunk, i) => ({
    id:      uuidv4(),
    vector:  embeddings[i],
    payload: {
      content:     chunk,
      source:      filename,
      chunk_index: i,
      ingested_at: new Date().toISOString()
    }
  }));

  await upsert(COLLECTIONS.docs, points);
  console.log(`  → Upserted ${points.length} points into Qdrant ✓`);
}

async function main() {
  console.log('Starting doc ingestion...');
  console.log(`Qdrant URL: ${process.env.QDRANT_URL}`);
  console.log(`CF Account: ${process.env.CF_ACCOUNT_ID ? 'set' : 'MISSING'}`);
  console.log(`CF Token:   ${process.env.CF_API_TOKEN ? 'set' : 'MISSING'}`);

  // Ensure collection exists before upserting
  await ensureCollection(COLLECTIONS.docs);

  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    console.log(`\nCreated /docs folder — add your .md files there and run again`);
    return;
  }

  const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));

  if (files.length === 0) {
    console.log('\nNo .md files found in /docs — add some and run again');
    return;
  }

  console.log(`\nFound ${files.length} file(s): ${files.join(', ')}`);

  for (const file of files) {
    await ingestFile(path.join(DOCS_DIR, file));
  }

  console.log('\nIngestion complete ✓');
}

main().catch(err => {
  console.error('\nIngestion failed:', err.message);
  process.exit(1);
});