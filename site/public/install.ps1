# cc-analyzer installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/yorch/cc-analyzer/main/install.ps1 | iex
#
# Environment overrides:
#   $env:CC_ANALYZER_VERSION      release tag to install (e.g. v0.2.0); default: latest
#   $env:CC_ANALYZER_INSTALL_DIR  install directory; default: %LOCALAPPDATA%\cc-analyzer\bin
$ErrorActionPreference = 'Stop'

$Repo = 'yorch/cc-analyzer'
$Bin = 'cc-analyzer'
$InstallDir = if ($env:CC_ANALYZER_INSTALL_DIR) { $env:CC_ANALYZER_INSTALL_DIR } else { "$env:LOCALAPPDATA\cc-analyzer\bin" }
$Version = if ($env:CC_ANALYZER_VERSION) { $env:CC_ANALYZER_VERSION } else { 'latest' }

# Only an x64 Windows binary is published; it runs on ARM64 via emulation.
$asset = "$Bin-windows-x64.exe"

if ($Version -eq 'latest') {
  $url = "https://github.com/$Repo/releases/latest/download/$asset"
} else {
  $url = "https://github.com/$Repo/releases/download/$Version/$asset"
}

Write-Host "cc-analyzer ($Version) . windows/x64"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = Join-Path $InstallDir "$Bin.exe"

Write-Host "downloading $asset..."
Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
Write-Host "installed to $target"

# PATH guidance (per-user; new terminals pick it up)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$InstallDir*") {
  Write-Host ""
  Write-Host "$InstallDir is not on your PATH. Add it for new terminals with:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$InstallDir;`" + [Environment]::GetEnvironmentVariable('Path','User'), 'User')"
}

Write-Host ""
Write-Host "Done. Run '$Bin help', or just '$Bin' for the interactive TUI."
