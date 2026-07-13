import * as fs from 'node:fs';

import { clockSourceSymbol, type ClockSettings } from './clockConfig';
import type { HpmProject } from './hpmProject';
import type { PeripheralConfig, SpiConfig } from './configFile';
import { t } from './i18n';

const USER_BEGIN = '/* HPM Peripheral Config Begin */';
const USER_END = '/* HPM Peripheral Config End */';

function roleToIomuxRole(instance: string, role: string): string {
  if (instance.startsWith('SPI') && role.startsWith('CS')) {
    return `CS_${role.slice(2)}`;
  }
  return role;
}

function instanceIndex(instance: string): number {
  return Number(/(\d+)$/.exec(instance)?.[1] ?? 0);
}

function instanceSelected(project: HpmProject, config: PeripheralConfig, instance: string): boolean {
  const selected = new Set(config.project.pinmux_functions);
  if (selected.size === 0) return true;
  const peripheral = project.peripherals.find((item) => item.instance === instance);
  return Boolean(
    peripheral && (
      peripheral.functions.some((name) => selected.has(name)) ||
      selected.has(`init_${instance.toLowerCase()}_pins`)
    )
  );
}

function buildMcanPinmuxFunction(instance: string, pins: Record<string, string>): string {
  const name = instance.toLowerCase();
  const lines = [`void init_${name}_pins(void)`, '{'];
  for (const role of ['TXD', 'RXD', 'STBY']) {
    const pad = pins[role];
    if (!pad) {
      continue;
    }
    lines.push(
      `    HPM_IOC->PAD[IOC_PAD_${pad}].FUNC_CTL = IOC_${pad}_FUNC_CTL_${instance}_${roleToIomuxRole(instance, role)};`,
    );
    lines.push('');
  }
  if (lines.at(-1) === '') {
    lines.pop();
  }
  lines.push('}');
  return lines.join('\n');
}

