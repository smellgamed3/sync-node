#!/usr/bin/env node
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const packageJsonPath = join(projectRoot, 'package.json');
const npmCommand = 'npm';
const publishRoot = process.env.NPM_SHARE_ROOT || join(homedir(), 'svc', 'share', 'files', 'npm');

function parsePackageName(rawName) {
  if (rawName.startsWith('@') && rawName.includes('/')) {
    const [scope, pkgName] = rawName.split('/');
    return { scope, packageName: pkgName };
  }

  const scope = process.env.NPM_SCOPE?.trim() || '';
  return { scope, packageName: rawName.replace(/^@/, '') };
}

async function main() {
  if (!existsSync(packageJsonPath)) {
    throw new Error('package.json not found');
  }

  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const { scope, packageName } = parsePackageName(pkg.name);
  const destDir = scope
    ? join(publishRoot, scope, packageName)
    : join(publishRoot, packageName);

  console.log(`Building package: ${pkg.name}`);
  execSync(`${npmCommand} run build`, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
  });

  console.log(`Packing package: ${pkg.name}`);
  const packOutput = execSync(`${npmCommand} pack --json`, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: true,
  });

  const result = JSON.parse(packOutput);
  const filename = result[0]?.filename;
  if (!filename) {
    throw new Error('npm pack did not return a tarball filename');
  }

  const sourceTarball = join(projectRoot, filename);
  const targetTarball = join(destDir, filename);

  await mkdir(destDir, { recursive: true });
  await copyFile(sourceTarball, targetTarball);

  console.log(`Tarball created: ${sourceTarball}`);
  console.log(`Tarball published to: ${targetTarball}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
