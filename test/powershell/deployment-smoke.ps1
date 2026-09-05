#Requires -Version 5.1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Throws {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Pattern
    )

    $caught = $null
    try {
        & $Action
    }
    catch {
        $caught = $_
    }
    if (-not $caught) {
        throw "Expected an error matching: $Pattern"
    }
    if ($caught.Exception.Message -notmatch $Pattern) {
        throw "Unexpected error. Expected '$Pattern'; found '$($caught.Exception.Message)'."
    }
}

function Write-Utf8WithoutBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Contents
    )
    [System.IO.File]::WriteAllText($Path, $Contents, [System.Text.UTF8Encoding]::new($false))
}

function Add-TestVsixEntries {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string[]]$EntryNames
    )

    Copy-Item -LiteralPath $Source -Destination $Destination
    $archive = [System.IO.Compression.ZipFile]::Open(
        $Destination,
        [System.IO.Compression.ZipArchiveMode]::Update
    )
    try {
        foreach ($entryName in $EntryNames) {
            $entry = $archive.CreateEntry($entryName)
            $writer = [System.IO.StreamWriter]::new($entry.Open())
            try {
                $writer.Write('test')
            }
            finally {
                $writer.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Add-TestVsixEntryWithAttributes {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$EntryName,
        [Parameter(Mandatory = $true)][int]$ExternalAttributes
    )

    Copy-Item -LiteralPath $Source -Destination $Destination
    $archive = [System.IO.Compression.ZipFile]::Open(
        $Destination,
        [System.IO.Compression.ZipArchiveMode]::Update
    )
    try {
        $entry = $archive.CreateEntry($EntryName)
        $entry.ExternalAttributes = $ExternalAttributes
        $writer = [System.IO.StreamWriter]::new($entry.Open())
        try {
            $writer.Write('link-target')
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $archive.Dispose()
    }
}

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).ProviderPath
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('collaborare-deployment-test-{0}' -f [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

try {
    $runningOnWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
    $projectPath = Join-Path $temporaryRoot 'project'
    New-Item -ItemType Directory -Path $projectPath | Out-Null
    & (Join-Path $repositoryRoot 'scripts/Initialize-Project.ps1') -ProjectPath $projectPath
    $conversationsPath = Join-Path $projectPath 'knowledge-database/conversations'
    Assert-True -Condition (Test-Path -LiteralPath $conversationsPath -PathType Container) -Message 'Project initialization did not create the conversations directory.'
    Assert-True -Condition (@(Get-ChildItem -LiteralPath $conversationsPath -Force).Count -eq 0) -Message 'Project initialization left probe files behind.'

    $bracketProjectPath = Join-Path $temporaryRoot 'project-[x]'
    & (Join-Path $repositoryRoot 'scripts/Initialize-Project.ps1') -ProjectPath $bracketProjectPath -CreateProject
    $bracketConversationsPath = Join-Path $bracketProjectPath 'knowledge-database/conversations'
    Assert-True -Condition (Test-Path -LiteralPath $bracketConversationsPath -PathType Container) -Message 'Project initialization failed for a literal bracket path.'
    Assert-True -Condition (@(Get-ChildItem -LiteralPath $bracketConversationsPath -Force).Count -eq 0) -Message 'Bracket-path initialization left probe files behind.'

    $relativeProviderRoot = Join-Path $temporaryRoot 'provider-location'
    $relativeProcessRoot = Join-Path $temporaryRoot 'process-location'
    [void][System.IO.Directory]::CreateDirectory($relativeProviderRoot)
    [void][System.IO.Directory]::CreateDirectory($relativeProcessRoot)
    $originalProcessDirectory = [System.Environment]::CurrentDirectory
    Push-Location -LiteralPath $relativeProviderRoot
    try {
        [System.Environment]::CurrentDirectory = $relativeProcessRoot
        & (Join-Path $repositoryRoot 'scripts/Initialize-Project.ps1') `
            -ProjectPath 'relative-project-[x]' `
            -CreateProject
    }
    finally {
        [System.Environment]::CurrentDirectory = $originalProcessDirectory
        Pop-Location
    }
    Assert-True `
        -Condition (Test-Path -LiteralPath (Join-Path $relativeProviderRoot 'relative-project-[x]') -PathType Container) `
        -Message 'Relative project initialization did not use the PowerShell provider location.'
    Assert-True `
        -Condition (-not (Test-Path -LiteralPath (Join-Path $relativeProcessRoot 'relative-project-[x]'))) `
        -Message 'Relative project initialization incorrectly used the process working directory.'

    $linkedProjectTarget = Join-Path $temporaryRoot 'linked-project-target'
    $linkedProjectPath = Join-Path $temporaryRoot 'linked-project'
    New-Item -ItemType Directory -Path $linkedProjectTarget | Out-Null
    $linkedProjectType = if ($runningOnWindows) { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $linkedProjectType -Path $linkedProjectPath -Target $linkedProjectTarget -ErrorAction Stop | Out-Null
    Assert-Throws -Pattern 'Project directory cannot be a symbolic link or junction' -Action {
        & (Join-Path $repositoryRoot 'scripts/Initialize-Project.ps1') -ProjectPath $linkedProjectPath
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $copilotSource = Join-Path $temporaryRoot 'copilot-source'
    $copilotExtension = Join-Path $copilotSource 'extension'
    New-Item -ItemType Directory -Path $copilotExtension -Force | Out-Null
    $copilotPackage = @{
        name = 'copilot-chat'
        publisher = 'GitHub'
        version = '9.9.9'
        extensionDependencies = @('GitHub.copilot')
    } | ConvertTo-Json -Compress
    Write-Utf8WithoutBom -Path (Join-Path $copilotExtension 'package.json') -Contents $copilotPackage
    $copilotVsixManifest = @'
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="copilot-chat" Version="9.9.9" Publisher="GitHub" />
  </Metadata>
</PackageManifest>
'@
    Write-Utf8WithoutBom -Path (Join-Path $copilotSource 'extension.vsixmanifest') -Contents $copilotVsixManifest
    $contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="json" ContentType="application/json" />
</Types>
'@
    Write-Utf8WithoutBom -Path (Join-Path $copilotSource '[Content_Types].xml') -Contents $contentTypes
    $copilotVsix = Join-Path $temporaryRoot 'github.copilot-chat-9.9.9.vsix'
    [System.IO.Compression.ZipFile]::CreateFromDirectory($copilotSource, $copilotVsix)

    $prerequisiteSource = Join-Path $temporaryRoot 'copilot-prerequisite-source'
    $prerequisiteExtension = Join-Path $prerequisiteSource 'extension'
    New-Item -ItemType Directory -Path $prerequisiteExtension -Force | Out-Null
    $prerequisitePackage = @{
        name = 'copilot'
        publisher = 'GitHub'
        version = '1.2.3'
    } | ConvertTo-Json -Compress
    Write-Utf8WithoutBom -Path (Join-Path $prerequisiteExtension 'package.json') -Contents $prerequisitePackage
    $prerequisiteVsixManifest = @'
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="copilot" Version="1.2.3" Publisher="GitHub" />
  </Metadata>
</PackageManifest>
'@
    Write-Utf8WithoutBom -Path (Join-Path $prerequisiteSource 'extension.vsixmanifest') -Contents $prerequisiteVsixManifest
    Copy-Item -LiteralPath (Join-Path $copilotSource '[Content_Types].xml') -Destination $prerequisiteSource
    $prerequisiteVsix = Join-Path $temporaryRoot 'github.copilot-1.2.3.vsix'
    [System.IO.Compression.ZipFile]::CreateFromDirectory($prerequisiteSource, $prerequisiteVsix)
    $casePrerequisiteSource = Join-Path $temporaryRoot 'case-prerequisite-source'
    $casePrerequisiteExtension = Join-Path $casePrerequisiteSource 'extension'
    New-Item -ItemType Directory -Path $casePrerequisiteExtension -Force | Out-Null
    $casePrerequisitePackage = @{
        name = 'copilot'
        publisher = 'GitHub'
        version = '1.2.3-RC.1'
    } | ConvertTo-Json -Compress
    Write-Utf8WithoutBom -Path (Join-Path $casePrerequisiteExtension 'package.json') -Contents $casePrerequisitePackage
    $casePrerequisiteVsixManifest = @'
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="copilot" Version="1.2.3-RC.1" Publisher="GitHub" />
  </Metadata>
</PackageManifest>
'@
    Write-Utf8WithoutBom -Path (Join-Path $casePrerequisiteSource 'extension.vsixmanifest') -Contents $casePrerequisiteVsixManifest
    Copy-Item -LiteralPath (Join-Path $copilotSource '[Content_Types].xml') -Destination $casePrerequisiteSource
    $casePrerequisiteVsix = Join-Path $temporaryRoot 'github.copilot-1.2.3-RC.1.vsix'
    [System.IO.Compression.ZipFile]::CreateFromDirectory($casePrerequisiteSource, $casePrerequisiteVsix)
    $transitivePrerequisitePackage = @{
        name = 'copilot'
        publisher = 'GitHub'
        version = '1.2.3'
        extensionDependencies = @('GitHub.copilot-base')
    } | ConvertTo-Json -Compress
    Write-Utf8WithoutBom `
        -Path (Join-Path $prerequisiteExtension 'package.json') `
        -Contents $transitivePrerequisitePackage
    $transitivePrerequisiteVsix = Join-Path $temporaryRoot 'github.copilot-with-transitive-1.2.3.vsix'
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $prerequisiteSource,
        $transitivePrerequisiteVsix
    )

    $unsafeCopilotVsix = Join-Path $temporaryRoot 'unsafe-copilot.vsix'
    Copy-Item -LiteralPath $copilotVsix -Destination $unsafeCopilotVsix
    $unsafeArchive = [System.IO.Compression.ZipFile]::Open(
        $unsafeCopilotVsix,
        [System.IO.Compression.ZipArchiveMode]::Update
    )
    try {
        $unsafeEntry = $unsafeArchive.CreateEntry('../escape.txt')
        $unsafeWriter = [System.IO.StreamWriter]::new($unsafeEntry.Open())
        try {
            $unsafeWriter.Write('escape')
        }
        finally {
            $unsafeWriter.Dispose()
        }
    }
    finally {
        $unsafeArchive.Dispose()
    }
    . (Join-Path $repositoryRoot 'scripts/Vsix-Validation.ps1')
    Assert-Throws -Pattern 'unsafe archive path' -Action {
        Read-VsixMetadata -Path $unsafeCopilotVsix -Label 'Unsafe test'
    }

    $windowsUnsafeNames = @(
        'extension/bad<name.txt',
        'extension/bad>name.txt',
        'extension/bad"name.txt',
        'extension/bad|name.txt',
        'extension/bad?name.txt',
        'extension/bad*name.txt'
    )
    for ($index = 0; $index -lt $windowsUnsafeNames.Count; $index += 1) {
        $unsafeNameVsix = Join-Path $temporaryRoot "unsafe-windows-name-$index.vsix"
        Add-TestVsixEntries `
            -Source $copilotVsix `
            -Destination $unsafeNameVsix `
            -EntryNames @($windowsUnsafeNames[$index])
        Assert-Throws -Pattern 'Windows-unsafe archive path' -Action {
            Read-VsixMetadata -Path $unsafeNameVsix -Label 'Unsafe Windows name test'
        }
    }

    $reservedNameVsix = Join-Path $temporaryRoot 'unsafe-superscript-device.vsix'
    Add-TestVsixEntries `
        -Source $copilotVsix `
        -Destination $reservedNameVsix `
        -EntryNames @(('extension/COM{0}.txt' -f [char]0x00B9))
    Assert-Throws -Pattern 'reserved Windows archive path' -Action {
        Read-VsixMetadata -Path $reservedNameVsix -Label 'Reserved Windows name test'
    }

    $prefixCollisionVsix = Join-Path $temporaryRoot 'unsafe-prefix-collision.vsix'
    Add-TestVsixEntries `
        -Source $copilotVsix `
        -Destination $prefixCollisionVsix `
        -EntryNames @('extension/collision', 'extension/collision/child.txt')
    Assert-Throws -Pattern 'file and directory archive path collision' -Action {
        Read-VsixMetadata -Path $prefixCollisionVsix -Label 'Prefix collision test'
    }

    $longComponentVsix = Join-Path $temporaryRoot 'unsafe-long-component.vsix'
    $longComponent = ('a' * 256) -join ''
    Add-TestVsixEntries `
        -Source $copilotVsix `
        -Destination $longComponentVsix `
        -EntryNames @("extension/$longComponent.txt")
    Assert-Throws -Pattern 'component exceeds the Windows limit' -Action {
        Read-VsixMetadata -Path $longComponentVsix -Label 'Long component test'
    }

    $shortAliasVsix = Join-Path $temporaryRoot 'unsafe-short-alias.vsix'
    Add-TestVsixEntries `
        -Source $copilotVsix `
        -Destination $shortAliasVsix `
        -EntryNames @('extension/PACKAG~1.JSO')
    Assert-Throws -Pattern 'DOS 8.3-style archive path' -Action {
        Read-VsixMetadata -Path $shortAliasVsix -Label 'Short alias test'
    }

    $unixLinkVsix = Join-Path $temporaryRoot 'unsafe-unix-link.vsix'
    Add-TestVsixEntryWithAttributes `
        -Source $copilotVsix `
        -Destination $unixLinkVsix `
        -EntryName 'extension/unix-link' `
        -ExternalAttributes -1610612736
    Assert-Throws -Pattern 'symbolic-link entry' -Action {
        Read-VsixMetadata -Path $unixLinkVsix -Label 'Unix link test'
    }

    $windowsReparseVsix = Join-Path $temporaryRoot 'unsafe-windows-reparse.vsix'
    Add-TestVsixEntryWithAttributes `
        -Source $copilotVsix `
        -Destination $windowsReparseVsix `
        -EntryName 'extension/windows-reparse' `
        -ExternalAttributes ([int][System.IO.FileAttributes]::ReparsePoint)
    Assert-Throws -Pattern 'symbolic-link entry' -Action {
        Read-VsixMetadata -Path $windowsReparseVsix -Label 'Windows reparse test'
    }

    $statePath = Join-Path $temporaryRoot 'extensions.txt'
    Write-Utf8WithoutBom -Path $statePath -Contents "`n"
    $env:FAKE_CODE_STATE = $statePath

    if ($runningOnWindows) {
        $fakeCode = Join-Path $temporaryRoot 'code.cmd'
        $fakeCodeContents = @'
@echo off
if "%~1"=="--version" (
  echo wrapper diagnostic
  echo 1.99.0
  echo commit-id
  exit /b 0
)
if "%~1"=="--list-extensions" (
  type "%FAKE_CODE_STATE%"
  exit /b 0
)
if "%~1"=="--install-extension" (
  echo %* | findstr /c:"--do-not-include-pack-dependencies" >nul
  if errorlevel 1 exit /b 3
  echo %* | findstr /c:"--do-not-sync" >nul
  if errorlevel 1 exit /b 3
  echo %~2 | findstr /i "github.copilot-1.2.3" >nul
  if not errorlevel 1 echo GitHub.copilot@1.2.3>>"%FAKE_CODE_STATE%"
  echo %~2 | findstr /i "copilot-chat" >nul
  if not errorlevel 1 echo GitHub.copilot-chat@9.9.9>>"%FAKE_CODE_STATE%"
  echo %~2 | findstr /i "collaborare-0.1.1" >nul
  if not errorlevel 1 echo collaborare.collaborare@0.1.1>>"%FAKE_CODE_STATE%"
  exit /b 0
)
exit /b 2
'@
        Write-Utf8WithoutBom -Path $fakeCode -Contents $fakeCodeContents
    }
    else {
        $fakeCode = Join-Path $temporaryRoot 'code'
        $fakeCodeContents = @'
#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "wrapper diagnostic"
  echo "1.99.0"
  echo "commit-id"
  exit 0
fi
if [ "$1" = "--list-extensions" ]; then
  cat "$FAKE_CODE_STATE"
  exit 0
fi
if [ "$1" = "--install-extension" ]; then
  case " $* " in
    *" --do-not-include-pack-dependencies "*) ;;
    *) exit 3 ;;
  esac
  case " $* " in
    *" --do-not-sync "*) ;;
    *) exit 3 ;;
  esac
  case "$2" in
    *github.copilot-1.2.3*) echo "GitHub.copilot@1.2.3" >> "$FAKE_CODE_STATE" ;;
    *copilot-chat*) echo "GitHub.copilot-chat@9.9.9" >> "$FAKE_CODE_STATE" ;;
    *collaborare-0.1.1*) echo "collaborare.collaborare@0.1.1" >> "$FAKE_CODE_STATE" ;;
  esac
  exit 0
fi
exit 2
'@
        Write-Utf8WithoutBom -Path $fakeCode -Contents $fakeCodeContents
        & chmod '+x' $fakeCode
    }

    $installScript = Join-Path $repositoryRoot 'scripts/Install-Collaborare.ps1'
    $collaborareVsix = Join-Path $repositoryRoot 'dist/collaborare-0.1.1.vsix'
    Assert-Throws -Pattern 'reserved root extension ID' -Action {
        & $installScript `
            -VsixPath $collaborareVsix `
            -CopilotChatVsixPath $copilotVsix `
            -ExpectedCodeVersion '1.99.0' `
            -ExpectedCopilotChatVersion '9.9.9' `
            -ExpectedCollaborareVersion '0.1.1' `
            -ExpectedPrerequisiteExtension 'GitHub.copilot-chat@9.9.9' `
            -PrerequisiteVsixPath $copilotVsix `
            -CodeCommand $fakeCode `
            -Force
    }
    Assert-Throws -Pattern 'Copilot prerequisite VSIX version mismatch' -Action {
        & $installScript `
            -VsixPath $collaborareVsix `
            -CopilotChatVsixPath $copilotVsix `
            -ExpectedCodeVersion '1.99.0' `
            -ExpectedCopilotChatVersion '9.9.9' `
            -ExpectedCollaborareVersion '0.1.1' `
            -ExpectedPrerequisiteExtension 'GitHub.copilot@1.2.3-rc.1' `
            -PrerequisiteVsixPath $casePrerequisiteVsix `
            -CodeCommand $fakeCode `
            -Force
    }
    & $installScript `
        -VsixPath $collaborareVsix `
        -CopilotChatVsixPath $copilotVsix `
        -ExpectedCodeVersion '1.99.0' `
        -ExpectedCopilotChatVersion '9.9.9' `
        -ExpectedCollaborareVersion '0.1.1' `
        -ExpectedPrerequisiteExtension 'GitHub.copilot@1.2.3' `
        -PrerequisiteVsixPath $prerequisiteVsix `
        -CodeCommand $fakeCode `
        -Force

    $installed = Get-Content -LiteralPath $statePath -Raw
    Assert-True -Condition ($installed -match 'GitHub\.copilot-chat@9\.9\.9') -Message 'Copilot Chat was not installed by the smoke test.'
    Assert-True -Condition ($installed -match 'GitHub\.copilot@1\.2\.3') -Message 'The Copilot prerequisite was not installed by the smoke test.'
    Assert-True -Condition ($installed -match 'collaborare\.collaborare@0\.1\.1') -Message 'Collaborare was not installed by the smoke test.'
    Assert-True `
        -Condition ($installed.IndexOf('GitHub.copilot@1.2.3') -lt $installed.IndexOf('GitHub.copilot-chat@9.9.9')) `
        -Message 'The Copilot prerequisite was not installed before GitHub Copilot Chat.'
    Assert-True `
        -Condition ($installed.IndexOf('GitHub.copilot-chat@9.9.9') -lt $installed.IndexOf('collaborare.collaborare@0.1.1')) `
        -Message 'Collaborare was installed before GitHub Copilot Chat.'

    Write-Utf8WithoutBom -Path $statePath -Contents "`n"
    Assert-Throws -Pattern 'Pin the Copilot prerequisite.*github\.copilot-base' -Action {
        & $installScript `
            -VsixPath $collaborareVsix `
            -CopilotChatVsixPath $copilotVsix `
            -ExpectedCodeVersion '1.99.0' `
            -ExpectedCopilotChatVersion '9.9.9' `
            -ExpectedCollaborareVersion '0.1.1' `
            -ExpectedPrerequisiteExtension 'GitHub.copilot@1.2.3' `
            -PrerequisiteVsixPath $transitivePrerequisiteVsix `
            -CodeCommand $fakeCode `
            -Force
    }

    Write-Utf8WithoutBom -Path $statePath -Contents "`n"
    Assert-Throws -Pattern 'approved local VSIX.*GitHub\.copilot@1\.2\.3' -Action {
        & $installScript `
            -VsixPath $collaborareVsix `
            -CopilotChatVsixPath $copilotVsix `
            -ExpectedCodeVersion '1.99.0' `
            -ExpectedCopilotChatVersion '9.9.9' `
            -ExpectedCollaborareVersion '0.1.1' `
            -ExpectedPrerequisiteExtension 'GitHub.copilot@1.2.3' `
            -CodeCommand $fakeCode `
            -Force
    }

    $artifactTest = Join-Path $repositoryRoot 'scripts/Test-VsixArtifact.ps1'
    & $artifactTest -VsixPath $collaborareVsix -SourceRoot (Join-Path $repositoryRoot 'vscode-extension')

    $bracketRepository = Join-Path $temporaryRoot 'repository-[x]'
    [void][System.IO.Directory]::CreateDirectory($bracketRepository)
    Get-ChildItem -LiteralPath $repositoryRoot -Force |
        Where-Object { $_.Name -ne '.git' } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $bracketRepository -Recurse -Force
        }
    $fakeVsce = Join-Path $temporaryRoot 'fake-vsce.ps1'
    $escapedVsix = $collaborareVsix.Replace("'", "''")
    $fakeVsceContents = @"
