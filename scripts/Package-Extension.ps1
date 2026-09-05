#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedNodeVersion,

    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist'),

    [string]$VsceCommand
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$vsceVersion = '3.9.2'

$extensionRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\vscode-extension')).ProviderPath
if ($extensionRoot.StartsWith('\\')) {
    throw 'VSIX packaging from a UNC current directory is not supported by npx.cmd. Copy the source locally or map the share to a drive letter.'
}
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$defaultOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'dist'))
$requestedOutputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
if ($requestedOutputRoot -ne $defaultOutputRoot) {
    throw "Custom output directories are not supported for release packaging. Use: $defaultOutputRoot"
}

function Assert-ReleasePathSafety {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
    $rootPrefix = $repositoryRoot
    if (-not $rootPrefix.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $rootPrefix += [System.IO.Path]::DirectorySeparatorChar
    }
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release output must remain inside the repository root: $fullPath"
    }
    $relativePath = $fullPath.Substring($rootPrefix.Length)
    $currentPath = $repositoryRoot
    foreach ($segment in $relativePath.Split([System.IO.Path]::DirectorySeparatorChar)) {
        if (-not $segment) {
            continue
        }
        $currentPath = Join-Path $currentPath $segment
        if (-not (Test-Path -LiteralPath $currentPath)) {
            break
        }
        $item = Get-Item -LiteralPath $currentPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Release output paths cannot contain a symbolic link or junction: $currentPath"
        }
    }
}

Assert-ReleasePathSafety -LiteralPath $requestedOutputRoot
$manifestPath = Join-Path $extensionRoot 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Assert-ReleasePathSafety -LiteralPath $requestedOutputRoot
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).ProviderPath
$outputPath = Join-Path $outputRoot ("{0}-{1}.vsix" -f $manifest.name, $manifest.version)
Assert-ReleasePathSafety -LiteralPath $outputPath

Push-Location -LiteralPath $extensionRoot
try {
    $node = Get-Command 'node' -ErrorAction SilentlyContinue
    if (-not $node) {
        throw 'An approved Node.js 22 or newer release is required for VSIX packaging.'
    }
    $nodeVersion = (& $node.Source '--version').Trim()
    $nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 22) {
        throw "Packaging requires an approved Node.js 22 or newer release; found $nodeVersion."
    }
    if ($nodeVersion.TrimStart('v') -cne $ExpectedNodeVersion.TrimStart('v')) {
        throw "Node.js version mismatch. Expected $ExpectedNodeVersion; found $nodeVersion."
    }

    if ($VsceCommand) {
        $vsceMode = 'pre-provisioned'
        $vsce = Get-Command $VsceCommand -ErrorAction Stop
        $reportedVsceVersions = @(& $vsce.Source '--version')
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not determine the pre-provisioned vsce version.'
        }
        $reportedVsceVersion = $reportedVsceVersions |
            Where-Object { $_ -match '^\d+\.\d+\.\d+(?:-|$)' } |
            Select-Object -First 1
        if (-not $reportedVsceVersion -or $reportedVsceVersion -cne $VsceVersion) {
            throw "vsce version mismatch. Expected $VsceVersion; found $($reportedVsceVersions -join ' ')."
        }
        & $vsce.Source 'package' '--no-dependencies' '--allow-missing-repository' '--out' $outputPath
    }
    else {
        $vsceMode = 'npx'
        $npx = Get-Command 'npx' -ErrorAction SilentlyContinue
        if (-not $npx) {
            throw 'npx is required unless -VsceCommand points to a pre-provisioned vsce executable.'
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

& (Join-Path $PSScriptRoot 'Test-VsixArtifact.ps1') -VsixPath $outputPath -SourceRoot $extensionRoot

$checksumPath = Join-Path $outputRoot 'SHA256SUMS.txt'
Assert-ReleasePathSafety -LiteralPath $checksumPath
$checksum = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$checksum  $([System.IO.Path]::GetFileName($outputPath))" |
    Set-Content -LiteralPath $checksumPath -Encoding ASCII

$buildInfoPath = Join-Path $outputRoot 'BUILD-INFO.json'
Assert-ReleasePathSafety -LiteralPath $buildInfoPath
$buildInfo = [ordered]@{
    schema = 'collaborare/build-info/v1'
    extensionVersion = [string]$manifest.version
    nodeVersion = $nodeVersion.TrimStart('v')
    vsceVersion = $vsceVersion
    vsceMode = $vsceMode
    artifact = [System.IO.Path]::GetFileName($outputPath)
    artifactSha256 = $checksum
} | ConvertTo-Json
[System.IO.File]::WriteAllText(
    $buildInfoPath,
    "$buildInfo`n",
    [System.Text.UTF8Encoding]::new($false)
)

$deploymentManifestScript = Join-Path $PSScriptRoot 'New-DeploymentManifest.ps1'
if (-not (Test-Path -LiteralPath $deploymentManifestScript -PathType Leaf)) {
    throw "Deployment manifest script was not found: $deploymentManifestScript"
}
& $deploymentManifestScript `
    -RepositoryRoot (Join-Path $PSScriptRoot '..') `
    -ExpectedCollaborareVersion ([string]$manifest.version) `
    -ExpectedNodeVersion $ExpectedNodeVersion

Write-Host "Created: $outputPath"
Write-Host "Checksum: $checksumPath"
Write-Host "Build info: $buildInfoPath"
