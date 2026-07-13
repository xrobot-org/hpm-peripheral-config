export type ClockSourceId =
  | 'osc24m'
  | 'pll0_clk0'
  | 'pll0_clk1'
  | 'pll0_clk2'
  | 'pll1_clk0'
  | 'pll1_clk1'
  | 'pll1_clk2'
  | 'pll1_clk3';

export type ClockSettings = {
  auto_clock: boolean;
  clock_source: ClockSourceId;
  clock_divider: number;
  peripheral_clock_hz: number;
};

export type SpiClockSettings = ClockSettings & {
  prescaler: `DIV_${1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256}`;
  actual_sclk_hz: number;
};

export type ClockSource = {
  id: ClockSourceId;
  cSymbol: string;
  hz: number;
};

const SOURCE_SYMBOLS: Record<ClockSourceId, string> = {
  osc24m: 'clk_src_osc24m',
  pll0_clk0: 'clk_src_pll0_clk0',
  pll0_clk1: 'clk_src_pll0_clk1',
  pll0_clk2: 'clk_src_pll0_clk2',
  pll1_clk0: 'clk_src_pll1_clk0',
  pll1_clk1: 'clk_src_pll1_clk1',
  pll1_clk2: 'clk_src_pll1_clk2',
  pll1_clk3: 'clk_src_pll1_clk3',
};

const HPM5361_SOURCE_HZ: Partial<Record<ClockSourceId, number>> = {
  osc24m: 24_000_000,
  pll0_clk0: 960_000_000,
  pll0_clk1: 600_000_000,
  pll0_clk2: 400_000_000,
};

const SPI_PRESCALERS = [1, 2, 4, 8, 16, 32, 64, 128, 256] as const;
const MAX_COMMUNICATION_CLOCK_HZ = 200_000_000;

function sourceFrequencies(soc: string, board = ''): Partial<Record<ClockSourceId, number>> {
  if (soc.toUpperCase() === 'HPM5361' && board.toLowerCase() === 'hpm5361evklite') {
    return HPM5361_SOURCE_HZ;
  }
  return { osc24m: 24_000_000 };
}

export function clockSourcesForSoc(soc: string, board = ''): ClockSource[] {
  return Object.entries(sourceFrequencies(soc, board)).map(([id, hz]) => ({
    id: id as ClockSourceId,
    cSymbol: SOURCE_SYMBOLS[id as ClockSourceId],
    hz: hz as number,
  }));
}

export function clockSourceSymbol(source: ClockSourceId): string {
  return SOURCE_SYMBOLS[source];
}

export function peripheralClockHz(soc: string, source: ClockSourceId, divider: number, board = ''): number {
  const sourceHz = sourceFrequencies(soc, board)[source];
  if (!sourceHz || !Number.isInteger(divider) || divider < 1 || divider > 256) {
    return 0;
  }
  return Math.floor(sourceHz / divider);
}

type ClockCandidate = ClockSettings;

function clockCandidates(soc: string, board = ''): ClockCandidate[] {
  const candidates: ClockCandidate[] = [];
  for (const source of clockSourcesForSoc(soc, board)) {
    for (let divider = 1; divider <= 256; divider += 1) {
      const clockHz = Math.floor(source.hz / divider);
      if (clockHz > 0 && clockHz <= MAX_COMMUNICATION_CLOCK_HZ) {
        candidates.push({
          auto_clock: true,
          clock_source: source.id,
          clock_divider: divider,
          peripheral_clock_hz: clockHz,
        });
      }
    }
  }
  return candidates;
}

export function resolveSpiClock(soc: string, targetHz: number, board = ''): SpiClockSettings | undefined {
  if (!Number.isFinite(targetHz) || targetHz <= 0) {
    return undefined;
  }
  let best: SpiClockSettings | undefined;
  for (const candidate of clockCandidates(soc, board)) {
    for (const prescaler of SPI_PRESCALERS) {
      if (candidate.peripheral_clock_hz % prescaler !== 0) {
        continue;
      }
      const actualHz = Math.floor(candidate.peripheral_clock_hz / prescaler);
      if (actualHz <= 0 || actualHz > targetHz) {
        continue;
      }
      const current: SpiClockSettings = {
        ...candidate,
        prescaler: `DIV_${prescaler}`,
        actual_sclk_hz: actualHz,
      };
      if (
        !best ||
        current.actual_sclk_hz > best.actual_sclk_hz ||
        (current.actual_sclk_hz === best.actual_sclk_hz &&
          current.peripheral_clock_hz < best.peripheral_clock_hz)
      ) {
        best = current;
      }
    }
  }
  return best;
}

