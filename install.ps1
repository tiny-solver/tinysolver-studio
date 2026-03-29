#
# Codeg Server installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/xintaofei/codeg/main/install.ps1 | iex
#   .\install.ps1 -Version v0.5.0
#

param(
    [string]$Version = "",
    [string]$InstallDir = "$env:LOCALAPPDATA\codeg"
)

$ErrorActionPreference = "Stop"
$Repo = "xintaofei/codeg"
$Artifact = "codeg-server-windows-x64"

# ── Resolve version ──

if (-not $Version) {
    Write-Host "Fetching latest release..."
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
    $Version = $release.tag_name
    if (-not $Version) {
        Write-Error "Could not determine latest version"
        exit 1
    }
}

Write-Host "Installing codeg-server $Version (windows/x64)..."

# ── Download and extract ──

$Url = "https://github.com/$Repo/releases/download/$Version/$Artifact.zip"
$TmpDir = Join-Path $env:TEMP "codeg-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$ZipPath = Join-Path $TmpDir "$Artifact.zip"

Write-Host "Downloading $Url..."
try {
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
} catch {
    Write-Error "Download failed. Check that version $Version exists and has a $Artifact asset."
    exit 1
}

Write-Host "Extracting..."
Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force

# ── Install ──

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$BinarySrc = Join-Path $TmpDir $Artifact "codeg-server.exe"
if (-not (Test-Path $BinarySrc)) {
    Write-Error "Binary not found in archive"
    exit 1
}
Copy-Item $BinarySrc -Destination (Join-Path $InstallDir "codeg-server.exe") -Force

# Install web assets
$WebSrc = Join-Path $TmpDir $Artifact "web"
$WebDir = Join-Path $InstallDir "web"
if (Test-Path $WebSrc) {
    Write-Host "Installing web assets to $WebDir..."
    if (Test-Path $WebDir) { Remove-Item $WebDir -Recurse -Force }
    Copy-Item $WebSrc -Destination $WebDir -Recurse
}

# ── Add to PATH ──

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to user PATH (restart terminal to take effect)"
}

# ── Cleanup ──

Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue

# ── Done ──

Write-Host ""
Write-Host "codeg-server installed to $InstallDir\codeg-server.exe"
Write-Host ""
Write-Host "Quick start:"
Write-Host "  `$env:CODEG_STATIC_DIR=`"$WebDir`"; codeg-server"
Write-Host ""
Write-Host "Or with custom settings:"
Write-Host "  `$env:CODEG_PORT=`"3080`"; `$env:CODEG_TOKEN=`"your-secret`"; `$env:CODEG_STATIC_DIR=`"$WebDir`"; codeg-server"
