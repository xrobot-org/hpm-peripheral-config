import * as childProcess from 'node:child_process';

import {
  parseGenerateEnvelope,
  parseInspectEnvelope,
  parseValidateEnvelope,
  type GenerateEnvelope,
  type InspectEnvelope,
  type PeripheralConfigDto,
  type ValidateEnvelope,
} from './hpmProtocol';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;

export type HpmCliOptions = {
  executable?: string;
  prefixArgs?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
};

export type HpmCliProjectRequest = {
  cwd: string;
  hpmpcPath?: string;
};

export type HpmCliValidateRequest = HpmCliProjectRequest & {
  peripheralConfigPath?: string;
  config?: PeripheralConfigDto;
  write?: boolean;
};

export type HpmCliGenerateRequest = HpmCliProjectRequest & {
  peripheralConfigPath?: string;
  config?: PeripheralConfigDto;
  libxrConfigPath?: string;
  configOutputPath?: string;
  appOutputPath?: string;
  xrobot?: boolean;
  hardwareContainer?: boolean;
};

export type HpmCliResponse<T> = {
  envelope: T;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type EnvelopeParser<T> = (value: unknown) => T;

type ProcessOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export class HpmCliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class HpmCliNotFoundError extends HpmCliError {
  constructor(public readonly executable: string, cause?: unknown) {
    super(`HPM CLI executable was not found: ${executable}`, { cause });
  }
}

export class HpmCliTimeoutError extends HpmCliError {
  constructor(public readonly timeoutMs: number) {
    super(`HPM CLI exceeded the ${timeoutMs} ms timeout.`);
  }
}

export class HpmCliOutputLimitError extends HpmCliError {
  constructor(public readonly maxOutputBytes: number) {
    super(`HPM CLI output exceeded the ${maxOutputBytes} byte limit.`);
  }
}

export class HpmCliProcessError extends HpmCliError {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export class HpmCliProtocolError extends HpmCliError {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return selected;
}

function serializeConfig(config: PeripheralConfigDto): string {
  try {
    return `${JSON.stringify(config)}\n`;
  } catch (error) {
    throw new HpmCliProtocolError('HPM peripheral config is not JSON serializable.', '', '', error);
  }
}

export class HpmCli {
  private readonly executable: string;
  private readonly prefixArgs: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: HpmCliOptions = {}) {
    this.executable = options.executable ?? 'xr_hpm_cfg';
    this.prefixArgs = options.prefixArgs ?? [];
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    );
    this.env = { ...process.env, ...options.env };
  }

  async inspect(request: HpmCliProjectRequest): Promise<HpmCliResponse<InspectEnvelope>> {
    const args = this.projectArgs('inspect', request);
    args.push('--format', 'json');
    return this.invoke(args, request.cwd, undefined, parseInspectEnvelope);
  }

  async validate(request: HpmCliValidateRequest): Promise<HpmCliResponse<ValidateEnvelope>> {
    const args = this.projectArgs('validate', request);
    args.push('--peripheral-config', request.peripheralConfigPath ?? 'hpm_peripherals.yaml');
    let stdin: string | undefined;
    if (request.config !== undefined) {
      args.push('--config-stdin');
      stdin = serializeConfig(request.config);
    }
    if (request.write) {
      args.push('--write');
    }
    args.push('--format', 'json');
    return this.invoke(args, request.cwd, stdin, parseValidateEnvelope);
  }

  async generate(request: HpmCliGenerateRequest): Promise<HpmCliResponse<GenerateEnvelope>> {
    const args = this.projectArgs('generate', request);
    args.push('--peripheral-config', request.peripheralConfigPath ?? 'hpm_peripherals.yaml');
    let stdin: string | undefined;
    if (request.config !== undefined) {
      args.push('--config-stdin');
      stdin = serializeConfig(request.config);
    }
    args.push(
      '--libxr-config',
      request.libxrConfigPath ?? 'User/libxr_config.yaml',
      '--config-output',
      request.configOutputPath ?? '.config.yaml',
      '-o',
      request.appOutputPath ?? 'User/app_main.cpp',
    );
    if (request.xrobot) {
      args.push('--xrobot');
    }
    if (request.hardwareContainer) {
      args.push('--hw-cntr');
    }
    args.push('--format', 'json');
    return this.invoke(args, request.cwd, stdin, parseGenerateEnvelope);
  }

  private projectArgs(command: string, request: HpmCliProjectRequest): string[] {
    const args = [command, '-d', '.'];
    if (request.hpmpcPath) {
      args.push('-i', request.hpmpcPath);
    }
    return args;
  }

  private async invoke<T>(
    args: string[],
    cwd: string,
    stdin: string | undefined,
    parseEnvelope: EnvelopeParser<T>,
  ): Promise<HpmCliResponse<T>> {
    const result = await this.runProcess([...this.prefixArgs, ...args], cwd, stdin);
    let value: unknown;
    try {
      value = JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new HpmCliProtocolError(
        'HPM CLI stdout is not a JSON document.',
        result.stdout,
        result.stderr,
        error,
      );
    }
    let envelope: T;
    try {
      envelope = parseEnvelope(value);
    } catch (error) {
      throw new HpmCliProtocolError(
        'HPM CLI returned an invalid or incompatible protocol envelope.',
        result.stdout,
        result.stderr,
        error,
      );
    }
    return { ...result, envelope };
  }

  private runProcess(args: string[], cwd: string, stdin: string | undefined): Promise<ProcessOutput> {
    return new Promise((resolve, reject) => {
      let child: childProcess.ChildProcessWithoutNullStreams;
      try {
        child = childProcess.spawn(this.executable, args, {
          cwd,
          env: this.env,
          shell: false,
          stdio: 'pipe',
          windowsHide: true,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        reject(code === 'ENOENT'
          ? new HpmCliNotFoundError(this.executable, error)
          : new HpmCliProcessError('HPM CLI failed to start.', null, '', '', error));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let terminalError: HpmCliError | undefined;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const clearTimers = (): void => {
        clearTimeout(timer);
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
      };

      const terminate = (error: HpmCliError): void => {
        if (terminalError) {
          return;
        }
        terminalError = error;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (!settled && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, TERMINATION_GRACE_MS);
      };

      const timer = setTimeout(() => {
        terminate(new HpmCliTimeoutError(this.timeoutMs));
      }, this.timeoutMs);

      const collect = (target: Buffer[], chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > this.maxOutputBytes) {
          terminate(new HpmCliOutputLimitError(this.maxOutputBytes));
          return;
        }
        target.push(buffer);
      };

      child.stdout.on('data', (chunk: Buffer | string) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer | string) => collect(stderr, chunk));
      child.stdin.on('error', () => undefined);

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) {
          return;
        }
        if (terminalError) {
          return;
        }
        settled = true;
        clearTimers();
        if (error.code === 'ENOENT') {
          reject(new HpmCliNotFoundError(this.executable, error));
        } else {
          reject(new HpmCliProcessError('HPM CLI process failed.', null, '', '', error));
        }
      });

      child.once('exit', () => {
        if (settled || !terminalError) {
          return;
        }
        settled = true;
        clearTimers();
        reject(terminalError);
      });

      child.once('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        if (terminalError) {
          reject(terminalError);
          return;
        }
        const stdoutText = Buffer.concat(stdout).toString('utf8');
        const stderrText = Buffer.concat(stderr).toString('utf8');
        if (code === null) {
          reject(new HpmCliProcessError(
            'HPM CLI terminated without an exit code.',
            null,
            stdoutText,
            stderrText,
          ));
          return;
        }
        resolve({ exitCode: code, stdout: stdoutText, stderr: stderrText });
      });

      child.stdin.end(stdin);
    });
  }
}
