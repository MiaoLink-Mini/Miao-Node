# Windows entry point. Do not set a machine-wide execution-policy override.
$ErrorActionPreference = 'Stop'
# Get-Command can return every matching executable (Volta, MSI, Scoop, ...).
# Preserve PATH precedence, but never pass an array of paths to the call operator.
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    Write-Error 'Node.js >=24.1.0 is required. Install Node.js, then run this script again.'
    exit 1
}
& $node.Source (Join-Path $PSScriptRoot 'scripts/install.mjs') @args
exit $LASTEXITCODE
