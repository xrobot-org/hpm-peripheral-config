const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HpmCli,
  HpmCliNotFoundError,
  HpmCliOutputLimitError,
  HpmCliProtocolError,
  HpmCliTimeoutError,
} = require('../out/hpmCli.js');


const INSPECT_ENVELOPE = {
  protocol_version: 1,
  generator_version: '5.2.4',
  project: {
    board: 'hpm5361evklite',
    soc: 'HPM5361',
    package: 'BGA289',
    sdk: '1.11.0',
    hpmpc: 'boards/hpm5361evklite/pinmux.hpmpc',
  },
  pinmux_functions: ['init_uart3_pins'],
  peripherals: [],
  clock_functions: [],
  clock_sources: [],
  capabilities: {
    spi: {
      modes: [0, 1, 2, 3],
      clock_polarities: ['LOW', 'HIGH'],
      clock_phases: ['EDGE_1', 'EDGE_2'],
      prescalers: ['DIV_1'],
      buffer_size: { min: 1 },
      clock_divider: { min: 1, max: 256 },
      dma_supported: false,
      gpio_cs: { max_instances: 1 },
    },
    i2c: {
      bus_rates: [100_000, 400_000, 1_000_000],
      address_modes: ['7bit', '10bit'],
      fixed_dma_channel: false,
      runtime_dma_allocation: true,
    },
    uart: {
      parity: ['NO_PARITY', 'EVEN', 'ODD'],
      data_bits: [5, 6, 7, 8],
      stop_bits: [1, 2],
      dma: {
        automatic: true,
        channel_min: 0,
        channel_max: 31,
        channel_count: 32,
        rx_mode: 'irq',
        tx_mode: 'dma',
        channels_per_uart: 1,
      },
    },
    mcan: {
      modes: ['can', 'fdcan'],
      sample_point: { min: 0.5, max: 0.95, step: 0.001 },
      data_fields: ['data_bitrate', 'data_sample_point', 'brs', 'esi'],
      queue_size: { min: 1 },
    },
  },
  errors: [],
  warnings: [],
};

const CONFIG = {
  version: 1,
  project: {
    board: 'hpm5361evklite',
    soc: 'HPM5361',
    package: 'BGA289',
    sdk: '1.11.0',
    hpmpc: 'boards/hpm5361evklite/pinmux.hpmpc',
    pinmux_functions: ['init_uart3_pins'],
  },
  spi: {},
  i2c: {},
  uart: {},
  mcan: {},
};

const VALIDATE_ENVELOPE = {
  protocol_version: 1,
  generator_version: '5.2.4',
  valid: true,
  normalized_config: CONFIG,
  errors: [],
  warnings: [],
};

const GENERATE_ENVELOPE = {
  protocol_version: 1,
  generator_version: '5.2.4',
  success: true,
  generated_files: ['User/app_main.cpp'],
  errors: [],
  warnings: [],
};

const FAKE_CLI = String.raw`
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.HPM_TEST_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin,
  }));
  const mode = process.env.HPM_TEST_MODE || 'envelope';
  fs.writeFileSync(process.env.HPM_TEST_PID_CAPTURE, String(process.pid));
  if (mode === 'ignore-term' || mode === 'large-ignore-term') {
    process.on('SIGTERM', () => {
      fs.writeFileSync(process.env.HPM_TEST_SIGNAL_CAPTURE, 'SIGTERM');
    });
    if (mode === 'large-ignore-term') {
      process.stdout.write('x'.repeat(8192));
    }
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === 'hang') {
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === 'large') {
    process.stdout.write('x'.repeat(8192));
    return;
  }
  process.stdout.write(process.env.HPM_TEST_STDOUT || '');
  process.stderr.write(process.env.HPM_TEST_STDERR || '');
  process.exitCode = Number(process.env.HPM_TEST_EXIT_CODE || '0');
});
`;

function fixture(tContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-cli-'));
  tContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'fake cli.js');
  const capture = path.join(directory, 'capture.json');
  const pidCapture = path.join(directory, 'pid.txt');
  const signalCapture = path.join(directory, 'signal.txt');
  fs.writeFileSync(script, FAKE_CLI, 'utf8');
  return { directory, script, capture, pidCapture, signalCapture };
}

