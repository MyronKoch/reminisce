#!/usr/bin/env bun
/**
 * LongMemEvalS Benchmark Adapter for Reminisce
 *
 * Evaluates Reminisce's memory architecture against the LongMemEval benchmark
 * (Wu et al., ICLR 2025). For each of 500 questions:
 * 1. Ingests haystack sessions as episodic memories
 * 2. Runs consolidation to extract semantic facts
 * 3. Queries Reminisce with the question
 * 4. Uses an LLM to generate a hypothesis from retrieved context
 *
 * Output: JSONL file for scoring with evaluate_qa.py
 *
 * Usage:
 *   bun run src/longmemeval.ts [--limit N] [--offset N] [--output path] [--no-consolidate] [--model model]
 */

import { Reminisce, type ReminisceConfig } from '@reminisce/orchestrator';
import type { EpisodeInput } from '@reminisce/episodic';

// ─── Types ─────────────────────────────────────────────

interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  // Sessions are arrays of turn objects (not wrapped in {session_id, turns})
  // Session IDs come from haystack_session_ids at the same index
  haystack_sessions: Array<Array<{
    role: 'user' | 'assistant';
    content: string;
    has_answer?: boolean;
  }>>;
}

interface BenchResult {
  question_id: string;
  question_type: string;
  hypothesis: string;
  ground_truth: string;
  retrieved_facts: number;
  retrieved_episodes: number;
  latency_ms: number;
}

// ─── Config ────────────────────────────────────────────

const DATA_PATH = new URL('../longmemeval_s.json', import.meta.url).pathname;
const DEFAULT_OUTPUT = new URL('../results/hypotheses.jsonl', import.meta.url).pathname;
const EMBED_URL = process.env.REMINISCE_EMBED_URL || 'http://localhost:1234';
const EMBED_MODEL = process.env.REMINISCE_EMBED_MODEL || 'text-embedding-embeddinggemma-300m';
// LLM provider: 'claude' (via CLI subprocess) or 'api' (OpenAI-compatible endpoint)
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'claude';
const LLM_TIER = process.env.LLM_TIER || 'fast'; // fast=Haiku, standard=Sonnet, smart=Opus
const LLM_URL = process.env.LLM_URL || 'https://models.inference.ai.azure.com';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o';
// ─── Helpers ───────────────────────────────────────────

async function generateHypothesis(
  question: string,
  context: string,
  questionDate: string,
): Promise<string> {
  const systemPrompt = `You are answering a question about a user's past conversations. Use ONLY the provided memory context to answer. If the context does not contain the answer, say "I don't have information about that."

Today's date: ${questionDate}

Be concise and direct. Answer in 1-2 sentences maximum.`;

  const userPrompt = `Memory context:
${context}

Question: ${question}`;

  if (LLM_PROVIDER === 'claude') {
    return generateViaClaude(systemPrompt, userPrompt);
  }
  return generateViaAPI(systemPrompt, userPrompt);
}

const CLAUDE_MODELS: Record<string, string> = {
  fast: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-4-6',
  smart: 'claude-opus-4-6',
};

/** Generate via Claude CLI subprocess (uses Claude Code subscription, no API key) */
async function generateViaClaude(systemPrompt: string, userPrompt: string): Promise<string> {
  try {
    const model = CLAUDE_MODELS[LLM_TIER] || CLAUDE_MODELS.fast;
    const fullPrompt = `<system>${systemPrompt}</system>\n\n${userPrompt}`;
    const proc = Bun.spawnSync(
      ['claude', '--print', '--model', model, fullPrompt],
      { timeout: 30_000 }
    );
    if (proc.exitCode !== 0) {
      const err = proc.stderr.toString().trim();
      console.error(`  Claude failed: ${err.slice(0, 100)}`);
      return 'Error generating answer.';
    }
    return proc.stdout.toString().trim();
  } catch (e) {
    console.error(`  Claude error: ${e}`);
    return 'Error generating answer.';
  }
}

