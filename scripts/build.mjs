#!/usr/bin/env node
/**
 * Build the Chrome Web Store upload zip.
 *
 *   node scripts/build.mjs      (or: npm run build)
 *
 * Produces dist/threads-for-trello-<version>.zip containing ONLY what ships:
 * manifest.json, src/, icons/. Everything else in the repo (docs, tests,
 * store assets, .git) is deliberately left out. The zip's root is the
 * extension root, which is what "Load unpacked" and the Web Store expect.
 *
 * Zero dependencies. Entry names always use forward slashes (the ZIP spec
 * requires them; Chrome mis-reads back-slashed entries as one flat file).
 * Uses `zip` when present (mac/Linux/git-bash); otherwise .NET's ZipArchive
 * via PowerShell — deliberately NOT Compress-Archive, which emits back-slashed
 * entries on Windows PowerShell 5.1.
 */
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
const items = ['manifest.json', 'src', 'icons'];
const out = join('dist', `threads-for-trello-${version}.zip`);

mkdirSync('dist', { recursive: true });
rmSync(out, { force: true });

// Flatten the items into [absolutePath, entryName] pairs (forward-slash names).
function collect(item) {
  const st = statSync(item);
  if (st.isFile()) return [[item, item.split(/[\\/]/).join('/')]];
  return readdirSync(item).flatMap((child) => collect(posix.join(item.split(/[\\/]/).join('/'), child)));
}
const files = items.flatMap(collect);

function haveZip() {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['zip'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (haveZip()) {
  execSync(`zip -r "${out}" ${items.join(' ')} -x '*.DS_Store'`, { stdio: 'inherit' });
} else if (process.platform === 'win32') {
  // Build with .NET, controlling each entry name so separators are '/'.
  const ps = [
    `$ErrorActionPreference='Stop'`,
    `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
    `$z=[System.IO.Compression.ZipFile]::Open('${out.replace(/\\/g, '\\\\')}','Create')`,
    ...files.map(
      ([abs, name]) =>
        `[void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,'${abs.replace(/'/g, "''")}','${name.replace(/'/g, "''")}','Optimal')`
    ),
    `$z.Dispose()`,
  ].join('\n');
  const scriptPath = join('dist', '_pack.ps1');
  writeFileSync(scriptPath, ps);
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    stdio: 'inherit',
  });
  rmSync(scriptPath, { force: true });
} else {
  throw new Error('No `zip` binary found. Install zip, or run on Windows.');
}

console.log(`\nBuilt ${out} (${files.length} files)`);
console.log('Upload this at https://chrome.google.com/webstore/devconsole');
