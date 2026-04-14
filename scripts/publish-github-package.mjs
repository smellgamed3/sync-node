#!/usr/bin/env node
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const scope = (process.env.GITHUB_PACKAGE_SCOPE || '').replace(/^@/, '').toLowerCase();
const npmCommand = 'npm';

function run(command, cwd) {
  execSync(command, { cwd, stdio: 'inherit', shell: true, env: process.env });
}

async function main() {
  if (!scope) {
    throw new Error('GITHUB_PACKAGE_SCOPE is required for GitHub Packages publishing');
  }

  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const baseName = String(pkg.name).split('/').pop();
  const tempDir = await mkdtemp(join(tmpdir(), 'filesync-gpr-'));
  const publishDir = join(tempDir, 'package');

  await cp(projectRoot, publishDir, {
    recursive: true,
    filter: (src) => {
      const normalized = src.replace(/\\/g, '/');
      return !normalized.includes('/node_modules/') && !normalized.includes('/.git/') && !normalized.includes('/.npm-local/');
    },
  });

  pkg.name = `@${scope}/${baseName}`;
  pkg.publishConfig = { registry: 'https://npm.pkg.github.com' };
  if (pkg.scripts?.prepublishOnly) {
    pkg.scripts.prepublishOnly = 'echo prepublish checks already completed';
  }
  await writeFile(join(publishDir, 'package.json'), JSON.stringify(pkg, null, 2));

  const publishCommand = process.env.NPM_PUBLISH_DRY_RUN === '1'
    ? `${npmCommand} publish --dry-run`
    : `${npmCommand} publish`;

  console.log(`Publishing ${pkg.name} to GitHub Packages`);
  run(publishCommand, publishDir);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
