// Prevent EPIPE crashes on Windows when stdout pipe breaks
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { embedBatch }                                          = require('../lib/cloudflare');
const { upsert, ensureCollection, resetCollection, COLLECTIONS, VECTOR_SIZE, client } = require('../lib/qdrant');
const { v4: uuidv4 }                                         = require('uuid');

const DOCS_DIR        = path.join(__dirname, '../docs');
const MAX_CHUNK_WORDS = 300;   // safety net for sub-splitting long sections
const MIN_CHUNK_CHARS = 60;
const EMBED_BATCH     = 20;

// ─── Chunking ─────────────────────────────────────────────────────────────────
//
// Docs follow a clean schema:
//   # Title — Knowledge Base      ← document context (H1 only)
//   ---
//   ## Question title?            ← one chunk per section
//   **Problem description:** ...
//   **Solution:** ...
//   ---
//
// Strategy: split on ## headers. For each section, extract the
// QUESTION signal (title + problem description) separately from
// the ANSWER (solution). Embed only the question signal so vector
// search matches on what users actually say. Store the full
// section + solution in payload for the LLM and reranker.

function parseSection(header, body, docContext) {
  const problemMatch  = body.match(/\*\*Problem description:\*\*\s*([\s\S]*?)(?=\*\*Solution:\*\*|$)/);
  const solutionMatch = body.match(/\*\*Solution:\*\*\s*([\s\S]*?)$/);

  const problem  = (problemMatch?.[1] || '').trim();
  const solution = (solutionMatch?.[1] || '').trim();

  // What to embed: question + problem description
  // This is what the user would naturally say — maximizes retrieval signal
  const embedText = [
    `## ${header}`,
    problem
  ].filter(Boolean).join('\n');

  // What the LLM sees: full section with doc context for accurate answers
  const fullSection = docContext + '\n\n## ' + header + '\n' + body;

  // What the reranker scores against: just the answer
  const answerText = solution;

  return { embedText, fullSection, answerText, problem, header };
}

function chunkMarkdown(raw) {
  const lines = raw.split('\n');

  // 1. Extract document context: H1 + metadata up to first ---
  let docContext = '';
  let bodyStart  = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---' && docContext === '') {
      docContext = lines.slice(0, i).join('\n').trim();
      bodyStart  = i + 1;
      break;
    }
  }
  if (!docContext) {
    const h1 = lines.find(l => l.startsWith('# '));
    docContext = h1 || '';
    bodyStart  = h1 ? lines.indexOf(h1) + 1 : 0;
  }

  // 2. Split body into sections by ## headers
  const sections = [];
  let currentHeader = '';
  let currentBody   = '';

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') continue;

    const h2Match = line.match(/^## (.+)$/);
    if (h2Match) {
      if (currentBody.trim()) {
        sections.push({ header: currentHeader, body: currentBody.trim() });
      }
      currentHeader = h2Match[1];
      currentBody   = '';
      continue;
    }
    currentBody += line + '\n';
  }
  if (currentBody.trim()) {
    sections.push({ header: currentHeader, body: currentBody.trim() });
  }

  // 3. Parse each section into embed-text + payload
  const chunks = [];
  for (const { header, body } of sections) {
    const parsed = parseSection(header, body, docContext);

    if (parsed.embedText.length < MIN_CHUNK_CHARS) continue;

    // Safety net: if embed text is huge, sub-split by paragraphs
    const words = parsed.embedText.split(/\s+/).length;
    if (words <= MAX_CHUNK_WORDS) {
      chunks.push(parsed);
    } else {
      // Split problem description into smaller pieces, each gets full answer payload
      const paras = parsed.problem.split(/\n{2,}/).filter(p => p.trim().length > 20);
      let buffer = '';
      for (const para of paras) {
        const tentative = buffer + '\n\n' + para;
        if (tentative.split(/\s+/).length > MAX_CHUNK_WORDS && buffer.trim()) {
          chunks.push({
            ...parsed,
            embedText: `## ${header}\n${buffer.trim()}`
          });
          buffer = para;
        } else {
          buffer = tentative;
        }
      }
      if (buffer.trim()) {
        chunks.push({
          ...parsed,
          embedText: `## ${header}\n${buffer.trim()}`
        });
      }
    }
  }

  return chunks;
}

// Word-based chunking for non-markdown files (with overlap)
function chunkPlainText(text) {
  const words  = text.split(/\s+/);
  const chunks = [];
  const STEP   = Math.floor(MAX_CHUNK_WORDS * 0.75);

  for (let i = 0; i < words.length; i += STEP) {
    const chunk = words.slice(i, i + MAX_CHUNK_WORDS).join(' ');
    if (chunk.trim().length >= MIN_CHUNK_CHARS) {
      chunks.push({
        embedText:    chunk,
        fullSection:  chunk,
        answerText:   chunk,
        header:       null
      });
    }
    if (i + MAX_CHUNK_WORDS >= words.length) break;
  }

  return chunks;
}

