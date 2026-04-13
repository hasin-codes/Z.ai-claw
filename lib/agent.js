// lib/agent.js — Phase-aware RAG orchestration (V6.82)
// Routes incoming user messages through intent → RAG → evidence gathering → escalation

const { classifyIntent } = require('./intent');
const { rewriteQuery, rewriteQueryOnly } = require('./rewriter');
const { searchDocs, searchCases } = require('./qdrant');
const { rerank: rerankResults } = require('./cloudflare');
const { generateResponse } = require('./responder');
const { fetchContext } = require('./memory');
const { isStaff, getSpeakerRole, isParticipantDiscussion } = require('./speaker');
const { pingRoleInThread } = require('./forward');
const {
  saveMessage,
  getAllThreadIssues,
  createIssue,
  attachThread,
  setPhase,
  fetchIssueEvidence,
  findIssueForAuthorInThread,
} = require('./issues');
const {
  buildIncidentState,
  generateEscalationBrief,
  sendEscalationEmbed,
} = require('./context');
const {
  detectScenario,
  extractEvidence,
  mergeEvidence,
  isEvidenceComplete,
  buildMissingFieldsQuestion,
  buildEvidenceBrief,
} = require('./evidence');

// ── Helpers ──────────────────────────────────────────────────────────────────

const INFO_GATHERING_PATTERN = /please share|could you (share|provide|send|tell)|can you (share|provide|send|tell)|we('ll)? need|to help you.*could you|would you (mind|be able)|i('d| would) (need|like to see)/i;

