import * as fs from 'node:fs';
import * as path from 'node:path';

import { t } from './i18n';

type HpmpcDocument = Record<string, unknown> & {
  clientKey?: unknown;
  secretKey?: unknown;
  content?: unknown;
};

type LoadedHpmpc = {
  document: HpmpcDocument;
  hasBom: boolean;
  eol: '\n' | '\r\n';
  hasTrailingNewline: boolean;
};

const watchedWorkingCopies = new Set<string>();

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readHpmpcOnce(filePath: string): LoadedHpmpc {
  const raw = fs.readFileSync(filePath, 'utf8');
  const hasBom = raw.startsWith('\uFEFF');
  const text = hasBom ? raw.slice(1) : raw;
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(t('hpmpc.notObject'));
  }
  return {
    document: parsed as HpmpcDocument,
    hasBom,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    hasTrailingNewline: /\r?\n$/.test(text),
  };
}

function readHpmpc(filePath: string): LoadedHpmpc {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return readHpmpcOnce(filePath);
    } catch (error) {
      lastError = error;
      sleepMs(80);
    }
  }
  throw lastError;
}

function writeHpmpc(filePath: string, loaded: LoadedHpmpc): void {
  let text = JSON.stringify(loaded.document, null, 4).replace(/\n/g, loaded.eol);
  if (loaded.hasTrailingNewline) {
    text += loaded.eol;
  }
  fs.writeFileSync(filePath, `${loaded.hasBom ? '\uFEFF' : ''}${text}`, 'utf8');
}

function hasCredential(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasHpmpcCredentials(filePath: string): boolean {
  const { document } = readHpmpc(filePath);
  return hasCredential(document.clientKey) && hasCredential(document.secretKey);
}

function contentEqual(left: HpmpcDocument, right: HpmpcDocument): boolean {
  return JSON.stringify(left.content) === JSON.stringify(right.content);
}

function copyContent(from: LoadedHpmpc, to: LoadedHpmpc, targetPath: string): void {
  to.document.content = from.document.content;
  writeHpmpc(targetPath, to);
}

function copyWorkingContentToSource(sourcePath: string, workingCopyPath: string): void {
  const source = readHpmpc(sourcePath);
  const workingCopy = readHpmpc(workingCopyPath);
  if (!contentEqual(source.document, workingCopy.document)) {
    copyContent(workingCopy, source, sourcePath);
  }
}

function synchronizeHpmpcPair(sourcePath: string, workingCopyPath: string): void {
  const source = readHpmpc(sourcePath);
  const workingCopy = readHpmpc(workingCopyPath);
  if (!hasCredential(workingCopy.document.clientKey) || !hasCredential(workingCopy.document.secretKey)) {
    throw new Error(t('hpmpc.signedCopyInvalid'));
  }
  if (contentEqual(source.document, workingCopy.document)) {
    return;
  }

  const sourceModified = fs.statSync(sourcePath).mtimeMs;
  const workingCopyModified = fs.statSync(workingCopyPath).mtimeMs;
  if (workingCopyModified >= sourceModified) {
    copyContent(workingCopy, source, sourcePath);
  } else {
    copyContent(source, workingCopy, workingCopyPath);
  }
}

function signedWorkingCopyCandidates(workspaceRoot: string, sourcePath: string): string[] {
  const localRoot = path.join(path.dirname(workspaceRoot), '.xrobot-local', path.basename(workspaceRoot));
  return [
    path.join(localRoot, path.relative(workspaceRoot, sourcePath)),
    path.join(localRoot, path.basename(sourcePath)),
  ];
}

function watchWorkingCopy(sourcePath: string, workingCopyPath: string): void {
  const key = path.resolve(workingCopyPath).toLowerCase();
  if (watchedWorkingCopies.has(key)) {
    return;
  }
  watchedWorkingCopies.add(key);
  fs.watchFile(workingCopyPath, { interval: 500, persistent: false }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) {
      return;
    }
    try {
      copyWorkingContentToSource(sourcePath, workingCopyPath);
    } catch {
      // The HPM tool may replace the file while saving; the next change retries the sync.
    }
  });
}

export function prepareHpmpcForOpen(workspaceRoot: string, sourcePath: string): string {
  if (hasHpmpcCredentials(sourcePath)) {
    return sourcePath;
  }

  const workingCopyPath = signedWorkingCopyCandidates(workspaceRoot, sourcePath).find((candidate) => {
    try {
      return fs.statSync(candidate).isFile() && hasHpmpcCredentials(candidate);
    } catch {
      return false;
    }
  });
  if (!workingCopyPath) {
    throw new Error(t('hpmpc.signedCopyNotFound'));
  }

  synchronizeHpmpcPair(sourcePath, workingCopyPath);
  watchWorkingCopy(sourcePath, workingCopyPath);
  return workingCopyPath;
}
