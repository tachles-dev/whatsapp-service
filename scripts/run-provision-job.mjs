import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function nowIso() {
  return new Date().toISOString();
}

async function appendLog(logFile, text) {
  await fs.appendFile(logFile, `[${nowIso()}] ${text}\n`);
}

async function updateJob(jobFile, mutate) {
  const raw = await fs.readFile(jobFile, 'utf8');
  const current = JSON.parse(raw);
  const next = mutate(current);
  await fs.writeFile(jobFile, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) {
    throw new Error('Usage: node scripts/run-provision-job.mjs <job-file>');
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, '..');
  const provisionScript = path.join(rootDir, 'scripts', 'provision-instance.sh');

  let job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  const logFile = job.logFile;

  await updateJob(jobFile, (current) => ({
    ...current,
    status: 'running',
    startedAt: nowIso(),
    error: undefined,
  }));
  await appendLog(logFile, `started provisioning job ${job.id}`);

  const args = [
    provisionScript,
    '--slug', job.input.slug,
    '--domain', job.input.domain,
    '--app-port', job.input.appPort,
    '--webhook-url', job.input.webhookUrl,
    '--profile', job.input.profile,
    '--instance-root', process.env.WGS_INSTANCE_ROOT?.trim() || '/opt/wgs-instances',
    '--start',
  ];

  if (job.input.webhookApiKey) {
    args.push('--webhook-api-key', job.input.webhookApiKey);
  }

  if (job.input.installEdgeSnippet !== false) {
    args.push('--install-edge-snippet');
    if (process.env.WGS_EDGE_IMPORT_DIR?.trim()) {
      args.push('--edge-import-dir', process.env.WGS_EDGE_IMPORT_DIR.trim());
    }
  }

  if (process.env.WGS_DNS_HOOK_COMMAND?.trim()) {
    args.push('--dns-hook-command', process.env.WGS_DNS_HOOK_COMMAND.trim());
  }

  if (job.input.bootstrapClientId && job.input.bootstrapDeviceName) {
    args.push(
      '--bootstrap-client-id', job.input.bootstrapClientId,
      '--bootstrap-device-name', job.input.bootstrapDeviceName,
    );
  }

  try {
    const result = await execFileAsync('bash', args, {
      cwd: rootDir,
      env: process.env,
      maxBuffer: 1024 * 1024,
    });

    if (result.stdout) {
      await fs.appendFile(logFile, result.stdout);
    }
    if (result.stderr) {
      await fs.appendFile(logFile, result.stderr);
    }

    await updateJob(jobFile, (current) => ({
      ...current,
      status: 'succeeded',
      finishedAt: nowIso(),
    }));
    await appendLog(logFile, `finished provisioning job ${job.id} successfully`);
  } catch (error) {
    const stdout = typeof error === 'object' && error && 'stdout' in error ? String(error.stdout ?? '') : '';
    const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr ?? '') : '';
    const message = error instanceof Error ? error.message : String(error);
    if (stdout) await fs.appendFile(logFile, stdout);
    if (stderr) await fs.appendFile(logFile, stderr);
    await appendLog(logFile, `job failed: ${message}`);

    await updateJob(jobFile, (current) => ({
      ...current,
      status: 'failed',
      finishedAt: nowIso(),
      error: message,
    }));

    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});