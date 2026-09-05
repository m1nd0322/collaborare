#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VsixPath,

    [string]$SourceRoot = (Join-Path $PSScriptRoot '..\vscode-extension')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Vsix-Validation.ps1')

if (-not (Test-Path -LiteralPath $VsixPath -PathType Leaf)) {
    throw "VSIX file does not exist: $VsixPath"
}

$extensionRoot = (Resolve-Path -LiteralPath $SourceRoot).ProviderPath
$extensionPrefix = $extensionRoot
if (-not $extensionPrefix.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $extensionPrefix += [System.IO.Path]::DirectorySeparatorChar
}

$sourceFiles = @(
    (Join-Path $extensionRoot 'package.json'),
    (Join-Path $extensionRoot 'extension.js'),
    (Join-Path $extensionRoot 'README.md'),
    (Join-Path $extensionRoot 'LICENSE.txt')
)
$sourceFiles += @(Get-ChildItem -LiteralPath (Join-Path $extensionRoot 'src') -Filter '*.js' -File)
$metadata = Read-VsixMetadata -Path $VsixPath -Label 'Collaborare'

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $VsixPath).ProviderPath)
try {
    $expectedEntries = @{
        'extension.vsixmanifest' = $true
        '[content_types].xml' = $true
    }
    $archiveEntryNames = @{}
    foreach ($entry in $archive.Entries) {
        $entryName = $entry.FullName.ToLowerInvariant()
        if ($archiveEntryNames.ContainsKey($entryName)) {
            throw "Duplicate file in VSIX: $($entry.FullName)"
        }
        $archiveEntryNames[$entryName] = $true
    }

    foreach ($sourceFileValue in $sourceFiles) {
        $sourceFile = if ($sourceFileValue -is [System.IO.FileInfo]) {
            $sourceFileValue.FullName
        }
        else {
            [string]$sourceFileValue
        }
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
            throw "Expected extension source file is missing: $sourceFile"
        }
        $fullSourcePath = [System.IO.Path]::GetFullPath($sourceFile)
        if (-not $fullSourcePath.StartsWith($extensionPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Extension source file is outside the source root: $fullSourcePath"
        }
        $relativePath = $fullSourcePath.Substring($extensionPrefix.Length).Replace('\', '/')
        $entryName = "extension/$relativePath"
        $entry = $archive.Entries | Where-Object { $_.FullName -ieq $entryName } | Select-Object -First 1
        if (-not $entry) {
            throw "VSIX entry is missing: $entryName"
        }

        $stream = $entry.Open()
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $archiveHash = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha256.Dispose()
            $stream.Dispose()
        }
        $sourceHash = (Get-FileHash -LiteralPath $fullSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($archiveHash -ne $sourceHash) {
            throw "VSIX entry does not match its source file: $entryName"
        }
        $expectedEntries[$entry.FullName.ToLowerInvariant()] = $true
    }

    foreach ($entry in $archive.Entries) {
        if (-not $expectedEntries.ContainsKey($entry.FullName.ToLowerInvariant())) {
            throw "Unexpected file in VSIX: $($entry.FullName)"
        }
    }

    $packageManifest = $metadata.PackageManifest
    foreach ($forbiddenProperty in @('extensionPack', 'extensionDependencies')) {
        if ($packageManifest.PSObject.Properties.Name -contains $forbiddenProperty) {
            throw "VSIX package manifest must not declare ${forbiddenProperty}."
        }
    }

    if ($metadata.ContainerId -ine [string]$packageManifest.name -or
        $metadata.ContainerPublisher -ine [string]$packageManifest.publisher -or
        $metadata.ContainerVersion -cne [string]$packageManifest.version) {
        throw 'VSIX container identity does not match extension/package.json.'
    }
}
finally {
    $archive.Dispose()
}

Write-Host "Verified VSIX contents against source: $VsixPath"
