#!/usr/bin/env bun
/**
 * Score LongMemEvalS benchmark results using LLM-as-judge.
 *
 * Compares each hypothesis against ground truth and scores as correct/incorrect.
 * Uses Groq (Llama 3.3 70B) for fast, free scoring.
 *
 * Usage:
 *   bun run src/score.ts results/run1-claude-haiku-keyword.detailed.json
 *   bun run src/score.ts results/run3-claude-opus-keyword.detailed.json --concurrency 5
 */

// Judge provider: 'groq' or 'local' (LM Studio)
const JUDGE_PROVIDER = process.env.JUDGE_PROVIDER || 'local'; // 'local' = LM Studio, 'groq' = Groq API
const GROQ_KEY_FILE = process.env.GROQ_KEY_FILE || '/tmp/groq-key';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const LOCAL_URL = 'http://localhost:1234/v1/chat/completions';
const LOCAL_MODEL = 'qwen/qwen3-next-80b';

interface DetailedResult {
  question_id: string;
  question_type: string;
  hypothesis: string;
  ground_truth: string;
  retrieved_facts: number;
  retrieved_episodes: number;
  latency_ms: number;
}

interface ScoredResult extends DetailedResult {
  correct: boolean;
  judge_reasoning: string;
}

async function getGroqKey(): Promise<string> {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  try {
    return (await Bun.file(GROQ_KEY_FILE).text()).trim();
  } catch {
    throw new Error(`Groq API key not found. Set GROQ_API_KEY env var or create ${GROQ_KEY_FILE}`);
  }
}