param([Parameter(ValueFromRemainingArguments = `$true)][string[]]`$Arguments)
if (`$Arguments.Count -eq 1 -and `$Arguments[0] -eq '--version') {
    `$global:LASTEXITCODE = 0
    '3.9.2'
    return
}
`$outIndex = [Array]::IndexOf(`$Arguments, '--out')
if (`$outIndex -lt 0 -or `$outIndex + 1 -ge `$Arguments.Count) {
    throw 'The fake vsce did not receive an output path.'
}
Copy-Item -LiteralPath '$escapedVsix' -Destination `$Arguments[`$outIndex + 1] -Force
`$global:LASTEXITCODE = 0
"@
    Write-Utf8WithoutBom -Path $fakeVsce -Contents $fakeVsceContents
    $packageScript = Join-Path $bracketRepository 'scripts/Package-Extension.ps1'
    $packageNodeVersion = (& (Get-Command 'node').Source '--version').Trim().TrimStart('v')
    & $packageScript -ExpectedNodeVersion $packageNodeVersion -VsceCommand $fakeVsce
    Assert-True `
        -Condition (Test-Path -LiteralPath (Join-Path $bracketRepository 'dist/collaborare-0.1.1.vsix') -PathType Leaf) `
        -Message 'VSIX packaging failed from a literal bracket checkout path.'

    $startDashboardScript = Join-Path $repositoryRoot 'scripts/Start-Dashboard.ps1'
    $nodeCommand = Get-Command 'node' -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $nodeVersion = (& $nodeCommand.Source '--version').Trim().TrimStart('v')
        Assert-Throws -Pattern 'ExpectedChromeVersion is required' -Action {
            & $startDashboardScript `
                -ProjectPath $projectPath `
                -NodeCommand $nodeCommand.Source `
                -ExpectedNodeVersion $nodeVersion `
                -NoBrowser:$false
        }
    }

    $manifestScript = Join-Path $repositoryRoot 'scripts/New-DeploymentManifest.ps1'
    $manifestPath = Join-Path $temporaryRoot 'deployment.txt'
    & $manifestScript `
        -RepositoryRoot $repositoryRoot `
        -ExpectedCollaborareVersion '0.1.1' `
        -ExpectedNodeVersion '22.23.2' `
        -OutputPath $manifestPath
    & $manifestScript `
        -RepositoryRoot $repositoryRoot `
        -ExpectedCollaborareVersion '0.1.1' `
        -ExpectedNodeVersion '22.23.2' `
        -OutputPath $manifestPath `
        -Verify

    Assert-Throws -Pattern 'BUILD-INFO.json does not match' -Action {
        & $manifestScript `
            -RepositoryRoot $repositoryRoot `
            -ExpectedCollaborareVersion '0.1.1' `
            -ExpectedNodeVersion '22.99.99' `
            -OutputPath $manifestPath `
            -Verify
    }

    $firstLine = Get-Content -LiteralPath $manifestPath | Select-Object -First 1
    Write-Utf8WithoutBom -Path $manifestPath -Contents "$firstLine`n"
    Assert-Throws -Pattern 'missing a required path' -Action {
        & $manifestScript `
            -RepositoryRoot $repositoryRoot `
            -ExpectedCollaborareVersion '0.1.1' `
            -ExpectedNodeVersion '22.23.2' `
            -OutputPath $manifestPath `
            -Verify
    }
    Assert-Throws -Pattern 'cannot overwrite' -Action {
        & $manifestScript `
            -RepositoryRoot $repositoryRoot `
            -ExpectedCollaborareVersion '0.1.1' `
            -ExpectedNodeVersion '22.23.2' `
            -OutputPath (Join-Path $repositoryRoot 'README.md')
    }
}
finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Deployment PowerShell smoke tests passed.'
