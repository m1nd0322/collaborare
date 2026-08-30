#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,

    [switch]$CreateProject
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
    if (-not $CreateProject) {
        throw "Project directory does not exist: $ProjectPath"
    }
    New-Item -ItemType Directory -Path $ProjectPath -Force | Out-Null
}

$project = (Resolve-Path -LiteralPath $ProjectPath).ProviderPath
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
New-Item -ItemType Directory -Path $conversations -Force | Out-Null

$probe = Join-Path $conversations ('.collaborare-write-test-{0}.tmp' -f [guid]::NewGuid())
try {
    [System.IO.File]::WriteAllText($probe, 'write-test', [System.Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $probe -Force
}
catch {
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    throw "Knowledge database is not writable: $conversations. $($_.Exception.Message)"
}

Write-Host "Collaborare project initialized: $project"
Write-Host "Knowledge conversations: $conversations"