async function processSingleQuestion(discordClient, thread, issue, userMessage, member, discordMessage = null) {
  console.log(`[agent] ${issue.short_id} — processSingleQuestion: "${userMessage.slice(0, 60)}"`);

  // ── Layer 1: Phase gate ──────────────────────────────────────────────
  const { phase, evidence } = await fetchIssueEvidence(issue.id);

  if (phase === 'gathering') {
    // Evidence gathering phase — extract new data, check completeness
    console.log(`[agent] ${issue.short_id} — phase=gathering, extracting evidence`);
    try {
      const scenario = detectScenario(issue);

      // FIX #4: If scenario is null we can't gather evidence — escalate immediately
      if (!scenario) {
        console.log(`[agent] ${issue.short_id} — no scenario detected during gathering, escalating`);
        await setPhase(issue.id, 'escalated');
        const threadMsgs = await thread.messages.fetch({ limit: 50 });
        const incidentState = await buildIncidentState(issue, Array.from(threadMsgs.values()), discordClient.user.id);
        const enrichedBrief = await generateEscalationBrief(incidentState);
        await sendEscalationEmbed(thread, issue, enrichedBrief, null);
        await pingRoleInThread(discordClient, thread, issue, 'escalation');
        const thankMsg = `Thank you! I've collected the information our team needs. They'll be with you shortly in this thread.`;
        const msg = await thread.send({ content: `<@${issue.user_discord_id}> ${thankMsg}` });
        await saveMessage({ issueId: issue.id, role: 'assistant', content: thankMsg, discordMsgId: msg.id });
        return;
      }

      const newFields = await extractEvidence(userMessage, scenario, discordMessage);
      if (Object.keys(newFields).length > 0) {
        await mergeEvidence(issue.id, newFields);
        console.log(`[agent] ${issue.short_id} — extracted fields:`, Object.keys(newFields));
      }

      // FIX #1 & #2: Always fetch fresh evidence from DB after merge, not just
      // spread-merging in memory. This ensures the completeness check sees all
      // previously accumulated fields across multiple turns, not just this turn's fields.
      const { evidence: freshEvidence } = await fetchIssueEvidence(issue.id);

      const { complete, missing } = isEvidenceComplete(scenario, freshEvidence);

      if (complete) {
        // Evidence complete — send brief to staff
        console.log(`[agent] ${issue.short_id} — evidence complete, sending brief`);
        const brief = buildEvidenceBrief(issue, scenario, freshEvidence);
        await setPhase(issue.id, 'escalated');

        // Send to thread — the role mention guard in pingRoleInThread handles deduplication
        const threadMessages = await thread.messages.fetch({ limit: 50 });
        const msgArray = Array.from(threadMessages.values());
        const incidentState = await buildIncidentState(issue, msgArray, discordClient.user.id);
        const enrichedBrief = await generateEscalationBrief(incidentState);
        await sendEscalationEmbed(thread, issue, enrichedBrief, null);
        await pingRoleInThread(discordClient, thread, issue, 'escalation');

        const thankMsg = `Thank you! I've collected the information our team needs. They'll be with you shortly in this thread.`;
        const msg = await thread.send({ content: `<@${issue.user_discord_id}> ${thankMsg}` });
        await saveMessage({ issueId: issue.id, role: 'assistant', content: thankMsg, discordMsgId: msg.id });
      } else {
        // Still missing fields — ask for next batch
        const question = buildMissingFieldsQuestion(missing);
        if (question) {
          const msg = await thread.send({ content: `<@${issue.user_discord_id}> ${question}` });
          await saveMessage({ issueId: issue.id, role: 'assistant', content: question, discordMsgId: msg.id });
        } else {
          // missing is empty but complete is false — scenario mismatch, escalate
          console.warn(`[agent] ${issue.short_id} — missing fields empty but not complete, forcing escalation`);
          await setPhase(issue.id, 'escalated');
          const threadMsgs = await thread.messages.fetch({ limit: 50 });
          const incidentState = await buildIncidentState(issue, Array.from(threadMsgs.values()), discordClient.user.id);
          const enrichedBrief = await generateEscalationBrief(incidentState);
          await sendEscalationEmbed(thread, issue, enrichedBrief, null);
          await pingRoleInThread(discordClient, thread, issue, 'escalation');
          const thankMsg = `Thank you! I've collected the information our team needs. They'll be with you shortly in this thread.`;
          const msg = await thread.send({ content: `<@${issue.user_discord_id}> ${thankMsg}` });
          await saveMessage({ issueId: issue.id, role: 'assistant', content: thankMsg, discordMsgId: msg.id });
        }
      }
    } catch (err) {
      console.error('[agent] Evidence gathering error:', err.message);
    }
    return;
  }

  // ── Layer 2: Query rewriting ─────────────────────────────────────────
  const context = await fetchContext(issue);
  let rewrite;
  try {
    // FIX #3: For escalated phase, always force needsRag=true so follow-up questions
    // (like asking about 429 errors after billing escalation) still get RAG results.
    // Use rewriteQueryOnly only for truly empty history (first message), not for escalated.
    if (context.history.length === 0) {
      rewrite = await rewriteQueryOnly(userMessage);
      console.log(`[agent] rewriteQueryOnly (no-history) -> "${rewrite.query}" needsRag=${rewrite.needsRag}`);
    } else if (phase === 'escalated') {
      // Has history but post-escalation — rewrite with history so context is preserved,
      // but force needsRag=true so RAG is never skipped for new questions.
      rewrite = await rewriteQuery(userMessage, context.history);
      rewrite.needsRag = true;
      console.log(`[agent] rewrite (escalated, needsRag forced true) -> "${rewrite.query}"`);
    } else {
      rewrite = await rewriteQuery(userMessage, context.history);
      console.log(`[agent] rewrite -> query="${rewrite.query}" needsRag=${rewrite.needsRag}`);
    }
  } catch (err) {
    console.error('[agent] Rewrite failed:', err.message);
    rewrite = { query: userMessage.slice(0, 80), needsRag: true, reason: 'fallback' };
  }

  // ── Layer 3: RAG retrieval ────────────────────────────────────────────
  let ragResults = [];
  let needsRagWasAttempted = false;

  if (rewrite.needsRag && rewrite.query) {
    needsRagWasAttempted = true;
    try {
      const [docs, cases] = await Promise.all([
        searchDocs(rewrite.query, 10),
        searchCases(rewrite.query, 5),
      ]);

      const allCandidates = [...docs, ...cases];
      console.log(`[agent] Vector Search: ${docs.length} docs (best: ${docs[0]?.score?.toFixed(3) || 0}), ${cases.length} cases (best: ${cases[0]?.score?.toFixed(3) || 0})`);

      if (allCandidates.length > 0) {
        const reranked = await rerankResults(rewrite.query, allCandidates);
        // Defensive mapping: r.id and r.index are both used in different reranker responses
        ragResults = reranked.map(r => ({ ...allCandidates[r.id ?? r.index], score: r.relevance_score }));
      }
    } catch (err) {
      console.error('[agent] RAG retrieval error:', err.message);
    }
  }

  // ── Layer 4: LLM response ─────────────────────────────────────────────
  let answer;
  try {
    answer = await generateResponse(userMessage, ragResults, context, needsRagWasAttempted, phase);
  } catch (err) {
    console.error('[agent] Response generation error:', err.message);
    answer = 'ESCALATE';
  }

  if (answer && answer.toUpperCase().includes('ESCALATE')) {
    // ── Escalation path ──────────────────────────────────────────────────
    console.log(`[agent] ${issue.short_id} — escalating`);

    if (phase === 'escalated') {
      // FIX (issue 3): When already escalated and LLM returned ESCALATE, try a fresh RAG
      // pass before sending the boilerplate hold message. This handles cases like
      // "I'm getting 429 errors" after a billing escalation — the answer IS in the docs.
      console.log(`[agent] ${issue.short_id} — phase already escalated, retrying RAG before hold`);
      try {
        const context2 = await fetchContext(issue);
        const rewrite2 = await rewriteQuery(userMessage, context2.history).catch(() => ({
          query: userMessage.slice(0, 80), needsRag: true,
        }));
        rewrite2.needsRag = true;
        let ragResults2 = [];
        if (rewrite2.query) {
          const [docs2, cases2] = await Promise.all([
            searchDocs(rewrite2.query, 10),
            searchCases(rewrite2.query, 5),
          ]);
          const candidates2 = [...docs2, ...cases2];
          if (candidates2.length > 0) {
            const reranked2 = await rerankResults(rewrite2.query, candidates2);
            ragResults2 = reranked2.map(r => ({ ...candidates2[r.id ?? r.index], score: r.relevance_score }));
          }
        }
        const answer2 = await generateResponse(userMessage, ragResults2, context2, ragResults2.length > 0, phase);
        if (answer2 && !answer2.toUpperCase().includes('ESCALATE')) {
          const msg = await thread.send({ content: `<@${issue.user_discord_id}> ${answer2}` });
          await saveMessage({ issueId: issue.id, role: 'assistant', content: answer2, discordMsgId: msg.id });
          return;
        }
      } catch (err) {
        console.error('[agent] Escalated-phase RAG retry failed:', err.message);
      }
      try {
        const holdMsg = `Thanks for the update. Our team has been notified and will follow up in this thread. Please hold on!`;
        const msg = await thread.send({ content: `<@${issue.user_discord_id}> ${holdMsg}` });
        await saveMessage({ issueId: issue.id, role: 'assistant', content: holdMsg, discordMsgId: msg.id });
      } catch (err) {
        console.error('[agent] Failed to send hold message:', err.message);
      }
      return;
    }

    const scenario = detectScenario(issue);
    const { complete: initialComplete } = isEvidenceComplete(scenario, evidence);

    // FIX #4: Only start gathering if we have a valid scenario.
    // Without a scenario, isEvidenceComplete always returns complete=false with missing=[],
    // causing a silent hang where buildMissingFieldsQuestion returns null and nothing is sent.
    if (!initialComplete && Object.keys(evidence).length < 2 && scenario !== null) {
      // Start evidence gathering instead of immediately escalating
      console.log(`[agent] ${issue.short_id} — starting evidence gathering (scenario: ${scenario})`);
      await setPhase(issue.id, 'gathering');

      // Extract any data the user already supplied in this first message
      const initialFields = await extractEvidence(userMessage, scenario, discordMessage);
      if (Object.keys(initialFields).length > 0) {
        await mergeEvidence(issue.id, initialFields);
      }

      // FIX #1: Re-fetch from DB after merge so completeness check sees all fields,
      // not just what was in memory before this turn.
      const { evidence: mergedInitial } = await fetchIssueEvidence(issue.id);
      const { complete: nowComplete, missing: nowMissing } = isEvidenceComplete(scenario, mergedInitial);

      if (nowComplete) {
        // User supplied everything upfront — escalate immediately, skip gathering
        console.log(`[agent] ${issue.short_id} — evidence complete from first message, escalating`);
        await setPhase(issue.id, 'escalated');
        const threadMsgs = await thread.messages.fetch({ limit: 50 });
        const incidentState = await buildIncidentState(issue, Array.from(threadMsgs.values()), discordClient.user.id);
        const enrichedBrief = await generateEscalationBrief(incidentState);
        await sendEscalationEmbed(thread, issue, enrichedBrief, null);
        await pingRoleInThread(discordClient, thread, issue, 'escalation');
        const thankMsg = `Thank you! I've collected the information our team needs. They'll be with you shortly in this thread.`;
        const tMsg = await thread.send({ content: `<@${issue.user_discord_id}> ${thankMsg}` });
        await saveMessage({ issueId: issue.id, role: 'assistant', content: thankMsg, discordMsgId: tMsg.id });
        return;
      }

      const question = buildMissingFieldsQuestion(nowMissing);
      if (question) {
        const msg = await thread.send({ content: `<@${issue.user_discord_id}> ${question}` });
        await saveMessage({ issueId: issue.id, role: 'assistant', content: question, discordMsgId: msg.id });
        return;
      }
    }

    // Escalate immediately — evidence already collected or scenario is general
    const threadMessages = await thread.messages.fetch({ limit: 50 });
    const msgArray = Array.from(threadMessages.values());

    let escalationMsgId;
    try {
      const incidentState = await buildIncidentState(issue, msgArray, discordClient.user.id);
      const brief = await generateEscalationBrief(incidentState);
      const embedMsg = await sendEscalationEmbed(thread, issue, brief, null);
      escalationMsgId = embedMsg?.id;
    } catch (err) {
      console.error('[agent] Failed to build escalation brief:', err.message);
    }

    await setPhase(issue.id, 'escalated');
    await pingRoleInThread(discordClient, thread, issue, 'escalation');

    await saveMessage({
      issueId: issue.id,
      role: 'system',
      content: `AGENT escalation — for: "${userMessage.slice(0, 200)}"`,
      discordMsgId: escalationMsgId || null,
    });

    try {
      await thread.send({ content: `<@${issue.user_discord_id}> I wasn't able to find an answer to that in our documentation. A team member has been notified and will follow up here soon.` });
    } catch (err) {
      console.error('[agent] Failed to send escalation message:', err.message);
    }
    return;
  }

  // ── Normal answer path ────────────────────────────────────────────────
  // FIX #5: Only transition to gathering from triage (not from escalated/other phases)
  // to prevent double-transitions or re-entering gathering after escalation.
  if (INFO_GATHERING_PATTERN.test(answer) && phase === 'triage') {
    console.log(`[agent] ${issue.short_id} — answer contains info-gathering language, transitioning to phase=gathering`);
    await setPhase(issue.id, 'gathering');
  }

  try {
    const msg = await thread.send({ content: `<@${issue.user_discord_id}> ${answer}` });
    await saveMessage({ issueId: issue.id, role: 'assistant', content: answer, discordMsgId: msg.id });
  } catch (err) {
    console.error('[agent] Failed to send answer:', err.message);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runAgent(discordClient, thread, issue, userMessage, member, discordMessage = null) {
  console.log(`[agent] ${issue.short_id} — processing: "${userMessage.slice(0, 60)}"`);

  // ── Speaker role gate ─────────────────────────────────────────────────
  const reporterId = issue.user_discord_id;
  const isStaffFlag = isStaff(member);

  if (isStaffFlag) {
    console.log(`[agent] ${issue.short_id} — staff message, skipping pipeline`);
    return;
  }

  const speakerRole = getSpeakerRole(member?.id, reporterId, false);
  console.log(`[agent] ${issue.short_id} — speaker role: ${speakerRole}`);

  // ── Participant discussion check ──────────────────────────────────────
  const discussing = await isParticipantDiscussion(thread, reporterId, discordClient.user.id);
  if (discussing) {
    console.log(`[agent] ${issue.short_id} — participant discussion detected, skipping`);
    return;
  }

  // FIX #1 & #2: Check phase BEFORE intent classification.
  // If the issue is in 'gathering' phase, bypass intent entirely and go straight
  // to evidence collection. This prevents UNCLEAR/CASUAL intent gates from
  // swallowing evidence replies like "Stripe - 10900807" or bare user IDs.
  const { phase: currentPhase } = await fetchIssueEvidence(issue.id);
  if (currentPhase === 'gathering') {
    console.log(`[agent] ${issue.short_id} — phase=gathering, bypassing intent gate`);
    await processSingleQuestion(discordClient, thread, issue, userMessage, member, discordMessage);
    return;
  }

  // ── Intent classification ──────────────────────────────────────────────
  const { intent, messageType, reply: casualReply } = await classifyIntent(userMessage);
  console.log(`[agent] Intent: ${intent}|${messageType}`);

  // Acknowledgement — skip entirely, no reply
  if (messageType === 'acknowledgement') {
    console.log(`[agent] ${issue.short_id} — acknowledgement, skipping`);
    return;
  }

  // CASUAL — reply directly, no LLM or RAG needed
  if (intent === 'CASUAL') {
    try {
      const msg = await thread.send({ content: casualReply });
      await saveMessage({ issueId: issue.id, role: 'assistant', content: casualReply, discordMsgId: msg.id });
    } catch (err) {
      console.error('[agent] Failed to send casual reply:', err.message);
    }
    return;
  }

  // STATUS — return issue status from DB
  if (intent === 'STATUS') {
    try {
      const statusReply = `Your issue **${issue.short_id}** is currently **${issue.status}**. A team member will update this thread when there is progress.`;
      const msg = await thread.send({ content: `<@${reporterId}> ${statusReply}` });
      await saveMessage({ issueId: issue.id, role: 'assistant', content: statusReply, discordMsgId: msg.id });
    } catch (err) {
      console.error('[agent] Failed to send status reply:', err.message);
    }
    return;
  }

  // UNCLEAR — ask for more detail
  if (intent === 'UNCLEAR') {
    try {
      const clarifyReply = `Could you give me a bit more detail about what's happening? For example, any error messages you're seeing or what you were trying to do when this occurred.`;
      const msg = await thread.send({ content: `<@${reporterId}> ${clarifyReply}` });
      await saveMessage({ issueId: issue.id, role: 'assistant', content: clarifyReply, discordMsgId: msg.id });
    } catch (err) {
      console.error('[agent] Failed to send clarify reply:', err.message);
    }
    return;
  }

  // QUESTION or COMPLAINT — check if sub-issue routing needed
  if (speakerRole === 'participant') {
    // A non-reporter user is messaging in the thread
    const authorIssue = await findIssueForAuthorInThread(thread.id, member?.id);

    if (!authorIssue) {
      // New participant — might need their own sub-issue
      const existingIssues = await getAllThreadIssues(thread.id);
      const alreadyHasIssue = existingIssues.some(i => i.user_discord_id === member?.id);

      if (!alreadyHasIssue && (intent === 'COMPLAINT' || intent === 'QUESTION') && existingIssues.length >= 1) {
        // Create sub-issue for this participant
        try {
          const authorUser = await discordClient.users.fetch(member?.id);
          const subIssue = await createIssue({
            user: authorUser,
            guild: thread.guild,
            channel: { id: thread.parentId },
            title: userMessage.slice(0, 100),
            description: userMessage,
            stepsTried: null,
          });
          await attachThread(subIssue.id, thread.id);
          subIssue.thread_id = thread.id;

          await saveMessage({ issueId: subIssue.id, role: 'user', content: userMessage });

          // Run pipeline for the sub-issue
          const subContext = await fetchContext(subIssue);
          const subRewrite = await rewriteQueryOnly(userMessage); // returns { query, needsRag, reason }
          const subQuery = subRewrite.query || userMessage.slice(0, 100);
          const [subDocs] = await Promise.all([searchDocs(subQuery, 5)]);
          const subReranked = subDocs.length > 0 ? await rerankResults(subQuery, subDocs) : [];
          const subRagResults = subReranked.map(r => ({ ...subDocs[r.id ?? r.index], score: r.relevance_score }));
          const subAnswer = await generateResponse(userMessage, subRagResults, subContext, subDocs.length > 0);

          if (!subAnswer.toUpperCase().includes('ESCALATE')) {
            try {
              const ansMsg = await thread.send({ content: `<@${authorUser.id}> ${subAnswer}` });
              await saveMessage({ issueId: subIssue.id, role: 'assistant', content: subAnswer, discordMsgId: ansMsg.id });
            } catch (err) {
              console.error('[agent] Failed to send sub-issue answer:', err.message);
            }
          }
        } catch (err) {
          console.error('[agent] Failed to create sub-issue:', err.message);
          try {
            await thread.send({ content: `Got it — I've noted your input. A team member will see this when they review the thread.` });
          } catch (e) { /* silent */ }
        }
        return;
      }

      // Same-issue question/followup: acknowledge and save for staff
      try {
        const reply = `Got it — I've noted your input. A team member will see this when they review the thread.`;
        const msg = await thread.send({ content: reply });
        await saveMessage({ issueId: issue.id, role: 'assistant', content: reply, discordMsgId: msg.id });
      } catch (err) {
        console.error('[agent] Failed to send participant acknowledgement:', err.message);
      }
      return;
    }
  }

  // ── Main pipeline: reporter's QUESTION or COMPLAINT ────────────────────
  await processSingleQuestion(discordClient, thread, issue, userMessage, member, discordMessage);
}

module.exports = { runAgent };