function replaceOrInsertFunction(source: string, name: string, body: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`void\\s+${escaped}\\s*\\(\\s*void\\s*\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
  if (pattern.test(source)) {
    return source.replace(pattern, body);
  }
  const marker = '/* for uart_rx_line_status case';
  if (source.includes(marker)) {
    return source.replace(marker, `${body}\n\n${marker}`);
  }
  return `${source.trimEnd()}\n\n${body}\n`;
}

function ensurePrototype(source: string, prototype: string): string {
  if (source.includes(prototype)) {
    return source;
  }
  const externEnd = '#ifdef __cplusplus\n}';
  if (source.includes(externEnd)) {
    return source.replace(externEnd, `${prototype}\n${externEnd}`);
  }
  return `${source.trimEnd()}\n${prototype}\n`;
}

function generatedBlock(content: string): string {
  return `${USER_BEGIN}\n${content.trimEnd()}\n${USER_END}`;
}

function replaceGeneratedBlock(source: string, content: string, beforeHint: string): string {
  const block = generatedBlock(content);
  const pattern = new RegExp(`${USER_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${USER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
  if (pattern.test(source)) {
    return source.replace(pattern, block);
  }
  if (source.includes(beforeHint)) {
    return source.replace(beforeHint, `${block}\n\n${beforeHint}`);
  }
  return `${source.trimEnd()}\n\n${block}\n`;
}

function hasCFunction(source: string, name: string): boolean {
  return new RegExp(`^[ \\t]*(?:uint32_t|void)\\s+${name}\\s*\\([^;]*\\)\\s*\\{`, 'm').test(source);
}

function cleanManagedClockLines(source: string): string {
  return source.replace(
    /^[ \t]*clock_set_source_divider\([^;]+;[ \t]*\/\* HPM Peripheral Config: [A-Z0-9]+ \*\/[ \t]*\r?\n/gm,
    '',
  );
}

function updatePeripheralClockCase(
  source: string,
  functionName: string,
  base: string,
  clock: string,
  settings: ClockSettings,
): string {
  const functionMatch = new RegExp(
    `^[ \\t]*(?:uint32_t|void)\\s+${functionName}\\s*\\([^;]*\\)\\s*\\{`,
    'm',
  ).exec(source);
  if (!functionMatch) {
    throw new Error(t('generator.clockFunctionMissing', { functionName, base }));
  }
  const openBrace = source.indexOf('{', functionMatch.index);
  if (openBrace < 0) {
    return source;
  }
  let depth = 0;
  let closeBrace = -1;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        closeBrace = index;
        break;
      }
    }
  }
  if (closeBrace < 0) {
    return source;
  }

  let functionText = source.slice(functionMatch.index, closeBrace + 1);
  const instance = base.replace(/^HPM_/, '');
  const setClock = `clock_set_source_divider(${clock}, ${clockSourceSymbol(settings.clock_source)}, ${settings.clock_divider}U); /* HPM Peripheral Config: ${instance} */`;
  const branchPattern = new RegExp(`((?:if|else\\s+if)\\s*\\(\\s*ptr\\s*==\\s*${base}\\s*\\)\\s*\\{)([\\s\\S]*?)(\\n\\s*\\})`);
  const branch = branchPattern.exec(functionText);
  if (branch) {
    let body = branch[2];
    const existing = new RegExp(`^[ \\t]*clock_set_source_divider\\(\\s*${clock}\\s*,[^;]+;`, 'm');
    if (existing.test(body)) {
      body = body.replace(existing, `        ${setClock}`);
    } else {
      const addClock = new RegExp(`(^[ \\t]*clock_add_to_group\\(\\s*${clock}\\s*,[^;]+;)`, 'm');
      body = addClock.test(body)
        ? body.replace(addClock, `$1\n        ${setClock}`)
        : `${body}\n        ${setClock}`;
    }
    functionText = `${functionText.slice(0, branch.index)}${branch[1]}${body}${branch[3]}${functionText.slice(branch.index + branch[0].length)}`;
  } else {
    const keyword = /\bif\s*\(\s*ptr\s*==/.test(functionText) ? 'else if' : 'if';
    const newBranch = `    ${keyword} (ptr == ${base}) {\n        clock_add_to_group(${clock}, 0);\n        ${setClock}\n        return clock_get_frequency(${clock});\n    }\n`;
    const finalReturn = functionText.lastIndexOf('\n    return ');
    const insertAt = finalReturn >= 0 ? finalReturn + 1 : functionText.lastIndexOf('}');
    functionText = `${functionText.slice(0, insertAt)}${newBranch}${functionText.slice(insertAt)}`;
  }
  return `${source.slice(0, functionMatch.index)}${functionText}${source.slice(closeBrace + 1)}`;
}

function buildBoardBlock(project: HpmProject, config: PeripheralConfig): string {
  const enabled = Object.entries(config.mcan).filter(
    ([instance, value]) => value.enabled && instanceSelected(project, config, instance),
  );
  if (enabled.length === 0) {
    return '';
  }
  const initCases = enabled
    .map(([instance]) => `    ${instance === enabled[0][0] ? 'if' : 'else if'} (ptr == HPM_${instance}) {\n        init_${instance.toLowerCase()}_pins();\n    }`)
    .join('\n');
  const clockCases = enabled
    .map(([instance, value]) => {
      const index = instanceIndex(instance);
      return `    ${instance === enabled[0][0] ? 'if' : 'else if'} (ptr == HPM_${instance}) {\n        clock_add_to_group(clock_can${index}, 0);\n        clock_set_source_divider(clock_can${index}, ${clockSourceSymbol(value.clock_source)}, ${value.clock_divider}U);\n        freq = clock_get_frequency(clock_can${index});\n    }`;
    })
    .join('\n');
  return `void board_init_can(MCAN_Type *ptr)
{
    init_can_pins(ptr);
}

uint32_t board_init_can_clock(MCAN_Type *ptr)
{
    uint32_t freq = 0;
${clockCases}
    return freq;
}

void init_can_pins(MCAN_Type *ptr)
{
${initCases}
}`;
}

function updateSpiCsActiveLevel(source: string, spi?: SpiConfig): string {
  if (!spi) {
    return source;
  }
  const activeLevel = spi.cs_active_low ? 0 : 1;
  const definePattern = /^#define\s+BOARD_SPI_CS_ACTIVE_LEVEL\s+\(?[01]U?\)?/m;
  if (definePattern.test(source)) {
    return source.replace(definePattern, `#define BOARD_SPI_CS_ACTIVE_LEVEL       (${activeLevel}U)`);
  }
  return source;
}

export function generate(project: HpmProject, config: PeripheralConfig): void {
  let pinmuxH = fs.readFileSync(project.pinmuxH, 'utf8');
  let pinmuxC = fs.readFileSync(project.pinmuxC, 'utf8');
  let boardH = fs.readFileSync(project.boardH, 'utf8');
  let boardC = fs.readFileSync(project.boardC, 'utf8');

  const gpioCsInstances = Object.entries(config.spi).filter(
    ([instance, value]) => value.enabled && value.use_gpio_cs && instanceSelected(project, config, instance),
  );
  if (gpioCsInstances.length > 0 && (
    !boardH.includes('BOARD_SPI_CS_ACTIVE_LEVEL') ||
    !boardH.includes('BOARD_SPI_CS_PIN') ||
    !boardC.includes('board_write_spi_cs')
  )) {
    throw new Error(t('generator.gpioCsHelpersMissing'));
  }
  boardH = updateSpiCsActiveLevel(boardH, gpioCsInstances[0]?.[1]);
  boardC = cleanManagedClockLines(boardC);

  for (const [instance, value] of Object.entries(config.spi)) {
    if (value.enabled && instanceSelected(project, config, instance)) {
      const index = instanceIndex(instance);
      boardC = updatePeripheralClockCase(boardC, 'board_init_spi_clock', `HPM_${instance}`, `clock_spi${index}`, value);
    }
  }
  for (const [instance, value] of Object.entries(config.i2c)) {
    if (value.enabled && instanceSelected(project, config, instance)) {
      const index = instanceIndex(instance);
      boardC = updatePeripheralClockCase(boardC, 'board_init_i2c_clock', `HPM_${instance}`, `clock_i2c${index}`, value);
    }
  }
  for (const [instance, value] of Object.entries(config.uart)) {
    if (value.enabled && instanceSelected(project, config, instance)) {
      const index = instanceIndex(instance);
      boardC = updatePeripheralClockCase(boardC, 'board_init_uart_clock', `HPM_${instance}`, `clock_uart${index}`, value);
    }
  }
  for (const [instance, mcan] of Object.entries(config.mcan)) {
    if (!mcan.enabled || !instanceSelected(project, config, instance)) {
      continue;
    }
    const name = instance.toLowerCase();
    pinmuxH = ensurePrototype(pinmuxH, `void init_${name}_pins(void);`);
    pinmuxC = replaceOrInsertFunction(pinmuxC, `init_${name}_pins`, buildMcanPinmuxFunction(instance, mcan.pins));
  }

  const hasEnabledMcan = Object.entries(config.mcan).some(
    ([instance, item]) => item.enabled && instanceSelected(project, config, instance),
  );
  if (hasEnabledMcan) {
    boardH = ensurePrototype(boardH, 'void board_init_can(MCAN_Type *ptr);');
    boardH = ensurePrototype(boardH, 'uint32_t board_init_can_clock(MCAN_Type *ptr);');
    boardH = ensurePrototype(boardH, 'void init_can_pins(MCAN_Type *ptr);');
    if (!boardC.includes(USER_BEGIN) && ['board_init_can', 'board_init_can_clock', 'init_can_pins'].some(
      (name) => hasCFunction(boardC, name),
    )) {
      throw new Error(t('generator.canMarkerMissing'));
    }
    boardC = replaceGeneratedBlock(boardC, buildBoardBlock(project, config), 'void init_gptmr_pins');
  } else if (boardC.includes(USER_BEGIN)) {
    boardC = replaceGeneratedBlock(boardC, '', 'void init_gptmr_pins');
  }

  fs.writeFileSync(project.pinmuxH, pinmuxH, 'utf8');
  fs.writeFileSync(project.pinmuxC, pinmuxC, 'utf8');
  fs.writeFileSync(project.boardH, boardH, 'utf8');
  fs.writeFileSync(project.boardC, boardC, 'utf8');
}
