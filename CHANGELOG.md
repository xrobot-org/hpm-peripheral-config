# Changelog

All notable changes to XRobot HPM Peripheral Config are documented here.

## 0.2.19 - 2026-07-13

- Reload peripheral discovery automatically when the selected `.hpmpc` changes.
- Preserve unsaved peripheral behavior settings while applying updated Pinmux functions and pins.
- Remove the redundant manual `.hpmpc` refresh button from the configuration toolbar.

## 0.2.18 - 2026-07-13

- Add English and Simplified Chinese interfaces that follow the VS Code locale.
- Add UART, I2C, SPI, CAN and CAN FD peripheral configuration and validation.
- Add HPM clock selection and communication-timing checks.
- Generate LibXR configuration and HPM board/pinmux integration code.
- Open and synchronize repository-owned `.hpmpc` files with the official HPM Pinmux Tool.
