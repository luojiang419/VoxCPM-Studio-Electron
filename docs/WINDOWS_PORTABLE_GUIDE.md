# Windows Portable Guide

See the full Chinese guide here:

- [Windows便携打包说明.md](./Windows便携打包说明.md)
- [Electron便携包开箱即用说明.md](./Electron便携包开箱即用说明.md)

Recommended entry points:

1. `Electron版本/scripts/build_windows_electron_bundle.ps1`
2. `scripts/build_windows_portable.ps1`
3. `scripts/build_windows_flutter_bundle.ps1`

The portable bundle includes:

1. Private Python runtime
2. Installed project dependencies
3. Optional local model copy
4. Optional FFmpeg copy
5. Desktop launchers and runtime self-check script
