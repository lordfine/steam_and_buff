$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'package.js')
exit $LASTEXITCODE
