#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,

    [switch]$CreateProject
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function New-LiteralHardLink {
    param(
        [Parameter(Mandatory = $true)][string]$LinkPath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )

    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
        if (-not ('Collaborare.NativeMethods' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Collaborare
{
    public static class NativeMethods
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateHardLink(
            string fileName,
            string existingFileName,
            IntPtr securityAttributes);
    }
}
'@
        }
        if (-not [Collaborare.NativeMethods]::CreateHardLink(
            $LinkPath,
            $TargetPath,
            [System.IntPtr]::Zero
        )) {
            $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw [System.ComponentModel.Win32Exception]::new($errorCode)
        }
        return
    }

    $linkDirectory = Split-Path -Parent $LinkPath
    $targetDirectory = Split-Path -Parent $TargetPath
    if ($linkDirectory -ne $targetDirectory) {
        throw 'The publication probe hard links must use the same directory.'
    }
    Push-Location -LiteralPath $linkDirectory
    try {
        New-Item `
            -ItemType HardLink `
            -Path '.' `
            -Name (Split-Path -Leaf $LinkPath) `
            -Target (Split-Path -Leaf $TargetPath) | Out-Null
    }
    finally {
        Pop-Location
    }
}

$requestedProjectPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ProjectPath)
if (-not (Test-Path -LiteralPath $requestedProjectPath -PathType Container)) {
    if (-not $CreateProject) {
        throw "Project directory does not exist: $ProjectPath"
    }
    [void][System.IO.Directory]::CreateDirectory($requestedProjectPath)
}

$projectItem = Get-Item -LiteralPath $requestedProjectPath -Force
if (($projectItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Project directory cannot be a symbolic link or junction: $ProjectPath"
}
$project = (Resolve-Path -LiteralPath $requestedProjectPath).ProviderPath
$knowledgeRoot = Join-Path $project 'knowledge-database'
if (Test-Path -LiteralPath $knowledgeRoot) {
    $knowledgeItem = Get-Item -LiteralPath $knowledgeRoot -Force
    if (($knowledgeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Knowledge database cannot be a symbolic link or junction: $knowledgeRoot"
    }
}

$conversations = Join-Path $knowledgeRoot 'conversations'
if (Test-Path -LiteralPath $conversations) {
    $conversationItem = Get-Item -LiteralPath $conversations -Force
    if (($conversationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Conversations directory cannot be a symbolic link or junction: $conversations"
    }
}
[void][System.IO.Directory]::CreateDirectory($conversations)

$probeId = [guid]::NewGuid()
$probeDirectory = Join-Path $conversations ('.collaborare-write-test-{0}' -f $probeId)
$tempProbe = Join-Path $probeDirectory ('.conversation.md.{0}.{1}.tmp' -f $PID, $probeId)
$finalProbe = Join-Path $probeDirectory 'conversation.md'
try {
    [void][System.IO.Directory]::CreateDirectory($probeDirectory)
    [System.IO.File]::WriteAllText($tempProbe, 'write-test', [System.Text.UTF8Encoding]::new($false))
    New-LiteralHardLink -LinkPath $finalProbe -TargetPath $tempProbe
    if ([System.IO.File]::ReadAllText($finalProbe) -ne 'write-test') {
        throw 'The no-clobber hard-link probe content could not be verified.'
    }
    Remove-Item -LiteralPath $tempProbe -Force
    if ([System.IO.File]::ReadAllText($finalProbe) -ne 'write-test') {
        throw 'The committed hard-link probe content could not be verified after removing its publication temp.'
    }
    Remove-Item -LiteralPath $finalProbe -Force
    Remove-Item -LiteralPath $probeDirectory -Force
}
catch {
    Remove-Item -LiteralPath $probeDirectory -Recurse -Force -ErrorAction SilentlyContinue
    throw "Knowledge database does not support the required subdirectory create, file create, hard-link publish, read, publication-temp unlink, and cleanup operations: $conversations. $($_.Exception.Message)"
}

Write-Host "Collaborare project initialized: $project"
Write-Host "Knowledge conversations: $conversations"
