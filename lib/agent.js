// lib/agent.js
const { classifyIntent } = require('./intent');
const { fetchContext, maybeUpdateSummary } = require('./memory');
const { rewriteQuery } = require('./rewriter');
const { generateResponse } = require('./responder');
const { embed, rerank } = require('./cloudflare');
const { chatFast } = require('./cloudflare');
const { search, COLLECTIONS } = require('./qdrant');
const { saveMessage, findIssueForAuthorInThread, createLinkedIssue, getAllThreadIssues } = require('./issues');
const supabase = require('./supabase');
const { isStaff, getSpeakerRole, isParticipantDiscussion } = require('./speaker');
const {
  canEscalate,
  buildIncidentState,
  generateEscalationBrief,
  sendEscalationEmbed,
  updateThreadBrief,
  shouldUpdateBrief
} = require('./context');

// Fallback casual reply for participant questions (no RAG, light touch)
function getCasualReplyFromIntent(message) {
  const lower = message.toLowerCase().trim();
  if (/^(hi|hey|hello|hiya|heya|howdy|sup|yo|greetings)\b/.test(lower)) {
    return "Hey! I'm here to help. What can I assist you with?";
  }
  if (/^(thanks|thank you|thx|ty|cheers|appreciate)\b/.test(lower)) {
    return "You're welcome! Let me know if you need anything else.";
  }
  return "Got it! A team member will review this thread and follow up if needed.";
}

// ── Fix 3: Classify participant intent — is this a NEW support request? ──────
const PARTICIPANT_CLASSIFY_PROMPT = `You are classifying a message from a secondary user in a support thread.
The thread was originally about a different user's issue.

Original issue title: {ISSUE_TITLE}
Original issue description: {ISSUE_DESC}

Secondary user's message: {MESSAGE}

Is this secondary user reporting their OWN distinct support problem/question,
or are they commenting on / contributing to the original issue?

Respond with ONLY one of:
- NEW_REQUEST — if they have their own problem, need, or question that differs from the original issue
- SAME_ISSUE — if they're reacting to, commenting on, or adding info about the original issue

Examples of NEW_REQUEST:
- "Can you check my customer ID 12345?"
- "I'm having a different problem with my billing"
- "My account shows the wrong plan too, my user ID is ..."

Examples of SAME_ISSUE:
- "Same issue here"
- "I think this is related to the recent update"
- "How about just restoring the benefits?"
- "Here's the URL for that page: ..."
- "yeah that happened to me too"

Respond with ONLY: NEW_REQUEST or SAME_ISSUE`;

/**
 * Classify whether a participant's message is a new support request or about the existing issue.
 * @param {string} message - The participant's message
 * @param {object} issue - The parent issue
 * @returns {Promise<boolean>} true if this is a new/distinct support request
 */
async function classifyParticipantIntent(message, issue) {
  try {
    const prompt = PARTICIPANT_CLASSIFY_PROMPT
      .replace('{ISSUE_TITLE}', issue.title || '')
      .replace('{ISSUE_DESC}', (issue.description || '').slice(0, 300))
      .replace('{MESSAGE}', message.slice(0, 500));

    const result = await chatFast(prompt, [
      { role: 'user', content: 'Classify this message.' }
    ]);

    if (!result || typeof result !== 'string') return false;
    return result.trim().toUpperCase().includes('NEW_REQUEST');
  } catch (err) {
    console.error('[agent] Participant intent classification failed:', err.message);
    return false; // Safe default: treat as same-issue comment
  }
}

// Split multi-question messages into individual questions
// Handles: numbered lists, bullets, and the most common Discord pattern
// ("how do I X? how do I Y?") — conservative by design
function splitQuestions(message) {
  const trimmed = message.trim();
  const questionCount = (trimmed.match(/\?/g) || []).length;

  // Single question — no split needed
  if (questionCount <= 1) return [trimmed];

  // Try numbered list: "1. question? 2. question?"
  const numberedParts = trimmed.split(/\s+(?=\d+[\.\)]\s)/);
  const filtered = numberedParts.filter(p => p.trim().includes('?'));
  if (filtered.length >= 2) return filtered.map(p => p.trim());

  // Try bullet pattern: "- question? - question?"
  const bulletParts = trimmed.split(/\n\s*[-•]\s*/);
  const filteredBullets = bulletParts.filter(p => p.trim().includes('?'));
  if (filteredBullets.length >= 2) return filteredBullets.map(p => p.trim());

  // Split on "? " followed by a question word — the most common Discord pattern
  // e.g. "how do I contact support? how do I cancel my subscription?"
  const sentenceParts = trimmed.split(/\?\s+(?=how|what|why|when|where|can|do|is|are|will|would|could|should|i need|i want|does)/i);
  if (sentenceParts.length >= 2) {
    // Re-add the ? that was consumed by the split
    const withQ = sentenceParts.map((p, i) => {
      const cleaned = p.trim();
      // Last part already has ? if original ended with ?
      // All other parts need ? added back
      if (i < sentenceParts.length - 1 && !cleaned.endsWith('?')) {
        return cleaned + '?';
      }
      return cleaned;
    });
    return withQ.filter(p => p.length > 5);
  }

  // Multiple ? but no clear delimiter — don't risk splitting
  return [trimmed];
}

