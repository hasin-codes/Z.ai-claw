# RAG Pipeline Changelog — v6.55

**Date:** 2026-03-19
**Scope:** RAG retrieval optimization — rewriter, reranker mapping, response gating
**Baseline accuracy:** 0/20 doc-covered questions answered (100% escalation)
**Final accuracy:** 19/20 doc-covered questions answered (95%), 3/3 out-of-scope correctly escalated

---

## Problem Statement

The RAG pipeline was non-functional. Every user query — even those with clearly matching documentation — resulted in escalation. Investigation revealed the pipeline had **three categories of failure**:

1. **Silent data loss** — reranker results mapped to `undefined`, killing all payloads
2. **Rewriter leakage** — LLM output contamination polluting search queries
3. **Inadequate gating** — threshold and validation logic too permissive or too aggressive

---

## Root Cause Analysis

### Bug 1: Reranker Index Mapping (Critical)
The Cloudflare BGE-Reranker-Base API returns `{ id, score }` per result, where `id` is the zero-based index into the input `contexts` array. The code used `r.index` — a property that doesn't exist — causing every `.map()` to spread `undefined`. Payloads (source, content) were silently dropped while scores still passed threshold checks. The responder then received empty context and escalated.

**Impact:** 100% of RAG queries affected. Scores looked healthy (0.73) but answers were always empty.

### Bug 2: Rewriter Output Contamination
The rewriter LLM (chatFast, instruction-only prompt) frequently appended meta-commentary instead of outputting a clean search phrase. Observed variants:
- `"Extracted search phrase: "GLM model coding extension"`
- `"**Extracted search phrase:** "referral credits vanished"`
- `"Here is the extracted search phrase: "referral credits vanished billing issue"`
- `"API Key, Kilo Code, setup (Note: I've removed filler words and focused on the core terms that would appear in document"`

These prefixes and parentheticals polluted the vector query, pulling irrelevant chunks.

### Bug 3: Rewriter Hallucination
For certain complaint-style inputs, the rewriter hallucinated completely unrelated queries:
- `"my referral credits just vanished"` → `"rate limit exceeded error 429"`
- `"what model do I put in Kilo Code? sonnet? gpt4?"` → `"rate limit exceeded error code 429"`

The rewriter defaulted to rate-limit queries because 4 of 9 doc chunks mentioned rate limits. These scored 0.73 on the wrong chunks, producing confident but incorrect answers.

### Bug 4: Threshold Calibration
Original threshold was 0.50 — too low. Sigmoid-normalized reranker scores cluster around 0.500 for irrelevant matches (raw logit ~0.0), with meaningful matches at 0.60+. At 0.50, noise passed through and the responder had to guess from weak context.

---

## Changes

### `lib/agent.js` — Reranker Mapping Fix
```diff
- // Reranker returns { index, score } — score is raw logit, apply sigmoid
+ // Reranker returns { id, score } — id = input index, score is raw logit, apply sigmoid
  ragResults = reranked
    .map(r => ({
-     ...allCandidates[r.index],
+     ...allCandidates[r.id],
      score:          sigmoid(r.score),
-     vector_score:   allCandidates[r.index].score,
+     vector_score:   allCandidates[r.id].score,
      reranker_score: sigmoid(r.score)
    }))
```
Also added `query.length > 3` guard to skip search on degenerate queries.

### `lib/agent.js` — Payload Safety Canary
Added a diagnostic check that logs an error if any result passes the score threshold but has no payload — making this class of bug impossible to miss in the future:
```js
const payloadMissing = (ragResults || []).filter(r => r.score >= THRESHOLD_HIGH && !r?.payload);
if (payloadMissing.length > 0) {
  console.error(`[responder] BUG: ${payloadMissing.length} results passed score threshold but have no payload`);
}
```

### `lib/rewriter.js` — Query Cleaning Pipeline
Built a layered `cleanQuery()` function that strips LLM contamination:

| Layer | Pattern | Example |
|-------|---------|---------|
| Markdown bold | `^\*{1,2}\|\*{1,2}$` | `**Extracted search phrase:**` → stripped |
| Prefix variants (exhaustive) | `^here is the (extracted )?search phrase:` | All known prefix formats |
| Parenthetical commentary | `\s*\([^)]*(?:note\|removed\|focused)...` | `(Note: I've removed...)` → killed |
| Stray quotes | `^["'\u201C\u201D]+\|["'\u201C\u201D]+$` | `"referral credits"` → `referral credits` |
| Contact method contamination | discord, /report, email, phone, live chat | Prevents contact-page redirect |
| Multi-space collapse | `\s{2,}` | Normalization |

### `lib/rewriter.js` — Hallucination Guard
Added `hasOverlap()` function that checks whether the rewriter output shares at least one content word (excluding 80-word stop list) with the original user message. If zero overlap — the rewriter hallucinated — the query falls back to the first 12 words of the original message.

