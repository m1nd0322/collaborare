#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string]$ExpectedCollaborareVersion,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string]$ExpectedNodeVersion,

    [string]$RepositoryRoot = (Join-Path $PSScriptRoot '..'),

    [string]$OutputPath = (Join-Path (Join-Path $PSScriptRoot '..') 'dist/DEPLOYMENT-SHA256SUMS.txt'),

    [switch]$Verify
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$expectedVsceVersion = '3.9.2'
$normalizedExpectedNodeVersion = $ExpectedNodeVersion.TrimStart('v')

$root = (Resolve-Path -LiteralPath $RepositoryRoot).ProviderPath
$rootPrefix = $root
if (-not $rootPrefix.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $rootPrefix += [System.IO.Path]::DirectorySeparatorChar
}

function Get-ManifestRelativePath {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Deployment file is outside the repository root: $fullPath"
    }

    return $fullPath.Substring($rootPrefix.Length).Replace('\', '/')
}

function Assert-NoReparsePoint {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Deployment file is outside the repository root: $fullPath"
    }

    $relativePath = $fullPath.Substring($rootPrefix.Length)
    $currentPath = $root
    foreach ($segment in $relativePath.Split([System.IO.Path]::DirectorySeparatorChar)) {
        if (-not $segment) {
            continue
        }
        $currentPath = Join-Path $currentPath $segment
        $item = Get-Item -LiteralPath $currentPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Deployment paths cannot contain a symbolic link or junction: $currentPath"
        }
    }
}

function Assert-OutputPathSafety {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    $relativePath = $fullPath.Substring($pathRoot.Length)
    $currentPath = $pathRoot
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
            throw "Deployment manifest output paths cannot contain a symbolic link or junction: $currentPath"
        }
    }
}

function Assert-BuildMetadata {
    $buildInfoPath = Join-Path $root 'dist/BUILD-INFO.json'
    $checksumPath = Join-Path $root 'dist/SHA256SUMS.txt'
    $expectedArtifact = 'collaborare-{0}.vsix' -f $ExpectedCollaborareVersion
    $artifactPath = Join-Path $root "dist/$expectedArtifact"
    foreach ($requiredPath in @($buildInfoPath, $checksumPath, $artifactPath)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required release metadata file is missing: $requiredPath"
        }
        Assert-NoReparsePoint -LiteralPath $requiredPath
    }

    try {
        $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "BUILD-INFO.json is invalid: $($_.Exception.Message)"
    }
    if ([string]$buildInfo.schema -cne 'collaborare/build-info/v1' -or
        [string]$buildInfo.extensionVersion -cne $ExpectedCollaborareVersion -or
        [string]$buildInfo.nodeVersion -cne $normalizedExpectedNodeVersion -or
        [string]$buildInfo.vsceVersion -cne $expectedVsceVersion -or
        [string]$buildInfo.artifact -cne $expectedArtifact -or
        [string]$buildInfo.vsceMode -notin @('npx', 'pre-provisioned')) {
        throw 'BUILD-INFO.json does not match the expected Collaborare release and build toolchain.'
    }

    $artifactHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$buildInfo.artifactSha256 -cne $artifactHash) {
        throw 'BUILD-INFO.json artifactSha256 does not match the Collaborare VSIX.'
    }

    $checksumLines = @(Get-Content -LiteralPath $checksumPath | Where-Object { $_ })
    if ($checksumLines.Count -ne 1 -or
        $checksumLines[0] -cne "$artifactHash  $expectedArtifact") {
        throw 'SHA256SUMS.txt does not match the Collaborare VSIX and expected artifact name.'
    }
}

