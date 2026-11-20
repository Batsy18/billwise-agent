/**
 * npm run demo [-- --only a,d] [-- --reseed]
 * Scripted, non-interactive run against the real stack (billing-api + mcp-server + Gemini):
 *   a–c the three required scenarios, d a confirmed payment, e–h retrieval robustness (note 5b).
 * Starts billing-api / mcp-server from their dist/ builds if they are not running, re-seeds the
 * DB (only automatically for a localhost BILLING_API_URL), prints a summary table and saves the
 * trace. Exits cleanly when GEMINI_API_KEY is missing.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BillingClient } from './clients/billing';
import { loadAgentConfig, loadEnvFile } from './config';
import { createAgent, createLlm, formatSummary, openDocs } from './setup';
import { str, Trace, type TraceStep } from './trace';

const ROOT = path.resolve(__dirname, '../../..');
const DEMO_USER = '5551000002';

export interface DemoQuestion {
  id: string;
  label: string;
  question: string;
  /** Scripted answer to the payment confirmation prompt. */
  confirm?: string;
}

export const DEMO_QUESTIONS: readonly DemoQuestion[] = [
  { id: 'a', label: 'MCP-only', question: 'Ek internet ne kadar?' },
  { id: 'b', label: 'API-only', question: 'Ekim faturam ne kadar?' },
  { id: 'c', label: 'Combined', question: 'Ekim faturam neden yüksek?' },
  {
    id: 'd',
    label: 'Confirmed payment',
    question: 'Ekim faturamın 30 dolarını öde',
    confirm: 'EVET',
  },
  { id: 'e', label: 'Robustness 5b', question: 'Faturamı ödemezsem ne olur?' },
  {
    id: 'f',
    label: 'Robustness 5b',
    question: 'Faturama itiraz etmek istiyorum, şikâyetimi nasıl yaparım?',
  },
  { id: 'g', label: 'Robustness 5b', question: 'Müşteri hizmetleri paramı geri verebilir mi?' },
  { id: 'h', label: 'Robustness 5b', question: 'Faturaya vergi dahil mi?' },
];

export function parseArgs(argv: readonly string[]): { only: Set<string> | null; reseed: boolean } {
  const i = argv.indexOf('--only');
  const raw = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--only='))?.slice(7);
  const only = raw
    ? new Set(
        raw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      )
    : null;
  if (only) {
    const valid = new Set(DEMO_QUESTIONS.map((q) => q.id));
    const bad = [...only].filter((x) => !valid.has(x));
    if (bad.length) throw new Error(`--only: unknown scenario(s) ${bad.join(', ')} (use a–h)`);
  }
  return { only, reseed: argv.includes('--reseed') };
}

export function isLocalUrl(url: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
}

