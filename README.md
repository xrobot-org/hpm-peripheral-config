# XRobot HPM Peripheral Config

A community VS Code extension for configuring HPMicro on-chip peripherals and
generating XRobot + LibXR project glue.

The official HPM Pinmux Tool remains responsible for pin assignment in
`.hpmpc`. This extension reads those assignments, provides a graphical editor
for peripheral behavior, and updates the project-side configuration and board
files used by LibXR.

> This is a community integration maintained by the XRobot project. It is not
> an official HPMicro product and is not endorsed by HPMicro.

## Features

- Discover HPM projects and the board `pinmux.hpmpc` file.
- Select the Pinmux functions that belong to the active application.
- Configure UART, I2C, SPI, CAN and CAN FD behavior in a VS Code webview.
- Validate peripheral clocks, communication timing and incompatible settings.
- Generate or update `hpm_peripherals.yaml`, `User/libxr_config.yaml`,
  `pinmux.c/h` and `board.c/h`.
- Run `xr_hpm_cfg` to regenerate `.config.yaml` and `User/app_main.cpp`.
- Open the official HPM Pinmux Tool and HPM SDK project generator.
- Follow the VS Code display language for English and Simplified Chinese UI.

## Requirements

- A supported HPM SDK project containing `.hpmpc`, `board.c/h` and
  `pinmux.c/h` files.
- [HPM Pinmux Tool](https://marketplace.visualstudio.com/items?itemName=HPMicro.hpm-pinmux-tool)
  for graphical pin assignment.
- HPM SDK Env when using the official project generator.
- The HPM generator branch of
  [LibXR_CppCodeGenerator](https://github.com/CaFeZn/LibXR_CppCodeGenerator/tree/feat/hpm-config-generator),
  which provides `xr_hpm_cfg` when `hpmPeripheral.runLibxrGenerator` is enabled.
- The matching
  [LibXR HPM peripheral branch](https://github.com/CaFeZn/libxr/tree/feat/hpm-uart-peripheral-config)
  for generated UART and GPIO-CS SPI code.

Install the current HPM generator with:

```bash
python -m pip install --upgrade "git+https://github.com/CaFeZn/LibXR_CppCodeGenerator.git@feat/hpm-config-generator"
```

Until these HPM changes are merged into upstream releases, point the project's
LibXR checkout or `LIBXR_DIR` at the matching branch above. The extension never
rewrites the project's LibXR repository or CMake dependency source.

## Usage

1. Open the HPM project root in VS Code.
2. Open **XRobot HPM Peripherals** in the Activity Bar.
3. Use **Pinmux** to assign pins with the official tool.
4. Select **Refresh from .hpmpc** and configure the detected peripherals.
5. Select **Save + Generate** after the configuration check passes.

The extension preserves unmanaged sections in `User/libxr_config.yaml` and
only updates the peripheral entries it owns. Commit project files before the
first generation so changes can be reviewed easily.

## Settings

- `hpmPeripheral.configPath`: peripheral behavior YAML relative to the project.
- `hpmPeripheral.hpmpcPath`: optional explicit `.hpmpc` path.
- `hpmPeripheral.sdkEnvPath`: HPM SDK Env directory.
- `hpmPeripheral.runLibxrGenerator`: run `xr_hpm_cfg` after board generation.

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