export function resolveSpiPrescaler(clockHz: number, targetHz: number): Pick<SpiClockSettings, 'prescaler' | 'actual_sclk_hz'> | undefined {
  if (!Number.isFinite(clockHz) || !Number.isFinite(targetHz) || clockHz <= 0 || targetHz <= 0) {
    return undefined;
  }
  for (const prescaler of SPI_PRESCALERS) {
    if (clockHz % prescaler !== 0) {
      continue;
    }
    const actualHz = Math.floor(clockHz / prescaler);
    if (actualHz <= targetHz) {
      return { prescaler: `DIV_${prescaler}`, actual_sclk_hz: actualHz };
    }
  }
  return undefined;
}

export function uartBaudrateError(clockHz: number, baudrate: number): number | undefined {
  if (!Number.isInteger(baudrate) || baudrate < 200 || clockHz < baudrate * 8) {
    return undefined;
  }
  const scaled = Math.trunc((clockHz * 1000) / baudrate);
  for (let oversample = 8; oversample <= 30; oversample += 2) {
    const divider = Math.trunc((scaled + oversample * 500) / (oversample * 1000));
    if (divider < 1 || divider > 0xffff) {
      continue;
    }
    const delta = Math.abs(divider * oversample * 1000 - scaled);
    if (delta === 0 || Math.trunc((delta * 100) / scaled) <= 3) {
      const actual = clockHz / (divider * oversample);
      return Math.abs(actual - baudrate) / baudrate;
    }
  }
  return undefined;
}

export function resolveUartClock(soc: string, baudrate: number, board = ''): ClockSettings | undefined {
  const candidates = clockCandidates(soc, board);
  const oscillator = candidates.find(
    (clock) => clock.clock_source === 'osc24m' && clock.clock_divider === 1 &&
      uartBaudrateError(clock.peripheral_clock_hz, baudrate) !== undefined,
  );
  if (oscillator) {
    return oscillator;
  }
  const valid = candidates
    .map((clock) => ({ clock, error: uartBaudrateError(clock.peripheral_clock_hz, baudrate) }))
    .filter((item): item is { clock: ClockSettings; error: number } => item.error !== undefined)
    .sort((left, right) => left.error - right.error || left.clock.peripheral_clock_hz - right.clock.peripheral_clock_hz);
  return valid[0]?.clock;
}

type CanTimingLimits = {
  tqMin: number;
  tqMax: number;
  seg1Max: number;
  seg2Min: number;
  seg2Max: number;
  minDiff: number;
};

const CAN_TIMING: Record<'can' | 'fdcan_nominal' | 'fdcan_data', CanTimingLimits> = {
  can: { tqMin: 8, tqMax: 384, seg1Max: 256, seg2Min: 2, seg2Max: 128, minDiff: 2 },
  fdcan_nominal: { tqMin: 8, tqMax: 288, seg1Max: 256, seg2Min: 1, seg2Max: 32, minDiff: 2 },
  fdcan_data: { tqMin: 8, tqMax: 48, seg1Max: 32, seg2Min: 2, seg2Max: 16, minDiff: 1 },
};

export function canTimingSupported(
  clockHz: number,
  bitrate: number,
  samplePoint: number,
  kind: 'can' | 'fdcan_nominal' | 'fdcan_data',
  maxPrescaler = 256,
): boolean {
  if (!Number.isInteger(bitrate) || bitrate <= 0 || samplePoint <= 0 || samplePoint >= 1) {
    return false;
  }
  const limits = CAN_TIMING[kind];
  const total = Math.floor(clockHz / bitrate);
  if (total < limits.tqMin || clockHz % bitrate !== 0) {
    return false;
  }
  const requestedPermille = Math.trunc(Math.fround(samplePoint) * 1000);
  let startPrescaler = 1;
  while (startPrescaler <= Math.min(256, maxPrescaler)) {
    let prescaler = startPrescaler;
    while (prescaler <= Math.min(256, maxPrescaler) &&
      (Math.floor(total / prescaler) > limits.tqMax || total % prescaler !== 0)) {
      prescaler += 1;
    }
    if (prescaler > Math.min(256, maxPrescaler)) return false;
    const tq = total / prescaler;
    if (tq < limits.tqMin) return false;
    let seg2 = Math.floor((tq - limits.minDiff) / 2);
    let seg1 = tq - seg2;
    while (seg2 > limits.seg2Max) {
      seg2 -= 1;
      seg1 += 1;
    }
    while (Math.floor((seg1 * 1000) / tq) < requestedPermille) {
      seg1 += 1;
      seg2 -= 1;
    }
    if (Math.floor((seg1 * 1000) / tq) > requestedPermille) return false;
    if (seg2 >= limits.seg2Min && seg1 <= limits.seg1Max) return true;
    startPrescaler = prescaler + 1;
  }
  return false;
}