function client(files, envelope, options = {}) {
  return new HpmCli({
    executable: process.execPath,
    prefixArgs: [files.script],
    timeoutMs: options.timeoutMs ?? 2000,
    maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
    env: {
      HPM_TEST_CAPTURE: files.capture,
      HPM_TEST_PID_CAPTURE: files.pidCapture,
      HPM_TEST_SIGNAL_CAPTURE: files.signalCapture,
      HPM_TEST_STDOUT: typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
      HPM_TEST_STDERR: options.stderr ?? '',
      HPM_TEST_EXIT_CODE: String(options.exitCode ?? 0),
      HPM_TEST_MODE: options.mode ?? 'envelope',
    },
  });
}

function captured(files) {
  return JSON.parse(fs.readFileSync(files.capture, 'utf8'));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function assertForcedTermination(tContext, mode, options, expectedError) {
  const files = fixture(tContext);
  const runner = client(files, INSPECT_ENVELOPE, { mode, ...options });
  let pid;
  tContext.after(() => {
    if (pid && processExists(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  });

  await assert.rejects(runner.inspect({ cwd: files.directory }), expectedError);

  pid = Number(fs.readFileSync(files.pidCapture, 'utf8'));
  assert.equal(processExists(pid), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.readFileSync(files.signalCapture, 'utf8'), 'SIGTERM');
  }
}

test('inspect uses shell-free exact argv, cwd, and preserves stderr', async (tContext) => {
  const files = fixture(tContext);
  const runner = client(files, INSPECT_ENVELOPE, { stderr: 'inspect warning\n' });

  const result = await runner.inspect({
    cwd: files.directory,
    hpmpcPath: 'boards/hpm5361evklite/pinmux.hpmpc',
  });

  assert.deepEqual(captured(files), {
    argv: [
      'inspect',
      '-d',
      '.',
      '-i',
      'boards/hpm5361evklite/pinmux.hpmpc',
      '--format',
      'json',
    ],
    cwd: files.directory,
    stdin: '',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, 'inspect warning\n');
  assert.equal(result.envelope.project.board, 'hpm5361evklite');
  assert.equal(result.envelope.capabilities.uart.dma.rx_mode, 'irq');
  assert.equal(result.envelope.capabilities.uart.dma.channels_per_uart, 1);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'hpmCli.ts'), 'utf8');
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /from ['"]vscode['"]/);
});

test('validate sends candidate JSON on stdin and places write before format', async (tContext) => {
  const files = fixture(tContext);
  const runner = client(files, VALIDATE_ENVELOPE);

  const result = await runner.validate({
    cwd: files.directory,
    hpmpcPath: './boards/hpm5361evklite/pinmux.hpmpc',
    peripheralConfigPath: './hpm_peripherals.yaml',
    config: CONFIG,
    write: true,
  });

  assert.deepEqual(captured(files).argv, [
    'validate',
    '-d',
    '.',
    '-i',
    './boards/hpm5361evklite/pinmux.hpmpc',
    '--peripheral-config',
    './hpm_peripherals.yaml',
    '--config-stdin',
    '--write',
    '--format',
    'json',
  ]);
  assert.deepEqual(JSON.parse(captured(files).stdin), CONFIG);
  assert.equal(result.envelope.valid, true);
});

test('generate builds the complete ordered argv without stdin', async (tContext) => {
  const files = fixture(tContext);
  const runner = client(files, GENERATE_ENVELOPE);

  const result = await runner.generate({
    cwd: files.directory,
    hpmpcPath: './boards/hpm5361evklite/pinmux.hpmpc',
    peripheralConfigPath: './hpm_peripherals.yaml',
    libxrConfigPath: './User/libxr_config.yaml',
    configOutputPath: './.config.yaml',
    appOutputPath: './User/app_main.cpp',
    xrobot: true,
    hardwareContainer: true,
  });

  assert.deepEqual(captured(files), {
    argv: [
      'generate',
      '-d',
      '.',
      '-i',
      './boards/hpm5361evklite/pinmux.hpmpc',
      '--peripheral-config',
      './hpm_peripherals.yaml',
      '--libxr-config',
      './User/libxr_config.yaml',
      '--config-output',
      './.config.yaml',
      '-o',
      './User/app_main.cpp',
      '--xrobot',
      '--hw-cntr',
      '--format',
      'json',
    ],
    cwd: files.directory,
    stdin: '',
  });
  assert.deepEqual(result.envelope.generated_files, ['User/app_main.cpp']);
});

test('generate sends an unsaved config on stdin for transactional generation', async (tContext) => {
  const files = fixture(tContext);
  const runner = client(files, GENERATE_ENVELOPE);

  await runner.generate({
    cwd: files.directory,
    peripheralConfigPath: './hpm_peripherals.yaml',
    config: CONFIG,
  });

  const invocation = captured(files);
  assert.deepEqual(
    invocation.argv.slice(0, 7),
    [
      'generate',
      '-d',
      '.',
      '--peripheral-config',
      './hpm_peripherals.yaml',
      '--config-stdin',
      '--libxr-config',
    ],
  );
  assert.deepEqual(JSON.parse(invocation.stdin), CONFIG);
});

test('nonzero exit with a structured envelope resolves for diagnostic display', async (tContext) => {
  const files = fixture(tContext);
  const envelope = {
    ...VALIDATE_ENVELOPE,
    valid: false,
    normalized_config: {
      ...VALIDATE_ENVELOPE.normalized_config,
      uart: {
        UART3: {
          baudrate: '',
        },
      },
    },
    errors: [{
      code: 'HPM_SPI_CLOCK_UNREACHABLE',
      level: 'error',
      peripheral: 'SPI1',
      field: 'sclk_hz',
      message: 'unreachable',
    }],
  };
  const runner = client(files, envelope, { exitCode: 1, stderr: 'details\n' });

  const result = await runner.validate({ cwd: files.directory, config: CONFIG });

  assert.equal(result.exitCode, 1);
  assert.equal(result.envelope.valid, false);
  assert.equal(result.envelope.normalized_config.uart.UART3.baudrate, '');
  assert.equal(result.envelope.errors[0].code, 'HPM_SPI_CLOCK_UNREACHABLE');
  assert.equal(result.stderr, 'details\n');
});

test('missing executable raises HpmCliNotFoundError', async (tContext) => {
  const files = fixture(tContext);
  const executable = path.join(files.directory, 'missing xr_hpm_cfg');
  const runner = new HpmCli({ executable, timeoutMs: 1000 });

  await assert.rejects(
    runner.inspect({ cwd: files.directory }),
    (error) => error instanceof HpmCliNotFoundError && error.executable === executable,
  );
});

test('timeout terminates the CLI and raises HpmCliTimeoutError', async (tContext) => {
  const files = fixture(tContext);
  const runner = client(files, INSPECT_ENVELOPE, { mode: 'hang', timeoutMs: 40 });

  await assert.rejects(
    runner.inspect({ cwd: files.directory }),
    (error) => error instanceof HpmCliTimeoutError && error.timeoutMs === 40,
  );
});

test('timeout force-kills a CLI that ignores SIGTERM before rejecting', { timeout: 5000 }, async (tContext) => {
  await assertForcedTermination(
    tContext,
    'ignore-term',
    { timeoutMs: 1000 },
    (error) => error instanceof HpmCliTimeoutError && error.timeoutMs === 1000,
  );
});

test('combined stdout and stderr are bounded', async (tContext) => {
  const files = fixture(tContext);
  const runner = client(files, INSPECT_ENVELOPE, { mode: 'large', maxOutputBytes: 128 });

  await assert.rejects(
    runner.inspect({ cwd: files.directory }),
    (error) => error instanceof HpmCliOutputLimitError && error.maxOutputBytes === 128,
  );
});

test('output limit force-kills a CLI that ignores SIGTERM before rejecting', { timeout: 5000 }, async (tContext) => {
  await assertForcedTermination(
    tContext,
    'large-ignore-term',
    { maxOutputBytes: 128 },
    (error) => error instanceof HpmCliOutputLimitError && error.maxOutputBytes === 128,
  );
});

test('malformed stdout raises HpmCliProtocolError with captured streams', async (tContext) => {
  const files = fixture(tContext);
  const runner = client(files, 'not-json', { stderr: 'parser details\n' });

  await assert.rejects(
    runner.inspect({ cwd: files.directory }),
    (error) => error instanceof HpmCliProtocolError &&
      error.stdout === 'not-json' && error.stderr === 'parser details\n',
  );
});