This caught both hallucination cases:
- `"rate limit exceeded error 429"` vs `"my referral credits just vanished"` → 0 shared words → fallback
- `"rate limit exceeded error code 429"` vs `"what model do I put in Kilo Code"` → 0 shared words → fallback

### `lib/rewriter.js` — Degenerate Query Detection
Expanded regex to catch all LLM "no match" responses and set `needsRag: false` instead of searching garbage into Qdrant:
```js
const DEGENERATE_QUERIES = /^(no (?:relevant )?(?:terms|search phrase|phrase)|nothing to search|n\/a|null|none|not applicable)$/i;
```

### `lib/rewriter.js` — Minimum Word Count
If cleaned query is < 2 words (single-word outputs like "quota"), fall back to truncated original message. Minimum was briefly set to 4 but reverted — the rewriter's 2-3 word outputs (e.g., "cancel refund") were actually higher quality than the full-sentence fallbacks.

### `lib/rewriter.js` — Prompt Hardening
Added explicit constraints:
- "No explanations, no parenthetical notes, no meta-commentary, no prefixes"
- Raised word count guideline from "3-10" to "4-12" to give the reranker more context

### `lib/responder.js` — Threshold Adjustment
Raised `THRESHOLD_HIGH` from 0.50 to 0.60. Rationale: sigmoid(0.0) = 0.500, and raw reranker logits for irrelevant chunks cluster around 0.0. Setting threshold at 0.60 means we require a positive logit (actual semantic match) rather than just "not negative."

### `lib/responder.js` — Reranker Input
Changed reranker input from `r.payload.answer` (field removed during doc cleanup) to `r.payload.content` (full section text including problem + solution), giving the reranker better keyword coverage.

---

## Accuracy Progression

| Iteration | Doc-Covered Correct | Out-of-Scope Escalated | Key Change |
|-----------|-------------------|----------------------|------------|
| Baseline | 0/20 | 3/3 | — |
| + r.id fix | 15/20 | 3/3 | Reranker mapping |
| + rewriter clean | 15/20 | 3/3 | Prefix/quote stripping |
| + < 2 min words | 16/20 | 3/3 | Recovered short good queries |
| + overlap guard | 19/20 | 3/3 | Caught hallucinations |
| **Final v6.55** | **19/20** | **3/3** | — |

### Remaining Failure
`"what model do I put in Kilo Code? sonnet? gpt4? nothing works"` — the hallucination guard correctly falls back, but the fallback still contains competitor model names ("sonnet", "gpt4") that don't exist in docs. The reranker can't bridge this semantic gap. This is a fundamental limitation of keyword-based reranking with BGE-Reranker-Base, not a bug.

---

## Architecture Decisions

### Why post-processing over prompt engineering
The rewriter uses a fast/cheap LLM (chatFast) that cannot be 100% constrained by prompts alone. Every fix is implemented as **post-processing in `cleanQuery()`** with the prompt providing soft guidance. This makes the system robust to model temperature variations and prompt drift.

### Why not lower the threshold
The 0.60 threshold could be lowered to 0.55 to recover the one remaining failure, but without a broader test set we can't confirm this wouldn't let in noise. The threshold should be calibrated against production data, not a 20-question test suite.

### Why sigmoid normalization
The Cloudflare reranker returns raw logits (unbounded, can be negative). Sigmoid maps these to [0, 1] for consistent threshold comparison. Alternative (min-max normalization) would require fetching all scores before filtering, adding latency.

---

## Known Limitations

1. **Score ceiling at ~0.73** — BGE-Reranker-Base with 300-word chunks can't push past this for dense doc sections. Smaller chunks (100-150 words) or BGE-Reranker-Large would help.
2. **Rewriter non-determinism** — Different LLM calls may produce different prefixes/commentary. The cleaning pipeline handles known variants but could miss novel ones. Monitor logs for new patterns.
3. **Test set size** — 20 questions is insufficient for confident threshold calibration. Recommend a holdout set of 50+ questions before adjusting thresholds.
4. **Single-language** — All cleaning regex assumes English. Non-English inputs may bypass prefix detection.

---

## Files Modified

| File | Changes |
|------|---------|
| `lib/agent.js` | Reranker `r.index` → `r.id`, query length guard, payload safety canary |
| `lib/rewriter.js` | `cleanQuery()` pipeline, `hasOverlap()` guard, degenerate detection, word count fallback, prompt hardening |
| `lib/responder.js` | Threshold 0.50 → 0.60, reranker input `answer` → `content`, payload missing diagnostic |
| `scripts/ingest.js` | (Prior session) Removed unused payload fields to match cleaned doc schema |
| `docs/*.md` | (Prior session) Stripped metadata noise (Category, Confidence, Notes, headers) from 6 doc files |