async function judgeAnswer(
  apiKey: string,
  question_id: string,
  hypothesis: string,
  groundTruth: string,
): Promise<{ correct: boolean; reasoning: string }> {
  // Skip obvious non-answers
  if (hypothesis.includes('Error generating') || hypothesis.includes("don't have information") || hypothesis.includes("I don't have")) {
    return { correct: false, reasoning: 'Abstained or error' };
  }

  const prompt = `You are judging whether a hypothesis answer is correct compared to the ground truth answer.

Ground truth: ${groundTruth}
Hypothesis: ${hypothesis}

Does the hypothesis contain the correct answer? The hypothesis does NOT need to be word-for-word identical - it just needs to convey the same key information. Be precise. The hypothesis is correct only if it contains the same key factual information as the ground truth. Different phrasing is acceptable, but the core factual claim must match.

Respond with EXACTLY one line in this format:
CORRECT: [yes/no] | REASON: [brief explanation]`;

  try {
    const isLocal = JUDGE_PROVIDER === 'local';
    const url = isLocal ? LOCAL_URL : GROQ_URL;
    const model = isLocal ? LOCAL_MODEL : GROQ_MODEL;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!isLocal) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0,
      }),
    });

    if (res.status === 429) {
      // Rate limited - skip this question (will be caught by checkpoint resume)
      console.error(`  Rate limited on ${question_id}, marking as judge error`);
      return { correct: false, reasoning: 'Judge rate limited' };
    }

    if (!res.ok) throw new Error(`Groq API ${res.status}`);

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const response = data.choices[0]?.message?.content?.trim() || '';

    const correct = response.toLowerCase().includes('correct: yes');
    const reasonMatch = response.match(/REASON:\s*(.+)/i);
    const reasoning = reasonMatch?.[1]?.trim() || response;

    return { correct, reasoning };
  } catch (e) {
    console.error(`  Judge error on ${question_id}: ${e}`);
    return { correct: false, reasoning: `Judge error: ${e}` };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: bun run src/score.ts <detailed-results.json> [--concurrency N]');
    process.exit(1);
  }

  const inputPath = args[0];
  const concIdx = args.indexOf('--concurrency');
  const concurrency = concIdx >= 0 ? parseInt(args[concIdx + 1], 10) : 5;

  const apiKey = await getGroqKey();
  const data: DetailedResult[] = JSON.parse(await Bun.file(inputPath).text());

  console.log(`Scoring ${data.length} results from ${inputPath}`);
  console.log(`Judge: ${GROQ_MODEL} via Groq`);
  console.log(`Concurrency: ${concurrency}\n`);

  // Load checkpoint if exists
  const outputPath = inputPath.replace('.detailed.json', '.scored.json');
  const completedIds = new Set<string>();
  const scored: ScoredResult[] = [];
  try {
    const existing: ScoredResult[] = JSON.parse(await Bun.file(outputPath).text());
    for (const r of existing) { scored.push(r); completedIds.add(r.question_id); }
    if (completedIds.size > 0) {
      console.log(`Resuming: ${completedIds.size} already scored, ${data.length - completedIds.size} remaining\n`);
    }
  } catch { /* no checkpoint */ }

  const remaining = data.filter(r => !completedIds.has(r.question_id));
  const typeStats: Record<string, { total: number; correct: number; abstained: number }> = {};

  // Rebuild stats from checkpoint
  for (const r of scored) {
    if (!typeStats[r.question_type]) typeStats[r.question_type] = { total: 0, correct: 0, abstained: 0 };
    typeStats[r.question_type].total++;
    if (r.judge_reasoning === 'Abstained or error') typeStats[r.question_type].abstained++;
    else if (r.correct) typeStats[r.question_type].correct++;
  }

  // Process remaining in batches
  for (let batch = 0; batch < remaining.length; batch += concurrency) {
    const batchItems = remaining.slice(batch, batch + concurrency);

    const batchResults = await Promise.all(
      batchItems.map(async (r) => {
        const { correct, reasoning } = await judgeAnswer(apiKey, r.question_id, r.hypothesis, r.ground_truth);
        return { ...r, correct, judge_reasoning: reasoning } as ScoredResult;
      })
    );

    for (const r of batchResults) {
      scored.push(r);

      if (!typeStats[r.question_type]) {
        typeStats[r.question_type] = { total: 0, correct: 0, abstained: 0 };
      }
      typeStats[r.question_type].total++;
      if (r.hypothesis.includes('Error generating') || r.hypothesis.toLowerCase().includes("don't have information") || r.hypothesis.toLowerCase().includes("i don't have")) {
        typeStats[r.question_type].abstained++;
      } else if (r.correct) {
        typeStats[r.question_type].correct++;
      }
    }

    // Checkpoint after each batch
    await Bun.write(outputPath, JSON.stringify(scored, null, 2));

    const done = scored.length;
    const totalCorrect = scored.filter(s => s.correct).length;
    const totalAbstained = scored.filter(s => s.judge_reasoning === 'Abstained or error').length;
    process.stdout.write(`\r  Scored ${done}/${data.length} | Correct: ${totalCorrect} | Abstained: ${totalAbstained} [checkpointed]`);
  }

  console.log('\n');
  console.log(`Scored results written to ${outputPath}\n`);

  // Summary
  const totalCorrect = scored.filter(s => s.correct).length;
  const totalAbstained = scored.filter(s => s.judge_reasoning === 'Abstained or error').length;
  const totalWrong = scored.length - totalCorrect - totalAbstained;

  console.log('=== SCORING SUMMARY ===');
  console.log(`Total: ${scored.length}`);
  console.log(`Correct: ${totalCorrect} (${(totalCorrect * 100 / scored.length).toFixed(1)}%)`);
  console.log(`Wrong: ${totalWrong} (${(totalWrong * 100 / scored.length).toFixed(1)}%)`);
  console.log(`Abstained: ${totalAbstained} (${(totalAbstained * 100 / scored.length).toFixed(1)}%)`);
  console.log(`\nAccuracy (of attempted): ${(totalCorrect * 100 / (totalCorrect + totalWrong)).toFixed(1)}%`);
  console.log(`Accuracy (overall): ${(totalCorrect * 100 / scored.length).toFixed(1)}%\n`);

  console.log('Per-type breakdown:');
  console.log(`${'Category'.padEnd(32)} ${'Correct'.padStart(8)} ${'Wrong'.padStart(8)} ${'Abstain'.padStart(8)} ${'Acc(all)'.padStart(10)} ${'Acc(att)'.padStart(10)}`);
  console.log('-'.repeat(80));
  for (const [type, stats] of Object.entries(typeStats).sort()) {
    const wrong = stats.total - stats.correct - stats.abstained;
    const accAll = (stats.correct * 100 / stats.total).toFixed(1);
    const attempted = stats.correct + wrong;
    const accAtt = attempted > 0 ? (stats.correct * 100 / attempted).toFixed(1) : 'N/A';
    console.log(`${type.padEnd(32)} ${String(stats.correct).padStart(8)} ${String(wrong).padStart(8)} ${String(stats.abstained).padStart(8)} ${(accAll + '%').padStart(10)} ${(accAtt + '%').padStart(10)}`);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