/** Generate via OpenAI-compatible API (LM Studio, GitHub Models, etc.) */
async function generateViaAPI(systemPrompt: string, userPrompt: string): Promise<string> {
  try {
    const chatPath = LLM_URL.includes('azure.com') ? '/chat/completions' : '/v1/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Try GitHub token for GitHub Models
    if (LLM_URL.includes('azure.com')) {
      try {
        const proc = Bun.spawnSync(['gh', 'auth', 'token']);
        const token = proc.stdout.toString().trim();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } catch { /* no gh */ }
    }
    const res = await fetch(`${LLM_URL}${chatPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 256,
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`LLM API ${res.status}`);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content?.trim() || 'No answer generated.';
  } catch (e) {
    console.error(`  LLM failed: ${e}`);
    return 'Error generating answer.';
  }
}

function buildContextFromResults(results: {
  working: Array<{ summary?: string }>;
  episodic: Array<{ event?: string; summary?: string; score?: number }>;
  semantic: Array<{ fact: string; relevance?: number }>;
}): string {
  const parts: string[] = [];

  if (results.semantic.length > 0) {
    parts.push('Known facts:');
    for (const f of results.semantic.slice(0, 15)) {
      const score = f.relevance !== undefined ? ` [relevance: ${f.relevance.toFixed(3)}]` : '';
      parts.push(`- ${f.fact}${score}`);
    }
  }

  if (results.episodic.length > 0) {
    parts.push('\nRelevant conversation excerpts:');
    for (const e of results.episodic.slice(0, 10)) {
      const text = (e.summary || e.event || '(no summary)').slice(0, 2500);
      parts.push(`- ${text}`);
    }
  }

  return parts.join('\n') || 'No relevant memories found.';
}

/** Rank episodes by keyword overlap with query (BM25-lite) */
function rankByKeywordOverlap(
  query: string,
  episodes: Array<{ content: { event?: string; summary?: string }; memory_id: { id: string } } & Record<string, unknown>>,
): Array<{ episode: typeof episodes[0]; score: number }> {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const querySet = new Set(queryTerms);

  return episodes
    .map(ep => {
      const text = `${ep.content.event || ''} ${ep.content.summary || ''}`.toLowerCase();
      let matches = 0;
      for (const term of querySet) {
        if (text.includes(term)) matches++;
      }
      const score = querySet.size > 0 ? matches / querySet.size : 0;
      return { episode: ep, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ─── Main ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const offsetIdx = args.indexOf('--offset');
  const offset = offsetIdx >= 0 ? parseInt(args[offsetIdx + 1], 10) : 0;
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : DEFAULT_OUTPUT;
  const doConsolidate = !args.includes('--no-consolidate');

  console.log('Loading LongMemEvalS dataset...');
  const raw = await Bun.file(DATA_PATH).text();
  const dataset: LongMemEvalQuestion[] = JSON.parse(raw);
  console.log(`Loaded ${dataset.length} questions`);

  const questions = dataset.slice(offset, offset + limit);
  console.log(`Processing ${questions.length} questions (offset=${offset}, limit=${limit})`);
  console.log(`Consolidation: ${doConsolidate ? 'ON' : 'OFF'}`);
  if (LLM_PROVIDER === 'claude') {
    console.log(`LLM: Claude via Inference.ts (tier: ${LLM_TIER})`);
  } else {
    console.log(`LLM: ${LLM_MODEL} @ ${LLM_URL}`);
  }
  console.log(`Output: ${outputPath}\n`);

  // Ensure output directory exists
  const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
  await Bun.write(outputDir + '/.gitkeep', '');

  // Parse concurrency from args (default 10)
  const concIdx = args.indexOf('--concurrency');
  const CONCURRENCY = concIdx >= 0 ? parseInt(args[concIdx + 1], 10) : 10;
  console.log(`Concurrency: ${CONCURRENCY} parallel questions\n`);

  /** Process a single question - isolated, stateless */
  async function processQuestion(q: LongMemEvalQuestion, idx: number): Promise<BenchResult> {
    const start = performance.now();

    const config: ReminisceConfig = {
      machineId: 'eval',
      autoConsolidate: false,
      consolidation: { minAgeHours: 0, minSalience: 0.1, batchSize: 50 },
    };
    const reminisce = new Reminisce(config);
    reminisce.startSession();

    // Ingest haystack sessions as episodes
    let ingestedTurns = 0;
    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const turns = q.haystack_sessions[si];
      const sessionId = q.haystack_session_ids[si] || `session-${si}`;
      if (!Array.isArray(turns) || turns.length === 0) continue;

      const userTurns = turns.filter(t => t.role === 'user').map(t => t.content);
      const assistantTurns = turns.filter(t => t.role === 'assistant').map(t => t.content);
      const userContent = userTurns.join('\n').slice(0, 2000);
      const assistantContent = assistantTurns.join('\n').slice(0, 1000);

      await reminisce.recordEpisode({
        event: `Session ${sessionId}: ${userTurns[0]?.slice(0, 150) || 'conversation'}`,
        summary: `User said: ${userContent}\n\nAssistant said: ${assistantContent}`,
        sessionId,
        entities: extractEntities(userContent),
        tags: [],
      });
      ingestedTurns += turns.length;
    }

    if (doConsolidate) {
      try { await reminisce.consolidate(); } catch { /* OK */ }
    }

    // Retrieve
    const searchResults = await reminisce.search({ text: q.question, limit: 20 });
    const allEpisodes = await reminisce.getRecentEpisodes(1000);
    const rankedEpisodes = rankByKeywordOverlap(q.question, allEpisodes);

    const context = buildContextFromResults({
      working: searchResults.working.map(w => ({ summary: w.content.summary })),
      episodic: rankedEpisodes.slice(0, 15).map(e => ({
        event: e.episode.content.event,
        summary: e.episode.content.summary,
        score: e.score,
      })),
      semantic: searchResults.semantic.map(s => ({ fact: s.content.fact })),
    });

    // Generate hypothesis
    const hypothesis = await generateHypothesis(q.question, context, q.question_date);
    const elapsed = performance.now() - start;

    console.log(`[${idx + 1}/${questions.length}] ${q.question_type}: "${q.question.slice(0, 50)}..." -> "${hypothesis.slice(0, 60)}..." (${Math.round(elapsed)}ms)`);

    await reminisce.endSession();

    return {
      question_id: q.question_id,
      question_type: q.question_type,
      hypothesis,
      ground_truth: String(q.answer),
      retrieved_facts: searchResults.semantic.length,
      retrieved_episodes: rankedEpisodes.length,
      latency_ms: Math.round(elapsed),
    };
  }

  // Load checkpoint if exists (resume from previous interrupted run)
  const detailedPath = outputPath.replace('.jsonl', '.detailed.json');
  const completed = new Map<string, BenchResult>();
  try {
    const existing: BenchResult[] = JSON.parse(await Bun.file(detailedPath).text());
    for (const r of existing) completed.set(r.question_id, r);
    if (completed.size > 0) {
      console.log(`Resuming: ${completed.size} questions already completed, ${questions.length - completed.size} remaining\n`);
    }
  } catch { /* no checkpoint */ }

  // Process questions in parallel batches with incremental checkpointing
  const results: BenchResult[] = [...completed.values()];
  const remaining = questions.filter(q => !completed.has(q.question_id));
  const typeCounts: Record<string, { total: number; answered: number }> = {};

  // Rebuild typeCounts from checkpoint
  for (const r of results) {
    if (!typeCounts[r.question_type]) typeCounts[r.question_type] = { total: 0, answered: 0 };
    typeCounts[r.question_type].total++;
    if (!r.hypothesis.toLowerCase().includes("don't have information") && !r.hypothesis.includes('Error generating')) {
      typeCounts[r.question_type].answered++;
    }
  }

  for (let batch = 0; batch < remaining.length; batch += CONCURRENCY) {
    const batchQuestions = remaining.slice(batch, batch + CONCURRENCY);
    const batchStart = performance.now();

    const batchResults = await Promise.all(
      batchQuestions.map((q, i) => processQuestion(q, completed.size + batch + i))
    );

    for (const r of batchResults) {
      results.push(r);
      if (!typeCounts[r.question_type]) typeCounts[r.question_type] = { total: 0, answered: 0 };
      typeCounts[r.question_type].total++;
      if (!r.hypothesis.toLowerCase().includes("don't have information") && !r.hypothesis.includes('Error generating')) {
        typeCounts[r.question_type].answered++;
      }
    }

    // Checkpoint after each batch
    await Bun.write(detailedPath, JSON.stringify(results, null, 2));

    const batchElapsed = Math.round(performance.now() - batchStart);
    const done = results.length;
    console.log(`--- Batch ${Math.floor(batch / CONCURRENCY) + 1}: ${done}/${questions.length} done (${batchElapsed}ms) [checkpointed] ---\n`);
  }

  // Write final JSONL output (format required by evaluate_qa.py)
  const jsonl = results.map(r => JSON.stringify({
    question_id: r.question_id,
    hypothesis: r.hypothesis,
  })).join('\n');
  await Bun.write(outputPath, jsonl);
  console.log(`\nResults written to ${outputPath}`);
  console.log(`Detailed results written to ${detailedPath}`);

  // Summary
  console.log('\n=== BENCHMARK SUMMARY ===');
  console.log(`Total questions: ${results.length}`);
  console.log(`Avg latency: ${Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / results.length)}ms`);
  console.log(`Avg facts retrieved: ${(results.reduce((s, r) => s + r.retrieved_facts, 0) / results.length).toFixed(1)}`);
  console.log(`Avg episodes retrieved: ${(results.reduce((s, r) => s + r.retrieved_episodes, 0) / results.length).toFixed(1)}`);
  console.log('\nPer-type breakdown:');
  for (const [type, counts] of Object.entries(typeCounts)) {
    console.log(`  ${type}: ${counts.answered}/${counts.total} answered (${Math.round(counts.answered / counts.total * 100)}%)`);
  }
}

/** Simple entity extraction - pull capitalized phrases and quoted strings */
function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  // Capitalized multi-word phrases
  const caps = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
  if (caps) caps.forEach(e => entities.add(e));
  // Quoted strings
  const quoted = text.match(/"([^"]+)"/g);
  if (quoted) quoted.forEach(e => entities.add(e.replace(/"/g, '')));
  // Limit to top 10
  return [...entities].slice(0, 10);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
