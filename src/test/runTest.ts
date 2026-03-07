import * as path from 'path';
import * as os from 'os';
import { existsSync } from 'fs';
import { runTests } from '@vscode/test-electron';

function findVsCodeExecutableFromPath(): string | undefined {
  const pathVar = process.env.PATH;
  if (!pathVar) return undefined;

  const candidates = pathVar.split(path.delimiter);
  for (const dir of candidates) {
    const codeCmd = path.join(dir, 'code.cmd');
    if (existsSync(codeCmd)) {
      const maybeExe = path.resolve(dir, '..', 'Code.exe');
      if (existsSync(maybeExe)) return maybeExe;
      const maybeExeAlt = path.resolve(dir, '..', 'code.exe');
      if (existsSync(maybeExeAlt)) return maybeExeAlt;
    }

    const codeExe = path.join(dir, 'code.exe');
    if (existsSync(codeExe)) return codeExe;
    const codeExeCaps = path.join(dir, 'Code.exe');
    if (existsSync(codeExeCaps)) return codeExeCaps;
  }
  return undefined;
}

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH || findVsCodeExecutableFromPath();
  const runId = Date.now().toString(16);
  const userDataDir = path.join(os.tmpdir(), `commit-genius-test-user-data-${runId}`);
  const extensionsDir = path.join(os.tmpdir(), `commit-genius-test-extensions-${runId}`);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    vscodeExecutablePath,
    launchArgs: ['--disable-updates', `--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`]
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
