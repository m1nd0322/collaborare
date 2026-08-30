#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VsixPath,

    [string]$ProjectPath,

    [string]$CodeCommand = 'code',

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $VsixPath -PathType Leaf)) {
    throw "VSIX file does not exist: $VsixPath"
}

$vsix = (Resolve-Path -LiteralPath $VsixPath).ProviderPath
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

$arguments = @('--install-extension', $vsix)
if ($Force) {
    $arguments += '--force'
}

& $codePath @arguments
if ($LASTEXITCODE -ne 0) {
    throw "VS Code extension installation failed with exit code $LASTEXITCODE."
}

if ($ProjectPath) {
    $initializer = Join-Path $PSScriptRoot 'Initialize-Project.ps1'
    & $initializer -ProjectPath $ProjectPath
}

$installed = & $codePath '--list-extensions' '--show-versions' |
    Where-Object { $_ -match '^collaborare\.collaborare@' }
if (-not $installed) {
    throw 'VS Code did not report collaborare.collaborare after installation.'
}

Write-Host "Installed: $installed"
Write-Host 'Restart VS Code, then run: Collaborare: Configure Copilot Account Name'
Write-Host 'Use @collaborare for conversations that must read and write shared knowledge.'
