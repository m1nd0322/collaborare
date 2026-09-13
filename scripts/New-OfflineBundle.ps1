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

    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = (Resolve-Path -LiteralPath $RepositoryRoot).ProviderPath
if (-not $OutputPath) {
    $OutputPath = Join-Path $root ('dist/collaborare-{0}-offline-payload.zip' -f $ExpectedCollaborareVersion)
}
$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$deploymentManifestPath = Join-Path $root 'dist/DEPLOYMENT-SHA256SUMS.txt'
$manifestScript = Join-Path $root 'scripts/New-DeploymentManifest.ps1'
$bundleTestScript = Join-Path $root 'scripts/Test-OfflineBundle.ps1'

function Assert-NoReparsePoint {
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
            throw "Offline bundle paths cannot contain a symbolic link or junction: $currentPath"
        }
    }
}

function Get-ManifestEntries {
    param(
        [string]$Path,
        [string]$Content
    )

    $entries = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    $lines = if ($PSBoundParameters.ContainsKey('Content')) {
        $Content -split "`r?`n"
    }
    else {
        Get-Content -LiteralPath $Path
    }
    foreach ($line in $lines) {
        if (-not $line) {
            continue
        }
        if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') {
            throw "Malformed deployment manifest line: $line"
        }
        $hash = $Matches[1].ToLowerInvariant()
        $relativePath = $Matches[2]
        $normalizedPath = $relativePath.Replace('\', '/')
        if ($relativePath -ne $normalizedPath -or
            [System.IO.Path]::IsPathRooted($relativePath) -or
            $relativePath.IndexOf([char]0) -ge 0 -or
            $relativePath.Split('/') -contains '.' -or
            $relativePath.Split('/') -contains '..' -or
            $relativePath.Split('/') -contains '') {
            throw "Unsafe deployment manifest path: $relativePath"
        }
        $key = $relativePath.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            throw "Duplicate deployment manifest path: $relativePath"
        }
        $seen[$key] = $true
        $entries.Add([pscustomobject]@{
            Hash = $hash
            RelativePath = $relativePath
        })
    }
    if ($entries.Count -eq 0) {
        throw 'Deployment manifest contains no files.'
    }
    return $entries.ToArray()
}

