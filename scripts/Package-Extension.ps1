#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist'),

    [string]$VsceCommand,

    [string]$VsceVersion = '3.9.2'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$extensionRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\vscode-extension')).ProviderPath
if ($extensionRoot.StartsWith('\\')) {
    throw 'VSIX packaging from a UNC current directory is not supported by npx.cmd. Copy the source locally or map the share to a drive letter.'
}
$manifestPath = Join-Path $extensionRoot 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).ProviderPath
$outputPath = Join-Path $outputRoot ("{0}-{1}.vsix" -f $manifest.name, $manifest.version)

Push-Location $extensionRoot
try {
    if ($VsceCommand) {
        $vsce = Get-Command $VsceCommand -ErrorAction Stop
        & $vsce.Source 'package' '--no-dependencies' '--allow-missing-repository' '--out' $outputPath
    }
    else {
        $npx = Get-Command 'npx' -ErrorAction SilentlyContinue
        $node = Get-Command 'node' -ErrorAction SilentlyContinue
        if (-not $npx -or -not $node) {
            throw 'Node.js and npx are required unless -VsceCommand points to a pre-provisioned vsce executable.'
        }
        $nodeMajor = [int]((& $node.Source '--version').TrimStart('v').Split('.')[0])
        if ($nodeMajor -lt 20) {
            throw "Packaging with @vscode/vsce@$VsceVersion requires Node.js 20 or newer; found version $nodeMajor."
        }
        & $npx.Source '--yes' "@vscode/vsce@$VsceVersion" 'package' '--no-dependencies' '--allow-missing-repository' '--out' $outputPath
    }

    if ($LASTEXITCODE -ne 0) {
        throw "VSIX packaging failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
    throw "VSIX was not created: $outputPath"
}

$checksumPath = Join-Path $outputRoot 'SHA256SUMS.txt'
$checksum = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$checksum  $([System.IO.Path]::GetFileName($outputPath))" |
    Set-Content -LiteralPath $checksumPath -Encoding ASCII

Write-Host "Created: $outputPath"
Write-Host "Checksum: $checksumPath"
