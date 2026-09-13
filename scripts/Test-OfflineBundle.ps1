#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BundlePath,

    [Parameter(Mandatory = $true)]
    [string]$TrustedPayloadManifestPath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string]$ExpectedCollaborareVersion,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string]$ExpectedNodeVersion,

    [string]$ChecksumPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-ManifestEntries {
    param([Parameter(Mandatory = $true)][string]$Path)

    $entries = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if (-not $line) {
            continue
        }
        if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') {
            throw "Malformed trusted payload manifest line: $line"
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
            throw "Unsafe trusted payload manifest path: $relativePath"
        }
        $key = $relativePath.ToLowerInvariant()
        if ($entries.ContainsKey($key)) {
            throw "Duplicate trusted payload manifest path: $relativePath"
        }
        $entries[$key] = [pscustomobject]@{
            Hash = $hash
            RelativePath = $relativePath
        }
    }
    if ($entries.Count -eq 0) {
        throw 'Trusted payload manifest contains no files.'
    }
    return $entries
}

function Assert-SafeArchivePath {
    param([Parameter(Mandatory = $true)][string]$EntryName)

    if ([string]::IsNullOrWhiteSpace($EntryName) -or
        $EntryName.IndexOf([char]0) -ge 0 -or
        $EntryName.Contains('\') -or
        $EntryName.StartsWith('/') -or
        $EntryName -match '^[A-Za-z]:') {
        throw "Offline bundle contains a non-canonical archive path: $EntryName"
    }
    if ($EntryName.EndsWith('/')) {
        throw "Offline bundle contains an unexpected directory entry: $EntryName"
    }
    $segments = @($EntryName.Split('/'))
    if ($segments.Count -eq 0 -or
        @($segments | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw "Offline bundle contains an unsafe archive path: $EntryName"
    }
    foreach ($segment in $segments) {
        if ($segment.Length -gt 255 -or
            $segment -match '~[0-9]' -or
            $segment.IndexOfAny([char[]]'<>:"|?*') -ge 0 -or
            $segment -match '[\x00-\x1f]' -or
            $segment.EndsWith(' ') -or
            $segment.EndsWith('.')) {
            throw "Offline bundle contains a Windows-unsafe archive path: $EntryName"
        }
        $deviceName = $segment.Split('.')[0].TrimEnd(' ').ToUpperInvariant()
        if ($deviceName -match '^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|\u00B9|\u00B2|\u00B3)|LPT(?:[1-9]|\u00B9|\u00B2|\u00B3))$') {
            throw "Offline bundle contains a reserved Windows archive path: $EntryName"
        }
    }
}

function Read-BoundedArchiveText {
    param(
        [Parameter(Mandatory = $true)][object]$Entry,
        [Parameter(Mandatory = $true)][long]$MaxBytes
    )

    if ($Entry.Length -gt $MaxBytes) {
        throw "Offline bundle metadata entry is too large: $($Entry.FullName)"
    }
    $reader = [System.IO.StreamReader]::new(
        $Entry.Open(),
        [System.Text.UTF8Encoding]::new($false, $true),
        $true
    )
    try {
        $text = $reader.ReadToEnd()
    }
    catch {
        throw "Offline bundle metadata is not valid UTF-8: $($Entry.FullName)"
    }
    finally {
        $reader.Dispose()
    }
    if ([System.Text.Encoding]::UTF8.GetByteCount($text) -gt $MaxBytes) {
        throw "Offline bundle metadata exceeds its decoded size limit: $($Entry.FullName)"
    }
    return $text
}

if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) {
    throw "Offline bundle does not exist: $BundlePath"
}
if (-not (Test-Path -LiteralPath $TrustedPayloadManifestPath -PathType Leaf)) {
    throw "Trusted payload manifest does not exist: $TrustedPayloadManifestPath"
}
$trustedManifestItem = Get-Item -LiteralPath $TrustedPayloadManifestPath -Force
if (($trustedManifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Trusted payload manifest cannot be a symbolic link or junction: $TrustedPayloadManifestPath"
}
$resolvedBundlePath = (Resolve-Path -LiteralPath $BundlePath).ProviderPath
$trustedEntries = Get-ManifestEntries -Path $TrustedPayloadManifestPath
$actualEntries = @{}
[long]$totalBytes = 0
$maxEntries = 1000
$maxEntryBytes = 16777216
$maxTotalBytes = 67108864
$maxArchiveBytes = 8388608
$bundleItem = Get-Item -LiteralPath $resolvedBundlePath -Force
if (($bundleItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Offline bundle cannot be a symbolic link or junction: $resolvedBundlePath"
}
if ($bundleItem.Length -gt $maxArchiveBytes) {
    throw 'Offline bundle archive exceeds the size limit.'
}
$bundleFileStream = [System.IO.File]::Open(
    $resolvedBundlePath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
)
try {
    if ($bundleFileStream.Length -gt $maxArchiveBytes) {
        throw 'Offline bundle archive exceeds the size limit.'
    }
    $bundleBytes = New-Object byte[] ([int]$bundleFileStream.Length)
    [int]$bundleOffset = 0
    while ($bundleOffset -lt $bundleBytes.Length) {
        $read = $bundleFileStream.Read($bundleBytes, $bundleOffset, $bundleBytes.Length - $bundleOffset)
        if ($read -le 0) {
            throw 'Offline bundle could not be read completely.'
        }
        $bundleOffset += $read
    }
}
finally {
    $bundleFileStream.Dispose()
}
$bundleSha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $bundleHash = [System.BitConverter]::ToString($bundleSha256.ComputeHash($bundleBytes)).Replace('-', '').ToLowerInvariant()
}
finally {
    $bundleSha256.Dispose()
}
$bundleStream = [System.IO.MemoryStream]::new($bundleBytes, $false)
$archive = $null
try {
    $archive = [System.IO.Compression.ZipArchive]::new(
        $bundleStream,
        [System.IO.Compression.ZipArchiveMode]::Read,
        $false
    )
    try {
        $archiveEntries = @($archive.get_Entries())
    }
    catch {
        throw "Offline bundle archive entries could not be read safely: $($_.Exception.Message)"
    }
    if ($archiveEntries.Count -gt $maxEntries) {
        throw "Offline bundle contains too many entries: $($archiveEntries.Count)"
    }
    foreach ($entry in $archiveEntries) {
        Assert-SafeArchivePath -EntryName $entry.FullName
        $key = $entry.FullName.ToLowerInvariant()
        if ($actualEntries.ContainsKey($key)) {
            throw "Offline bundle contains a duplicate archive path: $($entry.FullName)"
        }
        if (-not $trustedEntries.ContainsKey($key) -or
            $trustedEntries[$key].RelativePath -cne $entry.FullName) {
            throw "Offline bundle contains an unexpected payload path: $($entry.FullName)"
        }
        $unixFileType = ($entry.ExternalAttributes -shr 16) -band 0xF000
        $windowsReparsePoint = $entry.ExternalAttributes -band [int][System.IO.FileAttributes]::ReparsePoint
        if ($unixFileType -eq 0xA000 -or $windowsReparsePoint -ne 0) {
            throw "Offline bundle contains a symbolic-link entry: $($entry.FullName)"
        }
        if ($entry.Length -gt $maxEntryBytes) {
            throw "Offline bundle entry exceeds the size limit: $($entry.FullName)"
        }
        $totalBytes += $entry.Length
        if ($totalBytes -gt $maxTotalBytes) {
            throw 'Offline bundle uncompressed size limit exceeded.'
        }
        $stream = $entry.Open()
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $buffer = New-Object byte[] 65536
            [long]$readBytes = 0
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $readBytes += $read
                if ($readBytes -gt $maxEntryBytes -or $readBytes -gt $entry.Length) {
                    throw "Offline bundle entry expanded beyond its declared size: $($entry.FullName)"
                }
            }
            if ($readBytes -ne $entry.Length) {
                throw "Offline bundle entry length is inconsistent: $($entry.FullName)"
            }
            $stream.Dispose()
            $stream = $entry.Open()
            $actualHash = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha256.Dispose()
            $stream.Dispose()
        }
        if ($actualHash -ne $trustedEntries[$key].Hash) {
            throw "Offline bundle payload checksum mismatch: $($entry.FullName)"
        }
        $actualEntries[$key] = $true
    }
    foreach ($key in $trustedEntries.Keys) {
        if (-not $actualEntries.ContainsKey($key)) {
            throw "Offline bundle is missing a required payload path: $($trustedEntries[$key].RelativePath)"
        }
    }

    $buildInfoEntry = $archiveEntries | Where-Object { $_.FullName -ceq 'dist/BUILD-INFO.json' } | Select-Object -First 1
    if (-not $buildInfoEntry) {
        throw 'Offline bundle is missing dist/BUILD-INFO.json.'
    }
    $buildInfo = Read-BoundedArchiveText -Entry $buildInfoEntry -MaxBytes 1048576 | ConvertFrom-Json
    $normalizedNodeVersion = $ExpectedNodeVersion.TrimStart('v')
    $expectedArtifact = 'collaborare-{0}.vsix' -f $ExpectedCollaborareVersion
    if ([string]$buildInfo.schema -cne 'collaborare/build-info/v1' -or
        [string]$buildInfo.extensionVersion -cne $ExpectedCollaborareVersion -or
        [string]$buildInfo.nodeVersion -cne $normalizedNodeVersion -or
        [string]$buildInfo.artifact -cne $expectedArtifact) {
        throw 'Offline bundle BUILD-INFO.json does not match the expected release.'
    }
    $artifactKey = ('dist/{0}' -f $expectedArtifact).ToLowerInvariant()
    if ([string]$buildInfo.artifactSha256 -cne $trustedEntries[$artifactKey].Hash) {
        throw 'Offline bundle BUILD-INFO.json artifactSha256 does not match the trusted payload manifest.'
    }
}
finally {
    if ($archive) {
        $archive.Dispose()
    }
    $bundleStream.Dispose()
}

if ($ChecksumPath) {
    if (-not (Test-Path -LiteralPath $ChecksumPath -PathType Leaf)) {
        throw "Offline bundle checksum sidecar does not exist: $ChecksumPath"
    }
    $checksumItem = Get-Item -LiteralPath $ChecksumPath -Force
    if (($checksumItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Offline bundle checksum sidecar cannot be a symbolic link or junction: $ChecksumPath"
    }
    $checksumLines = @(Get-Content -LiteralPath $ChecksumPath | Where-Object { $_ })
    $expectedLine = "$bundleHash  $([System.IO.Path]::GetFileName($resolvedBundlePath))"
    if ($checksumLines.Count -ne 1 -or $checksumLines[0] -cne $expectedLine) {
        throw "Offline bundle checksum sidecar does not match: $ChecksumPath"
    }
}

Write-Host "Verified offline Collaborare payload: $resolvedBundlePath"
