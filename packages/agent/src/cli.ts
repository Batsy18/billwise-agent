/**
 * npm run chat — interactive CLI. Logs in (password not echoed), keeps the JWT in memory only,
 * prints a compact tool trace and writes traces/<timestamp>.json on exit.
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { BillingClient, LoginError, type Session } from './clients/billing';
import { loadAgentConfig, loadEnvFile } from './config';
import { createAgent, createLlm, formatSummary, openDocs } from './setup';
import { Trace } from './trace';

/** readline with switchable echo, so the password is not shown. */
function terminal(): { rl: Interface; mute: (on: boolean) => void } {
  let muted = false;
  const out = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return { rl, mute: (on) => (muted = on) };
}

async function login(billing: BillingClient, term: ReturnType<typeof terminal>): Promise<Session> {
  for (;;) {
    const no = (await term.rl.question('Subscriber number / Abone numarası: ')).trim();
    process.stdout.write('Password / Şifre: ');
    term.mute(true);
    const pw = await term.rl.question('');
    term.mute(false);
    process.stdout.write('\n');
    try {
      return await billing.login(no, pw);
    } catch (err) {
      if (!(err instanceof LoginError)) throw err;
      console.log(`  ✗ ${err.message}`);
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadAgentConfig(process.env);
  const log = (m: string) => console.log(m);
  const billing = new BillingClient(config.BILLING_API_URL);
  const docs = await openDocs(config, log);
  const llm = createLlm(config, log);
  const trace = new Trace({ meta: { mode: 'chat', llm: llm.name, docsTransport: docs.transport } });
  const term = terminal();

  console.log(
    `billwise agent — ${llm.name}, docs via ${docs.transport}, API ${config.BILLING_API_URL}`,
  );
  let session = await login(billing, term);
  console.log(`Logged in as ${session.subscriberNo}. Type "exit" to quit. / Çıkmak için "exit".\n`);

  const confirm = async (s: Parameters<typeof formatSummary>[0]) => {
    console.log(formatSummary(s));
    return term.rl.question('  > ');
  };
  let { agent } = createAgent({ llm, billing, docs, session, confirm, trace });

  try {
    for (;;) {
      const q = (await term.rl.question('you> ')).trim();
      if (!q) continue;
      if (/^(exit|quit|çıkış)$/i.test(q)) break;
      const a = await agent.ask(q);
      console.log(`\nassistant> ${a.text}\n`);
      if (session.expired) {
        console.log(
          'Your session expired; please log in again. / Oturum süresi doldu, tekrar giriş yapın.',
        );
        session = await login(billing, term);
        ({ agent } = createAgent({ llm, billing, docs, session, confirm, trace }));
      }
    }
  } finally {
    term.rl.close();
    await docs.close();
    if (trace.exchanges.length) console.log(`Trace saved: ${trace.save()}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