// Build a human-readable status reply from issue data
function buildStatusReply(issue) {
  const STATUS_LABELS = {
    open: '🔴 Open — waiting for a team member to pick this up',
    acknowledged: '🟡 Acknowledged — a team member has seen your issue',
    in_progress: '🔵 In progress — someone is actively working on this',
    resolved: '🟢 Resolved',
    closed: '⚪ Closed'
  };

  const label = STATUS_LABELS[issue.status] || issue.status;
  const created = new Date(issue.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  return [
    `**Status of ${issue.short_id}:** ${label}`,
    `Reported: ${created}`,
    issue.status === 'open' || issue.status === 'acknowledged'
      ? `\nA team member will respond here as soon as possible.`
      : ''
  ].join('\n').trim();
}

// Process a single question through L2→L3→L4 pipeline
// Returns { answer: string } or { escalate: true }
async function processSingleQuestion(question, context, issue, intent) {
  // L3: Query rewriting with actual intent from classification
  const { query, needsRag } = await rewriteQuery(question, context.history, intent);

  // ── Qdrant search ─────────────────────────────────────────
  let ragResults = [];
  if (needsRag && query && query.length > 3) {
    try {
      const queryVector = await embed(query);
      // Fetch more candidates than needed — reranker will filter down
      const candidates = await search(COLLECTIONS.docs, queryVector, 10);

      const tier2 = await search(COLLECTIONS.cases, queryVector, 5,
        issue.department ? {
          must: [{ key: 'department', match: { value: issue.department } }]
        } : null
      ).catch(() => []);

      const allCandidates = [...candidates, ...tier2];
      const bestVectorScore = allCandidates.length > 0
        ? Math.max(...allCandidates.map(r => r.score))
        : 0;

      console.log(`[agent] Vector search: ${allCandidates.length} candidates, best: ${bestVectorScore.toFixed(3)}`);

      // ── Reranking step ──────────────────────────────────────
      if (allCandidates.length > 0) {
        // Reranker scores against full section (problem + solution) for better keyword matching
        const docTexts = allCandidates.map(r => r.payload.content);

        try {
          const reranked = await rerank(query, docTexts);

          // Map reranker scores back to original results
          // Reranker returns { id, score } — id = input index, score is raw logit, apply sigmoid
          const sigmoid = x => 1 / (1 + Math.exp(-x));

          ragResults = reranked
            .map(r => ({
              ...allCandidates[r.id],
              score: sigmoid(r.score),
              vector_score: allCandidates[r.id].score,
              reranker_score: sigmoid(r.score)
            }))
            .sort((a, b) => b.reranker_score - a.reranker_score)
            .slice(0, 5);

          const bestReranked = ragResults[0]?.reranker_score || 0;
          console.log(`[agent] After reranking: best score ${bestReranked.toFixed(3)}`);

        } catch (err) {
          // Reranker failed — fall back to vector results
          console.warn('[agent] Reranker failed, using vector results:', err.message);
          ragResults = allCandidates.slice(0, 5);
        }
      }

      // For complaints, the contact-support chunk is a redirect not a solution
      // Only accept it if it scores very high (genuine match) or if no other results exist
      if (intent === 'COMPLAINT') {
        const nonContactResults = ragResults.filter(r => {
          const content = (r.payload.content || '').toLowerCase();
          const isContactChunk = content.includes('/report command') &&
            !content.includes('error') &&
            !content.includes('rate limit') &&
            !content.includes('unauthorized');
          return !isContactChunk || r.reranker_score > 0.85;
        });
        // Only apply filter if it doesn't remove everything
        if (nonContactResults.length > 0) {
          ragResults = nonContactResults;
          console.log(`[agent] COMPLAINT filter: ${ragResults.length} results after removing contact-only chunks`);
        }
      }

    } catch (err) {
      console.error('[agent] Search failed:', err.message);
    }
  } else {
    console.log('[agent] Skipping RAG — rewriter said not needed');
  }

  // L4: Response generation
  const answer = await generateResponse(question, ragResults, context, needsRag);
  if (answer.toUpperCase().startsWith('ESCALATE')) {
    return { escalate: true };
  }
  return { answer };
}

async function runAgent(discordClient, thread, issue, userMessage, member) {
  console.log(`[agent] ${issue.short_id} — processing: "${userMessage.slice(0, 60)}"`);

  // ── V6.81: Speaker role gate ──────────────────────────────────────
  const reporterId = issue.user_discord_id;
  const isStaffFlag = isStaff(member);

  if (isStaffFlag) {
    console.log(`[agent] ${issue.short_id} — staff message, skipping pipeline`);
    return;
  }

  const speakerRole = getSpeakerRole(member?.id, reporterId, false);
  console.log(`[agent] ${issue.short_id} — speaker role: ${speakerRole}`);

  // Check if participants are discussing among themselves
  const discussing = await isParticipantDiscussion(thread, reporterId, discordClient.user.id);
  if (discussing) {
    console.log(`[agent] ${issue.short_id} — participant discussion detected, skipping`);
    return;
  }

  // ── Layer 1: Intent classification ──────────────────────────────────
  const { intent, messageType, reply: casualReply } = await classifyIntent(userMessage);
  console.log(`[agent] Intent: ${intent}|${messageType}`);

  // V6.81: Acknowledgement — skip entirely, no reply
  if (messageType === 'acknowledgement') {
    console.log(`[agent] ${issue.short_id} — acknowledgement, skipping`);
    return;
  }

  // ── Fix 3: Intelligent participant handling — don't go deaf ──────────
  if (speakerRole === 'participant') {
    if (messageType === 'comment') {
      // Save comment for staff context (thread brief will show it)
      // Don't reply, but don't silently drop either
      console.log(`[agent] ${issue.short_id} — participant comment saved for context`);
      // Maybe update thread brief — DISABLED
      // if (shouldUpdateBrief(thread.id)) {
      //   const allIssues = await getAllThreadIssues(thread.id);
      //   await updateThreadBrief(thread, allIssues, discordClient.user.id);
      // }
      return;
    }

    // participant + question/followup → classify if NEW support request or same issue
    if (messageType === 'question' || messageType === 'followup') {
      const isNewRequest = await classifyParticipantIntent(userMessage, issue);

      if (isNewRequest) {
        // ── Fix 1: Create a sub-issue for this participant ────────────────
        console.log(`[agent] ${issue.short_id} — participant NEW request detected from ${member?.id}`);
        try {
          // Extract a title from the participant's message
          const subTitle = userMessage.slice(0, 100).replace(/\n/g, ' ');
          const authorUser = await discordClient.users.fetch(member?.id || member?.user?.id);

          const subIssue = await createLinkedIssue({
            user: authorUser,
            guild: thread.guild,
            thread,
            title: subTitle,
            description: userMessage,
            parentIssue: issue
          });

          // Save the message under the SUB-ISSUE, not the parent
          await saveMessage({
            issueId: subIssue.id,
            role: 'user',
            content: userMessage
          });

          // Acknowledge with sub-issue ID
          const ackMsg = await thread.send({
            content: `<@${authorUser.id}> I've logged your issue as **${subIssue.short_id}**. A team member will assist you here.`
          });
          await saveMessage({
            issueId: subIssue.id,
            role: 'assistant',
            content: `Issue ${subIssue.short_id} created for participant's separate request.`,
            discordMsgId: ackMsg.id
          });

          // Now run the FULL pipeline for the sub-issue (with RAG!)
          const subContext = await fetchContext(subIssue);
          const subIntent = intent; // reuse same intent classification
          const subQuestions = splitQuestions(userMessage);
          const subAnswers = [];
          let subNeedsEscalation = false;

          for (const q of subQuestions) {
            const result = await processSingleQuestion(q, subContext, subIssue, subIntent);
            if (result.escalate) {
              subNeedsEscalation = true;
              break;
            }
            subAnswers.push(result.answer);
          }

          if (subNeedsEscalation) {
            await escalate(discordClient, thread, subIssue, userMessage, subContext);
          } else if (subAnswers.length > 0) {
            const subFinalAnswer = subAnswers.length > 1
              ? subAnswers.map((a, i) => `**${i + 1}.** ${a}`).join('\n\n')
              : subAnswers[0];
            try {
              const ansMsg = await thread.send({ content: `<@${authorUser.id}> ${subFinalAnswer}` });
              await saveMessage({
                issueId: subIssue.id,
                role: 'assistant',
                content: subFinalAnswer,
                discordMsgId: ansMsg.id
              });
            } catch (err) {
              console.error('[agent] Failed to send sub-issue answer:', err.message);
            }
          }

          // Update thread brief (new sub-issue = key event) — DISABLED
          // const allIssues = await getAllThreadIssues(thread.id);
          // await updateThreadBrief(thread, allIssues, discordClient.user.id);

        } catch (err) {
          console.error('[agent] Failed to create sub-issue:', err.message);
          // Fallback: acknowledge normally
          try {
            await thread.send({
              content: `Got it — I've noted your input. A team member will see this when they review the thread.`
            });
          } catch (e) { /* silent */ }
        }
        return;
      }

      // Same-issue question/followup: acknowledge and save for staff
      try {
        const reply = `Got it — I've noted your input. A team member will see this when they review the thread.`;
        const msg = await thread.send({ content: reply });
        await saveMessage({
          issueId: issue.id,
          role: 'assistant',
          content: reply,
          discordMsgId: msg.id
        });
      } catch (err) {
        console.error('[agent] Failed to send participant acknowledgement:', err.message);
      }
      return;
    }
  }

  // CASUAL — reply directly, no LLM or RAG needed
  if (intent === 'CASUAL') {
    try {
      const msg = await thread.send({ content: casualReply });
      await saveMessage({
        issueId: issue.id,
        role: 'assistant',
        content: casualReply,
        discordMsgId: msg.id
      });
    } catch (err) {
      console.error('[agent] Failed to send casual reply:', err.message);
    }
    return;
  }

  // STATUS — query DB and reply directly
  if (intent === 'STATUS') {
    const statusReply = buildStatusReply(issue);
    try {
      const msg = await thread.send({ content: statusReply });
      await saveMessage({
        issueId: issue.id,
        role: 'assistant',
        content: statusReply,
        discordMsgId: msg.id
      });
    } catch (err) {
      console.error('[agent] Failed to send status reply:', err.message);
    }
    return;
  }

  // UNCLEAR — ask for clarification immediately, skip full pipeline
  if (intent === 'UNCLEAR') {
    const clarifyReply = `I'm not quite sure what you're asking. Could you give me a bit more detail? For example, what specific part of the product are you having trouble with?`;
    try {
      const msg = await thread.send({ content: clarifyReply });
      await saveMessage({
        issueId: issue.id,
        role: 'assistant',
        content: clarifyReply,
        discordMsgId: msg.id
      });
    } catch (err) {
      console.error('[agent] Failed to send clarification request:', err.message);
    }
    return;
  }

  // ── Layer 2: Context assembly ────────────────────────────────────────
  const context = await fetchContext(issue);
  console.log(`[agent] History: ${context.messageCount} messages`);

  // ── Fix 2: Multi-question splitting ─────────────────────────────────
  // Split on clear delimiters (numbered lists, bullets) — conservative
  const questions = splitQuestions(userMessage);
  const isMulti = questions.length > 1;
  if (isMulti) {
    console.log(`[agent] Split into ${questions.length} sub-questions`);
  }

  // ── Layer 3 + 4: Process each question through rewriter → RAG → responder ──
  const answers = [];
  let needsEscalation = false;

  for (const q of questions) {
    const result = await processSingleQuestion(q, context, issue, intent);
    if (result.escalate) {
      needsEscalation = true;
      break; // One escalation = escalate the whole message
    }
    answers.push(result.answer);
  }

  if (needsEscalation) {
    await escalate(discordClient, thread, issue, userMessage, context);
    return;
  }

  // Send answer(s) — numbered if multi-question, plain if single
  const finalAnswer = isMulti
    ? answers.map((a, i) => `**${i + 1}.** ${a}`).join('\n\n')
    : answers[0];

  try {
    const msg = await thread.send({ content: finalAnswer });
    await saveMessage({
      issueId: issue.id,
      role: 'assistant',
      content: finalAnswer,
      discordMsgId: msg.id
    });
    console.log(`[agent] ${issue.short_id} — answered successfully`);

    // Fix 4: Maybe update running summary
    await maybeUpdateSummary(issue);

    // Fix 5: Maybe update thread brief (every 5 messages) — DISABLED
    // if (shouldUpdateBrief(thread.id)) {
    //   const allIssues = await getAllThreadIssues(thread.id);
    //   await updateThreadBrief(thread, allIssues, discordClient.user.id);
    // }
  } catch (err) {
    console.error('[agent] Failed to send answer:', err.message);
  }
}

// V6.81: Cooldown-based escalation with embed + pin
async function escalate(discordClient, thread, issue, userMessage, context) {
  console.log(`[agent] Escalating ${issue.short_id}`);

  // Check cooldown — replaces the old boolean hasBeenEscalated
  const { allowed, reason } = await canEscalate(issue.id);
  console.log(`[agent] Escalation check: ${reason}`);

  if (!allowed) {
    // Still save the escalation attempt as a system message for tracking
    // NOTE: prefix intentionally differs from "AGENT escalation" to avoid
    // interfering with canEscalate()'s cooldown timestamp lookup
    await saveMessage({
      issueId: issue.id,
      role: 'system',
      content: `AGENT escalation-suppressed (${reason}): "${userMessage.slice(0, 200)}"`
    });

    // Tell user someone is already looking into it
    try {
      await thread.send({
        content: `I still don't have an answer for that. A team member has already been notified and will assist you shortly.`
      });
    } catch (err) {
      console.error('[agent] Failed to send cooldown message:', err.message);
    }
    return;
  }

  // Send user-facing message
  try {
    await thread.send({
      content: [
        `I wasn't able to find a clear answer in our documentation or past cases.`,
        ``,
        `I've flagged this for a team member who will follow up here shortly.`
      ].join('\n')
    });
  } catch (err) {
    console.error('[agent] Failed to send escalation message:', err.message);
  }

  // Build incident state from thread messages (derived, no DB writes)
  let threadMessages;
  try {
    const fetched = await thread.messages.fetch({ limit: 100 });
    threadMessages = Array.from(fetched.values());
  } catch (err) {
    console.error('[agent] Could not fetch thread messages for briefing:', err.message);
    threadMessages = [];
  }

  const incidentState = await buildIncidentState(issue, threadMessages, discordClient.user.id);

  // Generate structured briefing via LLM (only fires on actual escalation)
  const briefing = await generateEscalationBrief(incidentState);

  // Build role ID from env
  const DEPT_ROLES = {
    billing: process.env.ROLE_BILLING,
    technical: process.env.ROLE_TECHNICAL,
    product: process.env.ROLE_PRODUCT,
    unclassified: process.env.ROLE_UNCLASSIFIED
  };
  const dept = issue.department || 'unclassified';
  const roleId = DEPT_ROLES[dept] || DEPT_ROLES.unclassified;

  // Deliver as embed + pin
  try {
    await sendEscalationEmbed(thread, issue, briefing, roleId);
  } catch (err) {
    console.error('[agent] Failed to send escalation embed:', err.message);
    // Fallback: plain text if embed fails
    const fallback = [
      roleId ? `<@&${roleId}>` : `Team`,
      ``,
      `**${issue.short_id} needs human attention.**`,
      `**Problem:** ${briefing.problemDescription || issue.title}`,
      `Use \`/resolve ${issue.short_id}\` once handled.`
    ].join('\n');
    try { await thread.send({ content: fallback }); } catch (e) { /* silent */ }
  }

  // Save escalation system message (this is what canEscalate reads for cooldown)
  await saveMessage({
    issueId: issue.id,
    role: 'system',
    content: [
      `AGENT escalation — no answer found for: "${userMessage.slice(0, 200)}"`,
      `Issue: ${issue.short_id} | Dept: ${issue.department || 'unassigned'} | Status: ${issue.status}`,
      `Reason: ${reason}`
    ].join('\n')
  });

  // Fix 5: Update thread brief on escalation (key event) — DISABLED
  // try {
  //   const allIssues = await getAllThreadIssues(thread.id);
  //   await updateThreadBrief(thread, allIssues, discordClient.user.id);
  // } catch (err) {
  //   console.warn('[agent] Could not update brief after escalation:', err.message);
  // }
}

module.exports = { runAgent };

