import * as fs from 'node:fs';
import * as path from 'node:path';

import { t } from './i18n';

export type PinmuxPeripheral = {
  instance: string;
  type: string;
  index: number;
  pins: Record<string, string>;
  functions: string[];
  annotations: string[];
};

export type HpmProject = {
  root: string;
  hpmpcPath: string;
  boardDir: string;
  boardName: string;
  boardC: string;
  boardH: string;
  pinmuxC: string;
  pinmuxH: string;
  socName: string;
  packageName: string;
  sdkName: string;
  pinmuxFunctions: string[];
  peripherals: PinmuxPeripheral[];
};

type HpmpcPin = {
  signal?: unknown;
};

type HpmpcFunction = {
  selectPins?: Record<string, HpmpcPin>;
  annotation?: unknown;
};

type HpmpcRoot = {
  content?: {
    info?: {
      socName?: unknown;
      packageName?: unknown;
      sdkName?: unknown;
    };
    pinmux?: {
      functions?: Record<string, HpmpcFunction>;
    };
  };
};

const INSTANCE_RE = /^(UART|I2C|SPI|MCAN|CAN|ADC|USB|GPTMR|PWM)(\d+)$/;
const SKIP_DIRS = new Set(['.git', '.vscode', 'build', 'node_modules', 'out']);
const PINMUX_DECLARATION_RE = /^\s*void\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*void\s*\)\s*;/gm;
const PINMUX_DEFINITION_RE = /^\s*void\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*void\s*\)\s*\{/gm;

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function signalRole(signal: string): string {
  return signal.split('.').pop()?.replace(/\[(\d+)\]/g, '$1') ?? signal;
}

function walkFiles(root: string, predicate: (filePath: string) => boolean): string[] {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (!SKIP_DIRS.has(lower) && !lower.startsWith('build')) {
          pending.push(absolute);
        }
      } else if (entry.isFile() && predicate(absolute)) {
        result.push(absolute);
      }
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function readHpmpc(filePath: string): HpmpcRoot {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw.startsWith('\uFEFF') ? raw.slice(1) : raw) as HpmpcRoot;
}

function collectMatches(source: string, pattern: RegExp): string[] {
  const result: string[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    result.push(match[1]);
  }
  return result;
}

function uniqueNames(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const name of group) {
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }
  return result;
}

function readDeclaredPinmuxFunctions(boardDir: string): string[] {
  const result: string[][] = [];
  const header = path.join(boardDir, 'pinmux.h');
  if (fs.existsSync(header)) {
    result.push(collectMatches(fs.readFileSync(header, 'utf8'), PINMUX_DECLARATION_RE));
  }
  const source = path.join(boardDir, 'pinmux.c');
  if (fs.existsSync(source)) {
    result.push(collectMatches(fs.readFileSync(source, 'utf8'), PINMUX_DEFINITION_RE));
  }
  return uniqueNames(...result);
}

function findHpmpc(root: string, configuredPath = ''): string {
  if (configuredPath) {
    const absolute = path.isAbsolute(configuredPath) ? configuredPath : path.join(root, configuredPath);
    if (fs.existsSync(absolute)) {
      return absolute;
    }
    throw new Error(t('error.pinmuxFileNotFound', { path: absolute }));
  }

  const matches = walkFiles(root, (filePath) => filePath.toLowerCase().endsWith('.hpmpc'));
  const preferred = matches.find((filePath) => toPosix(path.relative(root, filePath)).includes('/boards/'));
  if (preferred) {
    return preferred;
  }
  if (matches.length > 0) {
    return matches[0];
  }
  throw new Error(t('project.hpmpcNotFound'));
}

function parsePeripherals(hpmpcPath: string): {
  socName: string;
  packageName: string;
  sdkName: string;
  pinmuxFunctions: string[];
  peripherals: PinmuxPeripheral[];
} {
  const root = readHpmpc(hpmpcPath);
  const info = root.content?.info ?? {};
  const functions = root.content?.pinmux?.functions ?? {};
  const byInstance = new Map<string, PinmuxPeripheral>();

  for (const [functionName, fn] of Object.entries(functions)) {
    const annotation = typeof fn.annotation === 'string' ? fn.annotation : '';
    for (const [pad, pin] of Object.entries(fn.selectPins ?? {})) {
      const signal = typeof pin.signal === 'string' ? pin.signal : '';
      const instance = signal.split('.', 1)[0];
      const match = INSTANCE_RE.exec(instance);
      if (!match) {
        continue;
      }
      let peripheral = byInstance.get(instance);
      if (!peripheral) {
        peripheral = {
          instance,
          type: match[1],
          index: Number(match[2]),
          pins: {},
          functions: [],
          annotations: [],
        };
        byInstance.set(instance, peripheral);
      }
      peripheral.pins[signalRole(signal)] = pad;
      if (!peripheral.functions.includes(functionName)) {
        peripheral.functions.push(functionName);
      }
      if (annotation && !peripheral.annotations.includes(annotation)) {
        peripheral.annotations.push(annotation);
      }
    }
  }

  return {
    socName: String(info.socName ?? 'Unknown'),
    packageName: String(info.packageName ?? 'Unknown'),
    sdkName: String(info.sdkName ?? 'Unknown'),
    pinmuxFunctions: Object.keys(functions),
    peripherals: [...byInstance.values()].sort((a, b) => a.instance.localeCompare(b.instance)),
  };
}

function findBoardDir(root: string, hpmpcPath: string): string {
  const fromHpmpc = path.dirname(hpmpcPath);
  if (fs.existsSync(path.join(fromHpmpc, 'board.c')) && fs.existsSync(path.join(fromHpmpc, 'board.h'))) {
    return fromHpmpc;
  }
  const matches = walkFiles(root, (filePath) => path.basename(filePath).toLowerCase() === 'board.h');
  const boardH = matches.find((filePath) => fs.existsSync(path.join(path.dirname(filePath), 'board.c')));
  if (!boardH) {
    throw new Error(t('project.boardFilesNotFound'));
  }
  return path.dirname(boardH);
}

export function discoverProject(root: string, configuredHpmpcPath = ''): HpmProject {
  const hpmpcPath = findHpmpc(root, configuredHpmpcPath);
  const parsed = parsePeripherals(hpmpcPath);
  const boardDir = findBoardDir(root, hpmpcPath);
  const boardName = path.basename(boardDir);
  const pinmuxFunctions = uniqueNames(parsed.pinmuxFunctions, readDeclaredPinmuxFunctions(boardDir));
  return {
    root,
    hpmpcPath,
    boardDir,
    boardName,
    boardC: path.join(boardDir, 'board.c'),
    boardH: path.join(boardDir, 'board.h'),
    pinmuxC: path.join(boardDir, 'pinmux.c'),
    pinmuxH: path.join(boardDir, 'pinmux.h'),
    ...parsed,
    pinmuxFunctions,
  };
}