function Copy-ManifestFiles {
    param(
        [Parameter(Mandatory = $true)][object[]]$Entries,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    foreach ($entry in $Entries) {
        $sourcePath = Join-Path $root ($entry.RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Deployment manifest source file is missing: $($entry.RelativePath)"
        }
        Assert-NoReparsePoint -LiteralPath $sourcePath
        $destinationPath = Join-Path $DestinationRoot ($entry.RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        $destinationDirectory = Split-Path -Parent $destinationPath
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
        $actualHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $entry.Hash) {
            throw "Deployment manifest staged hash mismatch: $($entry.RelativePath)"
        }
    }
}

function New-DeterministicArchive {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Force
    }
    $archive = [System.IO.Compression.ZipFile]::Open(
        $Destination,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        $fixedTimestamp = [System.DateTimeOffset]::new(
            [System.DateTime]::SpecifyKind([System.DateTime]'1980-01-01', [System.DateTimeKind]::Utc)
        )
        $sourceRootFull = (Resolve-Path -LiteralPath $SourceRoot).ProviderPath
        $sourcePrefix = $sourceRootFull
        if (-not $sourcePrefix.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
            $sourcePrefix += [System.IO.Path]::DirectorySeparatorChar
        }
        $files = @(Get-ChildItem -LiteralPath $sourceRootFull -Recurse -File | Sort-Object FullName)
        foreach ($sourceFile in $files) {
            $relativePath = $sourceFile.FullName.Substring($sourcePrefix.Length).Replace('\', '/')
            $entry = $archive.CreateEntry(
                $relativePath,
                [System.IO.Compression.CompressionLevel]::NoCompression
            )
            $entry.LastWriteTime = $fixedTimestamp
            $entry.ExternalAttributes = 0
            $sourceStream = [System.IO.File]::OpenRead($sourceFile.FullName)
            try {
                $entryStream = $entry.Open()
                try {
                    $sourceStream.CopyTo($entryStream)
                }
                finally {
                    $entryStream.Dispose()
                }
            }
            finally {
                $sourceStream.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Replace-GeneratedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
            throw "Generated file destination is not a regular file: $Destination"
        }
        $backupPath = '{0}.backup-{1}' -f $Destination, [guid]::NewGuid()
        $replaced = $false
        try {
            [System.IO.File]::Replace($Source, $Destination, $backupPath)
            $replaced = $true
        }
        finally {
            if ($replaced) {
                Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
    else {
        [System.IO.File]::Move($Source, $Destination)
    }
}

if (-not (Test-Path -LiteralPath $deploymentManifestPath -PathType Leaf)) {
    throw "Deployment manifest was not found: $deploymentManifestPath"
}
if (-not (Test-Path -LiteralPath $manifestScript -PathType Leaf)) {
    throw "Deployment manifest script was not found: $manifestScript"
}
if (-not (Test-Path -LiteralPath $bundleTestScript -PathType Leaf)) {
    throw "Offline bundle verifier was not found: $bundleTestScript"
}
Assert-NoReparsePoint -LiteralPath $root
Assert-NoReparsePoint -LiteralPath $deploymentManifestPath
Assert-NoReparsePoint -LiteralPath $resolvedOutputPath
if ([System.IO.Path]::GetFullPath($deploymentManifestPath) -eq $resolvedOutputPath) {
    throw 'Offline bundle output cannot overwrite the deployment manifest.'
}

$manifestSnapshot = [System.IO.File]::ReadAllText($deploymentManifestPath, [System.Text.Encoding]::ASCII)
& $manifestScript `
    -RepositoryRoot $root `
    -ExpectedCollaborareVersion $ExpectedCollaborareVersion `
    -ExpectedNodeVersion $ExpectedNodeVersion `
    -Verify
if ([System.IO.File]::ReadAllText($deploymentManifestPath, [System.Text.Encoding]::ASCII) -cne $manifestSnapshot) {
    throw 'Deployment manifest changed while preparing the offline bundle.'
}
$entries = @(Get-ManifestEntries -Content $manifestSnapshot)
$manifestSourcePaths = @{}
foreach ($entry in $entries) {
    $sourcePath = [System.IO.Path]::GetFullPath(
        (Join-Path $root ($entry.RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
    )
    $manifestSourcePaths[$sourcePath.ToLowerInvariant()] = $true
}
if ($manifestSourcePaths.ContainsKey($resolvedOutputPath.ToLowerInvariant())) {
    throw "Offline bundle output cannot overwrite a deployment input file: $resolvedOutputPath"
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('collaborare-offline-bundle-{0}' -f [guid]::NewGuid())
$stagingRoot = Join-Path $temporaryRoot 'payload'
$outputDirectory = Split-Path -Parent $resolvedOutputPath
$checksumPath = Join-Path $outputDirectory 'OFFLINE-BUNDLE-SHA256SUMS.txt'
if ([System.IO.Path]::GetFullPath($checksumPath) -eq $resolvedOutputPath) {
    throw 'Offline bundle output cannot use its checksum sidecar path.'
}

Assert-NoReparsePoint -LiteralPath $outputDirectory
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Assert-NoReparsePoint -LiteralPath $resolvedOutputPath
Assert-NoReparsePoint -LiteralPath $checksumPath
$temporaryArchivePath = Join-Path $outputDirectory ('.collaborare-offline-payload-{0}.tmp.zip' -f [guid]::NewGuid())
$temporaryChecksumPath = Join-Path $outputDirectory ('.collaborare-offline-payload-{0}.tmp.sha256' -f [guid]::NewGuid())
$trustedManifestSnapshotPath = Join-Path $temporaryRoot 'DEPLOYMENT-SHA256SUMS.txt'

try {
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    [System.IO.File]::WriteAllText(
        $trustedManifestSnapshotPath,
        $manifestSnapshot,
        [System.Text.Encoding]::ASCII
    )
    Copy-ManifestFiles -Entries $entries -DestinationRoot $stagingRoot
    New-DeterministicArchive -SourceRoot $stagingRoot -Destination $temporaryArchivePath
    & $bundleTestScript `
        -BundlePath $temporaryArchivePath `
        -TrustedPayloadManifestPath $trustedManifestSnapshotPath `
        -ExpectedCollaborareVersion $ExpectedCollaborareVersion `
        -ExpectedNodeVersion $ExpectedNodeVersion
    $bundleHash = (Get-FileHash -LiteralPath $temporaryArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText(
        $temporaryChecksumPath,
        "$bundleHash  $([System.IO.Path]::GetFileName($resolvedOutputPath))`n",
        [System.Text.Encoding]::ASCII
    )
    Assert-NoReparsePoint -LiteralPath $resolvedOutputPath
    Replace-GeneratedFile -Source $temporaryArchivePath -Destination $resolvedOutputPath
    Assert-NoReparsePoint -LiteralPath $checksumPath
    Replace-GeneratedFile -Source $temporaryChecksumPath -Destination $checksumPath
    & $bundleTestScript `
        -BundlePath $resolvedOutputPath `
        -TrustedPayloadManifestPath $trustedManifestSnapshotPath `
        -ExpectedCollaborareVersion $ExpectedCollaborareVersion `
        -ExpectedNodeVersion $ExpectedNodeVersion `
        -ChecksumPath $checksumPath
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryArchivePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryChecksumPath -Force -ErrorAction SilentlyContinue
}

Write-Host "Created offline Collaborare payload: $resolvedOutputPath"
Write-Host "Checksum: $checksumPath"
