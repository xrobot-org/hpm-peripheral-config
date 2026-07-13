# Changelog

All notable changes to XRobot HPM Peripheral Config are documented here.

## 0.3.0 - 2026-07-14

- Delegate HPM discovery, normalization, validation and generation exclusively to the versioned `xr_hpm_cfg` JSON protocol.
- Require protocol version 1 and recommend LibXR_CppCodeGenerator 5.3.0 or newer, with localized setup and compatibility guidance.
- Add configurable CLI path and timeout settings; remove the obsolete `runLibxrGenerator` switch and the extension's duplicate HPM business logic.
- Reload `.hpmpc` changes automatically while protecting unsaved form revisions from stale validation or reload responses.
- Make the repository `.hpmpc` canonical when synchronizing with credential-bearing `.xrobot-local` working copies, using atomic replacement for both directions.
- Validate drafts without writes, then use transactional `generate --config-stdin` so the behavior YAML and all generated outputs commit together.
- Localize structured CLI diagnostics by stable diagnostic code and add redacted, bounded protocol-error excerpts to the XRobot output.
- Serialize project-writing workflows, freeze form controls while they run, and reject failed saves before showing any saved state.
- Ignore stale watcher bindings and force-terminate CLI processes that remain alive after timeout or output-limit cancellation.
- Clean generated extension output before compilation so retired business modules cannot enter the VSIX.

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