function Get-ExpectedDeploymentFiles {
    $expectedVsixName = 'collaborare-{0}.vsix' -f $ExpectedCollaborareVersion

    $requiredRelativePaths = @(
        'README.md',
        'docs/DEPLOYMENT.md',
        'docs/OFFLINE_BOM.md',
        'docs/OFFLINE_BUNDLE.md',
        'scripts/Initialize-Project.ps1',
        'scripts/Install-Collaborare.ps1',
        'scripts/New-DeploymentManifest.ps1',
        'scripts/New-OfflineBundle.ps1',
        'scripts/Start-Dashboard.ps1',
        'scripts/Test-OfflineBundle.ps1',
        'scripts/Test-VsixArtifact.ps1',
        'scripts/Vsix-Validation.ps1',
        'dist/BUILD-INFO.json',
        'dist/README.md',
        'dist/SHA256SUMS.txt',
        "dist/$expectedVsixName",
        'dashboard/package.json',
        'dashboard/README.md',
        'dashboard/server.js'
    )

    $files = New-Object System.Collections.Generic.List[string]
    foreach ($relativePath in $requiredRelativePaths) {
        $platformPath = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $fullPath = Join-Path $root $platformPath
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Required deployment file is missing: $relativePath"
        }
        Assert-NoReparsePoint -LiteralPath $fullPath
        $resolvedPath = (Resolve-Path -LiteralPath $fullPath).ProviderPath
        $files.Add($resolvedPath)
    }

    foreach ($directory in @('dashboard/lib', 'dashboard/public')) {
        $platformPath = $directory.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $fullDirectory = Join-Path $root $platformPath
        foreach ($file in Get-ChildItem -LiteralPath $fullDirectory -File -Recurse) {
            Assert-NoReparsePoint -LiteralPath $file.FullName
            $files.Add($file.FullName)
        }
    }

    $knownScripts = @($requiredRelativePaths |
        Where-Object { $_ -like 'scripts/*.ps1' } |
        ForEach-Object { [System.IO.Path]::GetFileName($_).ToLowerInvariant() })
    $knownScripts += 'package-extension.ps1'
    foreach ($scriptFile in Get-ChildItem -LiteralPath (Join-Path $root 'scripts') -Filter '*.ps1' -File) {
        if ($knownScripts -notcontains $scriptFile.Name.ToLowerInvariant()) {
            throw "Unexpected PowerShell file in the deployment scripts directory: $($scriptFile.Name)"
        }
    }

    $expectedVsixPath = [System.IO.Path]::GetFullPath((Join-Path $root "dist/$expectedVsixName"))
    foreach ($vsix in Get-ChildItem -LiteralPath (Join-Path $root 'dist') -Filter '*.vsix' -File) {
        if ([System.IO.Path]::GetFullPath($vsix.FullName) -ne $expectedVsixPath) {
            throw "Unexpected VSIX in the deployment artifact directory: $($vsix.Name)"
        }
    }

    return @($files | Sort-Object -Unique)
}

$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
Assert-OutputPathSafety -LiteralPath $resolvedOutputPath
Assert-BuildMetadata
$expectedFiles = @(Get-ExpectedDeploymentFiles)
$expectedByRelativePath = @{}
foreach ($filePath in $expectedFiles) {
    $relativePath = Get-ManifestRelativePath -LiteralPath $filePath
    $expectedByRelativePath[$relativePath] = $filePath
}

if ($expectedFiles -contains $resolvedOutputPath) {
    throw "Deployment manifest output cannot overwrite a deployment input file: $resolvedOutputPath"
}

if ($Verify) {
    if (-not (Test-Path -LiteralPath $resolvedOutputPath -PathType Leaf)) {
        throw "Deployment manifest was not found: $resolvedOutputPath"
    }

    $seen = @{}
    $lineNumber = 0
    foreach ($line in Get-Content -LiteralPath $resolvedOutputPath) {
        $lineNumber += 1
        if (-not $line) {
            continue
        }
        if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') {
            throw "Malformed deployment manifest line ${lineNumber}: $line"
        }

        $expectedHash = $Matches[1].ToLowerInvariant()
        $relativePath = $Matches[2]
        $normalizedPath = $relativePath.Replace('\', '/')
        if ($relativePath -ne $normalizedPath -or
            [System.IO.Path]::IsPathRooted($relativePath) -or
            $relativePath.Split('/') -contains '.' -or
            $relativePath.Split('/') -contains '..') {
            throw "Unsafe or non-canonical path in deployment manifest: $relativePath"
        }
        if ($seen.ContainsKey($relativePath)) {
            throw "Duplicate deployment manifest path: $relativePath"
        }
        if (-not $expectedByRelativePath.ContainsKey($relativePath)) {
            throw "Unexpected deployment manifest path: $relativePath"
        }
        $seen[$relativePath] = $true

        $actualHash = (Get-FileHash -LiteralPath $expectedByRelativePath[$relativePath] -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "Deployment checksum mismatch: $relativePath"
        }
    }

    foreach ($relativePath in $expectedByRelativePath.Keys) {
        if (-not $seen.ContainsKey($relativePath)) {
            throw "Deployment manifest is missing a required path: $relativePath"
        }
    }

    Write-Host "Verified $($seen.Count) Collaborare deployment files: $resolvedOutputPath"
    return
}

$lines = @($expectedFiles | ForEach-Object {
    $relativePath = Get-ManifestRelativePath -LiteralPath $_
    $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $relativePath"
})

$outputDirectory = Split-Path -Parent $resolvedOutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Assert-OutputPathSafety -LiteralPath $resolvedOutputPath
$lines | Set-Content -LiteralPath $resolvedOutputPath -Encoding ASCII

Write-Host "Created Collaborare deployment manifest with $($lines.Count) files: $resolvedOutputPath"
