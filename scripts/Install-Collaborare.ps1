#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VsixPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCodeVersion,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCopilotChatVersion,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCollaborareVersion,

    [string]$ProjectPath,

    [string]$CodeCommand = 'code',

    [Parameter(Mandatory = $true)]
    [string]$CopilotChatVsixPath,

    [string[]]$ExpectedPrerequisiteExtension = @(),

    [string[]]$PrerequisiteVsixPath = @(),

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Vsix-Validation.ps1')
if (-not $Force) {
    throw 'Offline installation requires -Force so approved local VSIX bytes replace any same-version installation.'
}

function Assert-VsixContainerIdentity {
    param(
        [Parameter(Mandatory = $true)][object]$Metadata,
        [Parameter(Mandatory = $true)][string]$ExpectedName,
        [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Metadata.ContainerId -ine $ExpectedName -or
        $Metadata.ContainerPublisher -ine $ExpectedPublisher -or
        $Metadata.ContainerVersion -cne $ExpectedVersion) {
        throw "$Label VSIX container identity does not match ${ExpectedPublisher}.${ExpectedName}@${ExpectedVersion}."
    }
}

function Assert-VsixIdentity {
    param(
        [Parameter(Mandatory = $true)][object]$Manifest,
        [Parameter(Mandatory = $true)][string]$ExpectedId,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $actualId = '{0}.{1}' -f $Manifest.publisher, $Manifest.name
    if ($actualId -ine $ExpectedId) {
        throw "$Label VSIX identity mismatch. Expected $ExpectedId; found $actualId."
    }
    if ([string]$Manifest.version -cne $ExpectedVersion) {
        throw "$Label VSIX version mismatch. Expected $ExpectedVersion; found $($Manifest.version)."
    }
}

function Convert-ExpectedExtensionVersions {
    param([string[]]$Entries)

    $versions = @{}
    foreach ($entry in $Entries) {
        if ([string]$entry -notmatch '^([^@\s]+)@([^@\s]+)$') {
            throw "Expected prerequisite extension must use id@version: $entry"
        }
        $id = $Matches[1].ToLowerInvariant()
        if ($id -in @('github.copilot-chat', 'collaborare.collaborare')) {
            throw "Expected prerequisite extension uses a reserved root extension ID: $($Matches[1])"
        }
        if ($versions.ContainsKey($id)) {
            throw "Duplicate expected prerequisite extension: $($Matches[1])"
        }
        $versions[$id] = $Matches[2]
    }
    return $versions
}

function Get-DeclaredExtensionIds {
    param(
        [Parameter(Mandatory = $true)][object]$Manifest,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $ids = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    foreach ($propertyName in @('extensionDependencies', 'extensionPack')) {
        if ($Manifest.PSObject.Properties.Name -notcontains $propertyName) {
            continue
        }
        foreach ($dependencyValue in @($Manifest.$propertyName)) {
            if ($dependencyValue -isnot [string] -or
                [string]::IsNullOrWhiteSpace($dependencyValue) -or
                $dependencyValue -notmatch '^[^@\s.]+\.[^@\s]+$') {
                throw "$Label has an invalid ${propertyName} extension ID."
            }
            $dependencyId = $dependencyValue.ToLowerInvariant()
            if (-not $seen.ContainsKey($dependencyId)) {
                $seen[$dependencyId] = $true
                $ids.Add($dependencyId)
            }
        }
    }
    return @($ids)
}

if (-not (Test-Path -LiteralPath $VsixPath -PathType Leaf)) {
    throw "VSIX file does not exist: $VsixPath"
}

$vsix = (Resolve-Path -LiteralPath $VsixPath).ProviderPath
$collaborareMetadata = Read-VsixMetadata -Path $vsix -Label 'Collaborare'
$collaborareManifest = $collaborareMetadata.PackageManifest
Assert-VsixIdentity -Manifest $collaborareManifest `
    -ExpectedId 'collaborare.collaborare' `
    -ExpectedVersion $ExpectedCollaborareVersion `
    -Label 'Collaborare'
Assert-VsixContainerIdentity -Metadata $collaborareMetadata `
    -ExpectedName 'collaborare' `
    -ExpectedPublisher 'collaborare' `
    -ExpectedVersion $ExpectedCollaborareVersion `
    -Label 'Collaborare'
foreach ($forbiddenProperty in @('extensionPack', 'extensionDependencies')) {
    if ($collaborareManifest.PSObject.Properties.Name -contains $forbiddenProperty) {
        throw "Collaborare VSIX must not declare ${forbiddenProperty}."
    }
}

$copilotManifest = $null
if ($CopilotChatVsixPath) {
    $copilotMetadata = Read-VsixMetadata -Path $CopilotChatVsixPath -Label 'GitHub Copilot Chat'
    $copilotManifest = $copilotMetadata.PackageManifest
    Assert-VsixIdentity -Manifest $copilotManifest `
        -ExpectedId 'GitHub.copilot-chat' `
        -ExpectedVersion $ExpectedCopilotChatVersion `
        -Label 'GitHub Copilot Chat'
    Assert-VsixContainerIdentity -Metadata $copilotMetadata `
        -ExpectedName 'copilot-chat' `
        -ExpectedPublisher 'GitHub' `
        -ExpectedVersion $ExpectedCopilotChatVersion `
        -Label 'GitHub Copilot Chat'
}
$expectedPrerequisites = Convert-ExpectedExtensionVersions -Entries $ExpectedPrerequisiteExtension
$prerequisiteMetadataById = @{}
$prerequisitePathById = @{}
foreach ($prerequisitePath in $PrerequisiteVsixPath) {
    $metadata = Read-VsixMetadata -Path $prerequisitePath -Label 'Copilot prerequisite'
    $manifest = $metadata.PackageManifest
    $extensionId = ('{0}.{1}' -f $manifest.publisher, $manifest.name).ToLowerInvariant()
    if (-not $expectedPrerequisites.ContainsKey($extensionId)) {
        throw "Local prerequisite VSIX is not pinned with -ExpectedPrerequisiteExtension: $extensionId@$($manifest.version)"
    }
    if ($prerequisiteMetadataById.ContainsKey($extensionId)) {
        throw "Duplicate local prerequisite VSIX identity: $extensionId"
    }
    Assert-VsixIdentity -Manifest $manifest `
        -ExpectedId $extensionId `
        -ExpectedVersion $expectedPrerequisites[$extensionId] `
        -Label 'Copilot prerequisite'
    Assert-VsixContainerIdentity -Metadata $metadata `
        -ExpectedName ([string]$manifest.name) `
        -ExpectedPublisher ([string]$manifest.publisher) `
        -ExpectedVersion ([string]$manifest.version) `
        -Label 'Copilot prerequisite'
    $prerequisiteMetadataById[$extensionId] = $metadata
    $prerequisitePathById[$extensionId] = (Resolve-Path -LiteralPath $prerequisitePath).ProviderPath
}
foreach ($expectedId in $expectedPrerequisites.Keys) {
    if (-not $prerequisiteMetadataById.ContainsKey($expectedId)) {
        throw "No approved local VSIX was provided for prerequisite ${expectedId}@$($expectedPrerequisites[$expectedId])."
    }
}

$manifestsById = @{ 'github.copilot-chat' = $copilotManifest }
foreach ($extensionId in $prerequisiteMetadataById.Keys) {
    $manifestsById[$extensionId] = $prerequisiteMetadataById[$extensionId].PackageManifest
}
$visitState = @{}
$prerequisiteInstallOrder = New-Object System.Collections.Generic.List[string]
function Visit-ExtensionDependency {
    param([Parameter(Mandatory = $true)][string]$ExtensionId)

    if ($visitState[$ExtensionId] -eq 'visiting') {
        throw "Copilot prerequisite dependency cycle detected at $ExtensionId."
    }
    if ($visitState[$ExtensionId] -eq 'visited') {
        return
    }
    $visitState[$ExtensionId] = 'visiting'
    foreach ($dependencyId in Get-DeclaredExtensionIds `
        -Manifest $manifestsById[$ExtensionId] `
        -Label $ExtensionId) {
        if (-not $expectedPrerequisites.ContainsKey($dependencyId)) {
            throw "Pin the Copilot prerequisite before installation with -ExpectedPrerequisiteExtension '${dependencyId}@<version>'."
        }
        if (-not $manifestsById.ContainsKey($dependencyId)) {
            throw "No approved local VSIX was provided for prerequisite ${dependencyId}@$($expectedPrerequisites[$dependencyId])."
        }
        Visit-ExtensionDependency -ExtensionId $dependencyId
    }
    $visitState[$ExtensionId] = 'visited'
    if ($ExtensionId -ne 'github.copilot-chat') {
        $prerequisiteInstallOrder.Add($ExtensionId)
    }
}
Visit-ExtensionDependency -ExtensionId 'github.copilot-chat'
foreach ($expectedId in $expectedPrerequisites.Keys) {
    if ($visitState[$expectedId] -ne 'visited') {
        throw "Pinned prerequisite is not in the GitHub Copilot Chat dependency closure: $expectedId"
    }
}

$code = Get-Command $CodeCommand -ErrorAction SilentlyContinue
$codePath = $null
if ($code) {
    $codePath = $code.Source
}
if (-not $codePath -and $CodeCommand -eq 'code') {
    $codeCandidates = @()
    foreach ($basePath in @(${env:LOCALAPPDATA}, ${env:ProgramFiles}, ${env:ProgramFiles(x86)})) {
        if ($basePath) {
            $relativePath = if ($basePath -eq ${env:LOCALAPPDATA}) {
                'Programs\Microsoft VS Code\bin\code.cmd'
            }
            else {
                'Microsoft VS Code\bin\code.cmd'
            }
            $candidate = Join-Path $basePath $relativePath
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $codeCandidates += $candidate
            }
        }
    }
    $codePath = $codeCandidates | Select-Object -First 1
}
if (-not $codePath) {
    throw "VS Code CLI was not found: $CodeCommand. In VS Code, install the VSIX manually with Extensions: Install from VSIX."
}

$cliWorkingDirectory = $null
foreach ($candidate in @(${env:TEMP}, ${env:SystemRoot})) {
    if ($candidate -and -not $candidate.StartsWith('\\') -and (Test-Path -LiteralPath $candidate -PathType Container)) {
        $cliWorkingDirectory = $candidate
        break
    }
}
if (-not $cliWorkingDirectory) {
    $cliWorkingDirectory = (Get-Location).ProviderPath
    if ($cliWorkingDirectory.StartsWith('\\')) {
        throw 'VS Code CLI cannot be invoked from a UNC current directory without a local TEMP or SystemRoot directory.'
    }
}

function Invoke-CodeCli {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    Push-Location -LiteralPath $cliWorkingDirectory
    try {
        $output = @(& $codePath @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = @($output | ForEach-Object { [string]$_ })
    }
}

$codeVersionResult = Invoke-CodeCli -Arguments @('--version')
if ($codeVersionResult.ExitCode -ne 0) {
    throw "Could not determine the VS Code version: $($codeVersionResult.Output -join ' ')"
}
$codeVersionMatches = @($codeVersionResult.Output |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -match '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$' })
if ($codeVersionMatches.Count -ne 1) {
    throw "VS Code did not report one unambiguous version: $($codeVersionResult.Output -join ' ')"
}
$codeVersionText = $codeVersionMatches[0]
try {
    $codeVersion = [version]($codeVersionText -replace '[-+].*$', '')
}
catch {
    throw "VS Code reported an invalid version: $codeVersionText"
}
if ($codeVersion -lt [version]'1.97.0') {
    throw "VS Code 1.97.0 or newer is required for dependency-isolated local VSIX installation; found $codeVersionText."
}
if ($codeVersionText -cne $ExpectedCodeVersion) {
    throw "VS Code version mismatch. Expected $ExpectedCodeVersion; found $codeVersionText."
}

function Get-InstalledExtensionVersions {
    $result = Invoke-CodeCli -Arguments @('--list-extensions', '--show-versions')
    if ($result.ExitCode -ne 0) {
        throw "Could not query installed VS Code extensions: $($result.Output -join ' ')"
    }

    $versions = @{}
    foreach ($line in $result.Output) {
        if ($line.Trim() -match '^([^@\s]+)@([^@\s]+)$') {
            $versions[$Matches[1].ToLowerInvariant()] = $Matches[2]
        }
    }
    return $versions
}

function Assert-InstalledExtensionVersions {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Installed,
        [Parameter(Mandatory = $true)][hashtable]$Expected
    )

    foreach ($id in $Expected.Keys) {
        if (-not $Installed.ContainsKey($id)) {
            throw "Required offline extension is not installed: ${id}@$($Expected[$id])"
        }
        if ($Installed[$id] -cne $Expected[$id]) {
            throw "Offline extension version mismatch. Expected ${id}@$($Expected[$id]); found ${id}@$($Installed[$id])."
        }
    }
}

function Install-LocalVsix {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $resolvedPath = (Resolve-Path -LiteralPath $Path).ProviderPath
    $arguments = @(
        '--install-extension',
        $resolvedPath,
        '--do-not-include-pack-dependencies',
        '--do-not-sync'
    )
    if ($Force) {
        $arguments += '--force'
    }
    $result = Invoke-CodeCli -Arguments $arguments
    if ($result.ExitCode -ne 0) {
        throw "$Label VSIX installation failed with exit code $($result.ExitCode): $($result.Output -join ' ')"
    }
}

$installedBefore = Get-InstalledExtensionVersions
$allowedChangedExtensions = @{
    'github.copilot-chat' = $true
    'collaborare.collaborare' = $true
}
foreach ($expectedId in $expectedPrerequisites.Keys) {
    $allowedChangedExtensions[$expectedId] = $true
}
function Assert-NoUnexpectedExtensionChanges {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Before,
        [Parameter(Mandatory = $true)][hashtable]$After,
        [Parameter(Mandatory = $true)][hashtable]$Allowed
    )

    foreach ($id in $After.Keys) {
        if ($Allowed.ContainsKey($id)) {
            continue
        }
        if (-not $Before.ContainsKey($id)) {
            throw "Local VSIX installation added an unapproved extension: $id@$($After[$id])"
        }
        if ($After[$id] -cne $Before[$id]) {
            throw "Local VSIX installation changed an unapproved extension: $id@$($Before[$id]) -> $id@$($After[$id])"
        }
    }
    foreach ($id in $Before.Keys) {
        if (-not $Allowed.ContainsKey($id) -and -not $After.ContainsKey($id)) {
            throw "Local VSIX installation removed an unapproved extension: $id@$($Before[$id])"
        }
    }
}

foreach ($prerequisiteId in $prerequisiteInstallOrder) {
    Install-LocalVsix `
        -Path $prerequisitePathById[$prerequisiteId] `
        -Label "Copilot prerequisite $prerequisiteId"
}
if ($CopilotChatVsixPath) {
    Install-LocalVsix -Path $CopilotChatVsixPath -Label 'GitHub Copilot Chat'
}

$installedExtensions = Get-InstalledExtensionVersions
Assert-NoUnexpectedExtensionChanges `
    -Before $installedBefore `
    -After $installedExtensions `
    -Allowed $allowedChangedExtensions
Assert-InstalledExtensionVersions -Installed $installedExtensions -Expected $expectedPrerequisites
$copilotId = 'github.copilot-chat'
if (-not $installedExtensions.ContainsKey($copilotId)) {
    throw 'GitHub Copilot Chat is not installed. Preinstall its approved offline VSIX and prerequisites, or pass -CopilotChatVsixPath.'
}
if ($installedExtensions[$copilotId] -cne $ExpectedCopilotChatVersion) {
    throw "GitHub Copilot Chat version mismatch. Expected ${copilotId}@${ExpectedCopilotChatVersion}; found ${copilotId}@$($installedExtensions[$copilotId])."
}

Install-LocalVsix -Path $vsix -Label 'Collaborare'

if ($ProjectPath) {
    $initializer = Join-Path $PSScriptRoot 'Initialize-Project.ps1'
    & $initializer -ProjectPath $ProjectPath
}

$installedExtensions = Get-InstalledExtensionVersions
Assert-NoUnexpectedExtensionChanges `
    -Before $installedBefore `
    -After $installedExtensions `
    -Allowed $allowedChangedExtensions
$collaborareId = 'collaborare.collaborare'
$expectedFinalExtensions = @{
    'github.copilot-chat' = $ExpectedCopilotChatVersion
    'collaborare.collaborare' = $ExpectedCollaborareVersion
}
foreach ($expectedId in $expectedPrerequisites.Keys) {
    $expectedFinalExtensions[$expectedId] = $expectedPrerequisites[$expectedId]
}
Assert-InstalledExtensionVersions -Installed $installedExtensions -Expected $expectedFinalExtensions

Write-Host "Installed: ${collaborareId}@${ExpectedCollaborareVersion}"
Write-Host "VS Code: $codeVersionText"
Write-Host "Copilot Chat: ${copilotId}@${ExpectedCopilotChatVersion}"
Write-Host 'Restart VS Code, then run: Collaborare: Configure Copilot Account Name'
Write-Host 'Use @collaborare for conversations that must read and write shared knowledge.'