// ─── Ingest one file ──────────────────────────────────────────────────────────

async function ingestFile(filePath) {
  const filename = path.basename(filePath);
  const raw      = fs.readFileSync(filePath, 'utf8');

  console.log(`\nIngesting: ${filename} (${raw.length} chars)`);

  const chunks = filename.endsWith('.md')
    ? chunkMarkdown(raw)
    : chunkPlainText(raw);

  console.log(`  → ${chunks.length} chunks`);

  if (chunks.length === 0) {
    console.log(`  → Skipped (no content)`);
    return 0;
  }

  // Embed only the question/problem signal — NOT the answer
  const embedTexts = chunks.map(c => c.embedText);
  const allEmbeddings = [];
  const totalBatches  = Math.ceil(chunks.length / EMBED_BATCH);

  for (let i = 0; i < embedTexts.length; i += EMBED_BATCH) {
    const batchNum = Math.floor(i / EMBED_BATCH) + 1;
    const batch    = embedTexts.slice(i, i + EMBED_BATCH);
    console.log(`  → Embedding batch ${batchNum}/${totalBatches} (${batch.length} chunks)...`);
    const embeddings = await embedBatch(batch);
    allEmbeddings.push(...embeddings);
  }

  const actualDim = allEmbeddings[0]?.length;
  if (actualDim !== VECTOR_SIZE) {
    console.error(`  → Dimension mismatch! Got ${actualDim}, expected ${VECTOR_SIZE}`);
    throw new Error(`Vector dimension mismatch: got ${actualDim}, expected ${VECTOR_SIZE}`);
  }
  console.log(`  → Dimensions: ${actualDim} ✓`);

  const points = chunks.map((chunk, i) => ({
    id:      uuidv4(),
    vector:  allEmbeddings[i],
    payload: {
      // What gets searched: question signal (for debugging)
      query_text:  chunk.embedText,
      // What the LLM sees: full section with doc context
      content:     chunk.fullSection,
      // What the reranker scores against: just the answer
      answer:      chunk.answerText,
      // Metadata
      source:      filename,
      header:      chunk.header || null,
      chunk_index: i,
      word_count:  chunk.embedText.split(/\s+/).length,
      ingested_at: new Date().toISOString()
    }
  }));

  await upsert(COLLECTIONS.docs, points);
  console.log(`  → Upserted ${points.length} points ✓`);
  return points.length;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting doc ingestion...');
  console.log(`Qdrant URL:  ${process.env.QDRANT_URL}`);
  console.log(`CF Account:  ${process.env.CF_ACCOUNT_ID ? 'set' : 'MISSING'}`);
  console.log(`CF Token:    ${process.env.CF_API_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`Max words:   ${MAX_CHUNK_WORDS} | Min chars: ${MIN_CHUNK_CHARS} | Batch: ${EMBED_BATCH}`);

  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    console.log(`\nCreated /docs folder — add your .md files there and run again`);
    return;
  }

  const files = fs.readdirSync(DOCS_DIR)
    .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
    .sort();

  if (files.length === 0) {
    console.log('\nNo .md/.txt files found in /docs — add some and run again');
    return;
  }

  console.log(`\nFound ${files.length} file(s): ${files.join(', ')}`);

  // Reset collection to prevent duplicates on re-run
  const info = await client.getCollection(COLLECTIONS.docs).catch(() => null);
  if (info && info.points_count > 0) {
    console.log(`\nClearing ${info.points_count} existing points...`);
    await resetCollection(COLLECTIONS.docs);
  } else {
    await ensureCollection(COLLECTIONS.docs);
  }

  let totalPoints = 0;
  const results = [];

  for (const file of files) {
    try {
      const count = await ingestFile(path.join(DOCS_DIR, file));
      totalPoints += count;
      results.push({ file, chunks: count, status: 'ok' });
    } catch (err) {
      console.error(`\nFailed to ingest ${file}:`, err.message);
      results.push({ file, chunks: 0, status: 'failed', error: err.message });
    }
  }

  console.log('\n─── Ingestion Summary ───────────────────────────────');
  results.forEach(r => {
    const icon = r.status === 'ok' ? '✓' : '✗';
    console.log(`  ${icon} ${r.file}: ${r.chunks} chunks${r.error ? ' — ' + r.error : ''}`);
  });
  console.log(`\n  Total: ${totalPoints} chunks across ${files.length} file(s)`);
  console.log('─────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('\nIngestion failed:', err.message);
  process.exit(1);
});