async function healthy(url: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

async function ensureService(
  name: string,
  healthUrl: string,
  entry: string,
  children: ChildProcess[],
): Promise<void> {
  if (await healthy(healthUrl)) return void console.log(`✓ ${name} is running (${healthUrl})`);
  if (!isLocalUrl(healthUrl)) {
    // Cloud URL: never start a local copy in its place. Cloud Run scales to zero, so give a
    // cold start (~8 s measured) time: 3 tries with a 15 s timeout each.
    console.log(`… waiting for ${name} (cold start?)`);
    for (let i = 0; i < 3; i += 1) {
      if (await healthy(healthUrl, 15_000))
        return void console.log(`✓ ${name} is up (${healthUrl})`);
    }
    throw new Error(`${name} is not reachable at ${healthUrl} (is the cloud deployment up?)`);
  }
  if (!existsSync(entry))
    throw new Error(
      `${name} is not running and ${entry} is missing — run \`npm run build\` first.`,
    );
  console.log(`… starting ${name} (${path.relative(ROOT, entry)})`);
  const child = spawn(process.execPath, [entry], { cwd: ROOT, stdio: 'ignore', env: process.env });
  children.push(child);
  for (let i = 0; i < 40; i += 1) {
    if (await healthy(healthUrl)) return void console.log(`✓ ${name} started`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} did not become healthy at ${healthUrl}`);
}

/** Tools + inputs, guide sections and bill fields used — one table row per question. */
function summarize(steps: TraceStep[]) {
  const tools: string[] = [];
  const sections = new Set<string>();
  const fields: string[] = [];
  for (const s of steps) {
    if (s.type !== 'tool') continue;
    tools.push(`${s.name}(${JSON.stringify(s.input)})`);
    const r = (s.result ?? {}) as Record<string, unknown>;
    for (const m of (r.matches as { section: string }[] | undefined) ?? []) sections.add(m.section);
    const b = r.bill as Record<string, unknown> | undefined;
    if (b) {
      const usage = b.usage as Record<string, unknown> | undefined;
      fields.push(
        `total ${String(b.total)}, remaining ${String(b.remainingBalance)}, ${String(b.status)}` +
          (usage ? `, ${String(usage.phoneMinutes)} min / ${String(usage.internetGB)} GB` : ''),
      );
    }
    if (r.status && !b && !r.matches) fields.push(str(r.status));
    if (r.status === 'paid') {
      const p = r.payment as Record<string, unknown>;
      fields.push(`remaining ${String(p.remainingBalance)}, ${String(p.billStatus)}`);
    }
  }
  return { tools, sections: [...sections], fields };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

async function main(): Promise<void> {
  const envOverlay = loadEnvFile();
  if (envOverlay) console.log(`env: ${envOverlay} + .env`);
  const { only, reseed } = parseArgs(process.argv.slice(2));
  if (!process.env.GEMINI_API_KEY) {
    console.log(
      'GEMINI_API_KEY is not set — skipping the live demo (unit tests cover the agent with a mock LLM).',
    );
    return;
  }
  const config = loadAgentConfig({ ...process.env, LLM_PROVIDER: 'gemini' });
  const questions = DEMO_QUESTIONS.filter((q) => !only || only.has(q.id));
  const children: ChildProcess[] = [];
  const log = (m: string) => console.log(m);

  try {
    await ensureService(
      'billing-api',
      `${config.BILLING_API_URL}/api/v1/health/ready`,
      path.join(ROOT, 'packages/billing-api/dist/index.js'),
      children,
    );
    await ensureService(
      'mcp-server',
      new URL('/health', config.MCP_URL).href,
      path.join(ROOT, 'packages/mcp-server/dist/http.js'),
      children,
    );

    if (isLocalUrl(config.BILLING_API_URL) || reseed) {
      console.log('… re-seeding the database (reproducible demo state)');
      try {
        execFileSync(process.execPath, [path.join(ROOT, 'packages/billing-api/dist/db/seed.js')], {
          cwd: ROOT,
          stdio: 'inherit',
        });
      } catch (err) {
        if (isLocalUrl(config.BILLING_API_URL)) throw err;
        // Cloud: DATABASE_URL in .env.cloud points at a local Cloud SQL Auth Proxy.
        throw new Error(
          'Re-seeding Cloud SQL failed — is the Cloud SQL Auth Proxy running? (infra/README.md)',
          { cause: err },
        );
      }
    } else {
      console.log(
        `! ${config.BILLING_API_URL} is not local: NOT re-seeding (pass --reseed to force).`,
      );
    }

    const billing = new BillingClient(config.BILLING_API_URL);
    const session = await billing.login(DEMO_USER, process.env.SEED_USER_PASSWORD ?? '');
    const docs = await openDocs(config, log);
    const llm = createLlm(config, log, { paced: true });
    const trace = new Trace({
      meta: { mode: 'demo', llm: llm.name, docsTransport: docs.transport, subscriber: DEMO_USER },
    });
    console.log(
      `\nDemo as ${DEMO_USER} with ${llm.name}; docs via ${docs.transport}; ${questions.length} question(s)\n`,
    );

    const rows: string[] = [];
    try {
      for (const q of questions) {
        console.log(`[${q.id}] ${q.label}: ${q.question}`);
        // Fresh conversation per question: clean traces, fewer tokens.
        const { agent } = createAgent({
          llm,
          billing,
          docs,
          session,
          trace,
          confirm: (s) => {
            console.log(formatSummary(s));
            const answer = q.confirm ?? 'hayır';
            console.log(`  > ${answer}   (scripted)`);
            return Promise.resolve(answer);
          },
        });
        const a = await agent.ask(q.question);
        console.log(`  ⇒ ${a.text}\n`);
        const s = summarize(trace.exchanges[trace.exchanges.length - 1]!.steps);
        rows.push(
          `| ${q.id} | ${cell(q.question)} | ${cell(s.tools.join('<br>') || '—')} | ${cell(s.sections.join(', ') || '—')} | ${cell(s.fields.join('; ') || '—')} | ${cell(a.text.length > 220 ? `${a.text.slice(0, 217)}…` : a.text)} |`,
        );
        if (a.reason === 'llm_unavailable') break;
      }
    } finally {
      await docs.close();
      const file = trace.save();
      const u = trace.totalUsage();
      console.log(
        '| # | Question | Tools called (inputs) | Guide sections | Bill fields / status | Answer |',
      );
      console.log('|---|---|---|---|---|---|');
      for (const r of rows) console.log(r);
      console.log(
        `\nGemini usage: ${u.requests} requests, ${u.inputTokens} input + ${u.outputTokens} output + ${u.thinkingTokens} thinking tokens`,
      );
      console.log(`Trace: ${file}`);
    }
  } finally {
    for (const c of children) c.kill();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    // e.g. NetworkError → TypeError "fetch failed" → the socket error with its code
    for (let c = (err as Error)?.cause; c instanceof Error; c = c.cause) {
      console.error(`  caused by: ${c.message}${'code' in c ? ` (${String(c.code)})` : ''}`);
    }
    process.exitCode = 1;
  });
}
