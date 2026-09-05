#Requires -Version 5.1

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not [System.IO.Compression.ZipArchiveEntry].GetProperty('ExternalAttributes')) {
    throw 'VSIX validation requires .NET Framework 4.7.2 or newer.'
}

function Assert-SafeVsixEntry {
    param(
        [Parameter(Mandatory = $true)][System.IO.Compression.ZipArchiveEntry]$Entry,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $entryName = $Entry.FullName
    if ([string]::IsNullOrWhiteSpace($entryName) -or $entryName.IndexOf([char]0) -ge 0) {
        throw "$Label VSIX contains an empty or invalid archive path."
    }
    if ($entryName.Contains('\') -or
        $entryName.StartsWith('/') -or
        $entryName -match '^[A-Za-z]:') {
        throw "$Label VSIX contains a non-canonical archive path: $entryName"
    }

    $segments = @($entryName.Split('/'))
    $isDirectory = [string]::IsNullOrEmpty($Entry.Name)
    if ($isDirectory) {
        if (-not $entryName.EndsWith('/') -or $segments.Count -lt 2) {
            throw "$Label VSIX contains an invalid directory entry: $entryName"
        }
        $segments = @($segments[0..($segments.Count - 2)])
    }
    if ($segments.Count -eq 0 -or
        @($segments | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw "$Label VSIX contains an unsafe archive path: $entryName"
    }
    foreach ($segment in $segments) {
        if ($segment.Length -gt 255) {
            throw "$Label VSIX path component exceeds the Windows limit: $entryName"
        }
        if ($segment -match '~[0-9]') {
            throw "$Label VSIX contains a DOS 8.3-style archive path: $entryName"
        }
        if ($segment.IndexOfAny([char[]]'<>:"|?*') -ge 0 -or
            $segment -match '[\x00-\x1f]' -or
            $segment.EndsWith(' ') -or
            $segment.EndsWith('.')) {
            throw "$Label VSIX contains a Windows-unsafe archive path: $entryName"
        }
        $deviceName = $segment.Split('.')[0].TrimEnd(' ').ToUpperInvariant()
        if ($deviceName -match '^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|\u00B9|\u00B2|\u00B3)|LPT(?:[1-9]|\u00B9|\u00B2|\u00B3))$') {
            throw "$Label VSIX contains a reserved Windows archive path: $entryName"
        }
    }

    $unixFileType = ($Entry.ExternalAttributes -shr 16) -band 0xF000
    $windowsReparsePoint = $Entry.ExternalAttributes -band [int][System.IO.FileAttributes]::ReparsePoint
    if ($unixFileType -eq 0xA000 -or $windowsReparsePoint -ne 0) {
        throw "$Label VSIX contains a symbolic-link entry: $entryName"
    }
}

function Read-BoundedVsixEntryText {
    param(
        [Parameter(Mandatory = $true)][System.IO.Compression.ZipArchiveEntry]$Entry,
        [Parameter(Mandatory = $true)][long]$MaxBytes,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Entry.Length -gt $MaxBytes) {
        throw "$Label is unexpectedly large: $($Entry.FullName)"
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
        throw "$Label is not valid UTF-8: $($Entry.FullName)"
    }
    finally {
        $reader.Dispose()
    }
    if ([System.Text.Encoding]::UTF8.GetByteCount($text) -gt $MaxBytes) {
        throw "$Label exceeds its decoded size limit: $($Entry.FullName)"
    }
    return $text
}

function Read-SafeVsixXml {
    param(
        [Parameter(Mandatory = $true)][System.IO.Compression.ZipArchiveEntry]$Entry,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Entry.Length -gt 1048576) {
        throw "$Label XML is unexpectedly large: $($Entry.FullName)"
    }
    $settings = [System.Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.CloseInput = $true
    $reader = [System.Xml.XmlReader]::Create($Entry.Open(), $settings)
    try {
        $document = [System.Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
        return $document
    }
    catch {
        throw "$Label contains invalid XML in $($Entry.FullName): $($_.Exception.Message)"
    }
    finally {
        $reader.Dispose()
    }
}

function Read-VsixMetadata {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Label = 'Extension',
        [ValidateRange(1, 100000)][int]$MaxEntries = 20000,
        [ValidateRange(1, 2147483647)][long]$MaxEntryBytes = 536870912,
        [ValidateRange(1, 1099511627776)][long]$MaxTotalBytes = 2147483648
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label VSIX file does not exist: $Path"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $resolvedPath = (Resolve-Path -LiteralPath $Path).ProviderPath
    $archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedPath)
    try {
        if ($archive.Entries.Count -gt $MaxEntries) {
            throw "$Label VSIX archive entry limit exceeded ($MaxEntries)."
        }

        $entriesByName = @{}
        $entryKindsByPath = @{}
        $requiredDirectoryPaths = @{}
        [long]$totalBytes = 0
        foreach ($entry in $archive.Entries) {
            Assert-SafeVsixEntry -Entry $entry -Label $Label
            $entryKey = $entry.FullName.ToLowerInvariant()
            if ($entriesByName.ContainsKey($entryKey)) {
                throw "$Label VSIX contains a duplicate archive path: $($entry.FullName)"
            }
            $entriesByName[$entryKey] = $entry

            $isDirectory = [string]::IsNullOrEmpty($entry.Name)
            $canonicalPathKey = $entry.FullName.TrimEnd([char[]]'/').ToLowerInvariant()
            if ($entryKindsByPath.ContainsKey($canonicalPathKey) -or
                (-not $isDirectory -and $requiredDirectoryPaths.ContainsKey($canonicalPathKey))) {
                throw "$Label VSIX contains a file and directory archive path collision: $($entry.FullName)"
            }
            $pathSegments = @($canonicalPathKey.Split('/'))
            for ($segmentIndex = 0; $segmentIndex -lt ($pathSegments.Count - 1); $segmentIndex += 1) {
                $ancestorPath = [string]::Join('/', $pathSegments[0..$segmentIndex])
                if ($entryKindsByPath.ContainsKey($ancestorPath) -and
                    $entryKindsByPath[$ancestorPath] -eq 'file') {
                    throw "$Label VSIX contains a file and directory archive path collision: $($entry.FullName)"
                }
                $requiredDirectoryPaths[$ancestorPath] = $true
            }
            $entryKindsByPath[$canonicalPathKey] = if ($isDirectory) { 'directory' } else { 'file' }

            if ($entry.Length -gt $MaxEntryBytes) {
                throw "$Label VSIX entry exceeds the size limit: $($entry.FullName)"
            }
            $totalBytes += $entry.Length
            if ($totalBytes -gt $MaxTotalBytes) {
                throw "$Label VSIX uncompressed size limit exceeded ($MaxTotalBytes bytes)."
            }

            if (-not [string]::IsNullOrEmpty($entry.Name)) {
                $stream = $entry.Open()
                try {
                    $buffer = New-Object byte[] 65536
                    [long]$readBytes = 0
                    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $readBytes += $read
                        if ($readBytes -gt $MaxEntryBytes -or $readBytes -gt $entry.Length) {
                            throw "$Label VSIX entry expanded beyond its declared size: $($entry.FullName)"
                        }
                    }
                    if ($readBytes -ne $entry.Length) {
                        throw "$Label VSIX entry length is inconsistent: $($entry.FullName)"
                    }
                }
                finally {
                    $stream.Dispose()
                }
            }
        }

        foreach ($requiredName in @('[content_types].xml', 'extension.vsixmanifest', 'extension/package.json')) {
            if (-not $entriesByName.ContainsKey($requiredName)) {
                throw "$Label VSIX is missing required archive entry: $requiredName"
            }
        }

        $contentTypes = Read-SafeVsixXml -Entry $entriesByName['[content_types].xml'] -Label $Label
        if (-not $contentTypes.DocumentElement -or
            $contentTypes.DocumentElement.LocalName -ne 'Types' -or
            $contentTypes.DocumentElement.NamespaceURI -ne 'http://schemas.openxmlformats.org/package/2006/content-types') {
            throw "$Label VSIX has an invalid [Content_Types].xml root."
        }
        $contentTypeEntries = @($contentTypes.DocumentElement.ChildNodes | Where-Object {
            $_ -is [System.Xml.XmlElement]
        })
        if ($contentTypeEntries.Count -eq 0) {
            throw "$Label VSIX has no declared OPC content types."
        }
        foreach ($contentTypeEntry in $contentTypeEntries) {
            if ($contentTypeEntry.LocalName -notin @('Default', 'Override') -or
                -not $contentTypeEntry.GetAttribute('ContentType')) {
                throw "$Label VSIX has an invalid OPC content type declaration."
            }
        }

        $packageText = Read-BoundedVsixEntryText `
            -Entry $entriesByName['extension/package.json'] `
            -MaxBytes 1048576 `
            -Label "$Label package manifest"
        try {
            $packageManifest = $packageText | ConvertFrom-Json
        }
        catch {
            throw "$Label VSIX contains an invalid extension/package.json: $($_.Exception.Message)"
        }
        if (-not $packageManifest -or
            -not [string]$packageManifest.name -or
            -not [string]$packageManifest.publisher -or
            -not [string]$packageManifest.version) {
            throw "$Label VSIX package manifest has no complete identity."
        }

        $vsixManifest = Read-SafeVsixXml -Entry $entriesByName['extension.vsixmanifest'] -Label $Label
        $identities = @($vsixManifest.SelectNodes(
            "/*[local-name()='PackageManifest']/*[local-name()='Metadata']/*[local-name()='Identity']"
        ))
        if ($identities.Count -ne 1) {
            throw "$Label VSIX must contain exactly one container identity."
        }
        $identity = $identities[0]
        if (-not $identity.GetAttribute('Id') -or
            -not $identity.GetAttribute('Publisher') -or
            -not $identity.GetAttribute('Version')) {
            throw "$Label VSIX container identity is incomplete."
        }

        return [pscustomobject]@{
            PackageManifest = $packageManifest
            ContainerId = $identity.GetAttribute('Id')
            ContainerPublisher = $identity.GetAttribute('Publisher')
            ContainerVersion = $identity.GetAttribute('Version')
            EntryNames = @($archive.Entries | ForEach-Object { $_.FullName })
            TotalUncompressedBytes = $totalBytes
        }
    }
    finally {
        $archive.Dispose()
    }
}
