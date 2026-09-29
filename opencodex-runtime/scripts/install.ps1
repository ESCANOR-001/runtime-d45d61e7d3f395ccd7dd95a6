#Requires -Version 5.1
$ErrorActionPreference = "Stop"

Write-Host "Installing Remodex..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 18+ is required. Install Node from https://nodejs.org/ and rerun this script."
    exit 1
}

$nodeVersion = & node -p "process.versions.node"
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 18) {
    Write-Error "Node.js 18+ is required. Current version: v$nodeVersion"
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is required to install the published Remodex package."
    exit 1
}

Write-Host "Using Node v$nodeVersion"

# Install Remodex globally.
# If npm reports "install scripts blocked" for bun, rerun as:
#   npm install -g --allow-scripts=bun @remodex/rmx
# (use an elevated PowerShell if the original install was elevated)
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    $npm = Get-Command npm -ErrorAction Stop
}
& $npm.Source install -g @remodex/rmx
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$cli = Get-Command rmx.cmd -ErrorAction SilentlyContinue
if (-not $cli) {
    $cli = Get-Command rmx -ErrorAction SilentlyContinue
}
if (-not $cli) {
    foreach ($alias in @("remodex.cmd", "remodex", "opencodex.cmd", "opencodex", "ocx.cmd", "ocx")) {
        $cli = Get-Command $alias -ErrorAction SilentlyContinue
        if ($cli) { break }
    }
}
if (-not $cli) {
    $npmPrefix = & $npm.Source prefix -g
    Write-Error "Remodex installed, but the canonical 'rmx' command is not on PATH. Add your npm global bin directory to PATH, then reopen PowerShell: $npmPrefix"
    exit 1
}

& $cli.Source help *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Remodex installed, but '$($cli.Name) help' failed with exit code $LASTEXITCODE. Check your npm global install and PATH."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Remodex installed! Run 'rmx init' (aliases: remodex, opencodex, ocx) to set up." -ForegroundColor Green
