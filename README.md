# XRobot HPM Peripheral Config

A community VS Code extension for configuring HPMicro on-chip peripherals and
generating XRobot + LibXR project glue.

The official HPM Pinmux Tool remains responsible for pin assignment in
`.hpmpc`. This extension provides the VS Code UI, file watching and local-tool
launching. Project discovery, `.hpmpc` interpretation, configuration
normalization, validation and code generation are delegated to the versioned
JSON interface of `xr_hpm_cfg`.

> This is a community integration maintained by the XRobot project. It is not
> an official HPMicro product and is not endorsed by HPMicro.

## Features

- Discover HPM projects and the board `pinmux.hpmpc` file through `xr_hpm_cfg`.
- Reload detected peripherals automatically when `.hpmpc` is saved.
- Select the Pinmux functions that belong to the active application.
- Configure UART, I2C, SPI, CAN and CAN FD behavior in a VS Code webview.
- Display structured clock, timing and compatibility diagnostics from the LibXR generator.
- Generate or update `hpm_peripherals.yaml`, `User/libxr_config.yaml`,
  `pinmux.c/h` and `board.c/h`.
- Use one transactional `xr_hpm_cfg` generation pass for every managed output.
- Open the official HPM Pinmux Tool and HPM SDK project generator.
- Follow the VS Code display language for English and Simplified Chinese UI.

## Requirements

- A supported HPM SDK project containing `.hpmpc`, `board.c/h` and
  `pinmux.c/h` files.
- [HPM Pinmux Tool](https://marketplace.visualstudio.com/items?itemName=HPMicro.hpm-pinmux-tool)
  for graphical pin assignment.
- HPM SDK Env when using the official project generator.
- LibXR_CppCodeGenerator 5.3.0 or newer from
  [LibXR_CppCodeGenerator](https://github.com/CaFeZn/LibXR_CppCodeGenerator/tree/feat/hpm-config-generator),
  installed so that `xr_hpm_cfg` is on `PATH`, or selected with
  `hpmPeripheral.cliPath`.
- The matching
  [LibXR HPM peripheral branch](https://github.com/CaFeZn/libxr/tree/feat/hpm-uart-peripheral-config)
  for generated UART and GPIO-CS SPI code.

Install the current HPM generator with:

```bash
python -m pip install --upgrade "git+https://github.com/CaFeZn/LibXR_CppCodeGenerator.git@feat/hpm-config-generator"
```

The extension requires HPM JSON protocol version 1 and blocks operations when
the CLI response is incompatible. An unknown or pre-5.3.0 package version is
reported as a non-blocking compatibility warning when protocol 1 is still
available.

Until these HPM changes are merged into upstream releases, point the project's
LibXR checkout or `LIBXR_DIR` at the matching branch above. The extension never
rewrites the project's LibXR repository or CMake dependency source.

## Usage

1. Open the HPM project root in VS Code.
2. Open **XRobot HPM Peripherals** in the Activity Bar.
3. Use **Pinmux** to assign pins with the official tool.
4. Save `.hpmpc`; the peripheral editor reloads the detected configuration automatically.
5. Configure the peripherals and select **Save + Generate** after validation passes.

Unsaved peripheral behavior values remain in the editor while updated Pinmux
functions and pins are applied. The command-palette refresh command remains
available for compatibility, but normal use does not require a refresh button.

**Save + Generate** validates the current form without writing it first, then
passes that exact configuration to `xr_hpm_cfg generate --config-stdin`. The
backend commits `hpm_peripherals.yaml` and every generated file in one
transaction, so a render or commit failure does not leave a partially updated
project.

`xr_hpm_cfg` preserves unmanaged sections in `User/libxr_config.yaml` and only
updates the peripheral entries it owns. Commit project files before the first
generation so changes can be reviewed easily.

The repository `.hpmpc` is always the canonical Pinmux configuration. If the
official Pinmux Tool requires credentials, the extension opens a signed copy
under the sibling `.xrobot-local` directory, copies repository content into it
before opening, and synchronizes only its `content` back after saves. A newer
timestamp on a stale signed copy never replaces repository content.

## Settings

- `hpmPeripheral.configPath`: peripheral behavior YAML relative to the project.
- `hpmPeripheral.hpmpcPath`: optional explicit `.hpmpc` path.
- `hpmPeripheral.cliPath`: `xr_hpm_cfg` executable path or command name.
- `hpmPeripheral.cliTimeoutMs`: CLI timeout in milliseconds (default `30000`).
- `hpmPeripheral.sdkEnvPath`: HPM SDK Env directory.

`hpmPeripheral.runLibxrGenerator` was removed in 0.3.0. Generation now always
uses `xr_hpm_cfg`; configure `hpmPeripheral.cliPath` instead.

## Development

```bash
npm ci
npm test
npm run lint
npm run package
```

Generated VSIX packages are intentionally excluded from source control.

## Privacy and security

The extension does not include telemetry. It reads and modifies files in the
open workspace and can start locally installed HPM and LibXR tools when the
corresponding command is selected.

Never commit signed `.hpmpc` credentials, `.xrobot-local`, Marketplace tokens,
or other local secrets. Repository ignore rules exclude these common paths,
but release content should still be reviewed before publishing.

## License

Licensed under the [Apache License 2.0](LICENSE).