export function resolveCanClock(
  soc: string,
  bitrate: number,
  samplePoint: number,
  mode: 'can' | 'fdcan',
  dataBitrate?: number,
  dataSamplePoint?: number,
  board = '',
  brs = false,
): ClockSettings | undefined {
  const valid = clockCandidates(soc, board).filter((clock) => {
    const nominalKind = mode === 'fdcan' ? 'fdcan_nominal' : 'can';
    if (!canTimingSupported(clock.peripheral_clock_hz, bitrate, samplePoint, nominalKind)) {
      return false;
    }
    return mode !== 'fdcan' || canTimingSupported(
      clock.peripheral_clock_hz,
      dataBitrate ?? bitrate,
      dataSamplePoint ?? samplePoint,
      'fdcan_data',
      brs ? 2 : 256,
    );
  });
  valid.sort((left, right) => {
    const leftDistance = Math.abs(left.peripheral_clock_hz - 80_000_000);
    const rightDistance = Math.abs(right.peripheral_clock_hz - 80_000_000);
    return leftDistance - rightDistance || left.peripheral_clock_hz - right.peripheral_clock_hz;
  });
  return valid[0];
}

export type I2cTiming = {
  actual_hz: number;
  t_sp: number;
  t_sudat: number;
  t_hddat: number;
  t_sclhi: number;
};

export function resolveI2cTiming(clockHz: number, busHz: number): I2cTiming | undefined {
  if (![100000, 400000, 1000000].includes(busHz) || !Number.isInteger(clockHz) || clockHz <= 0) {
    return undefined;
  }
  const clockPeriod = Math.trunc(10_000_000_000 / clockHz);
  if (clockPeriod <= 0) return undefined;
  const timing = busHz === 100000
    ? { high: 40000, low: 47000, ratio: 1, setup: 2500, hold: 3000, period: 100000 }
    : busHz === 400000
      ? { high: 6000, low: 13000, ratio: 2, setup: 1000, hold: 3000, period: 25000 }
      : { high: 2600, low: 5000, ratio: 2, setup: 500, hold: 0, period: 10000 };
  const tSp = Math.trunc(500 / clockPeriod);
  const tSudat = Math.max(Math.trunc((timing.setup - 2 * clockPeriod) / clockPeriod) - 2 - tSp, 0);
  const tHddat = Math.max(Math.trunc((timing.hold - 2 * clockPeriod) / clockPeriod) - 2 - tSp, 0);
  const highLimit = Math.trunc((timing.high - 2 * clockPeriod) / clockPeriod) - 2 - tSp;
  const periodLimit = Math.trunc((Math.trunc(timing.period / (1 + timing.ratio)) - 2 * clockPeriod) / clockPeriod) - 2 - tSp;
  const lowLimit = Math.trunc(
    (Math.trunc((timing.low - 2 * clockPeriod) / clockPeriod) - 2 - tSp) / timing.ratio,
  );
  const tSclhi = Math.max(highLimit, periodLimit, lowLimit);
  if (tSp < 0 || tSp > 7 || tSudat > 31 || tHddat > 31 || tSclhi < 0 || tSclhi > 511) {
    return undefined;
  }
  const highPeriod = 2 * clockPeriod + (2 + tSp + tSclhi) * clockPeriod;
  const actualHz = Math.trunc(10_000_000_000 / (highPeriod * (1 + timing.ratio)));
  if (Math.abs(actualHz - busHz) / busHz > 0.05) {
    return undefined;
  }
  return { actual_hz: actualHz, t_sp: tSp, t_sudat: tSudat, t_hddat: tHddat, t_sclhi: tSclhi };
}

export function defaultClockSettings(soc: string, board = ''): ClockSettings {
  const source = clockSourcesForSoc(soc, board)[0];
  return {
    auto_clock: true,
    clock_source: source.id,
    clock_divider: 1,
    peripheral_clock_hz: source.hz,
  };
}
