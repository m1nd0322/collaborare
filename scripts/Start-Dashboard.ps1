#Requires -Version 5.1

[CmdletBinding(DefaultParameterSetName = 'Browser')]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,

    [ValidateRange(1, 65535)]
    [int]$Port = 43110,

    [ValidateRange(250, 3600000)]
    [int]$Interval = 2000,

    [ValidateSet('127.0.0.1', '::1')]
    [string]$HostAddress = '127.0.0.1',

    [string]$NodeCommand = 'node',

    [Parameter(ParameterSetName = 'Browser')]
    [string]$ChromePath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedNodeVersion,

    [Parameter(Mandatory = $true, ParameterSetName = 'Browser')]
    [string]$ExpectedChromeVersion,

    [Parameter(Mandatory = $true, ParameterSetName = 'NoBrowser')]
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $NoBrowser -and [string]::IsNullOrWhiteSpace($ExpectedChromeVersion)) {
    throw 'ExpectedChromeVersion is required unless -NoBrowser is enabled.'
}

if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
    throw "Project directory does not exist: $ProjectPath"
}

$node = Get-Command $NodeCommand -ErrorAction SilentlyContinue
if (-not $node) {
    throw "Node.js was not found: $NodeCommand. Install an approved Node.js 22 or newer release."
}

$nodeVersion = (& $node.Source '--version').Trim()
$majorVersion = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($majorVersion -lt 22) {
    throw "Node.js 22 or newer is required; found $nodeVersion."
}
if ($ExpectedNodeVersion -and $nodeVersion.TrimStart('v') -cne $ExpectedNodeVersion.TrimStart('v')) {
    throw "Node.js version mismatch. Expected $ExpectedNodeVersion, found $nodeVersion."
}

$project = (Resolve-Path -LiteralPath $ProjectPath).ProviderPath
$server = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\dashboard\server.js')).ProviderPath
$urlHost = if ($HostAddress.Contains(':') -and -not $HostAddress.StartsWith('[')) { "[$HostAddress]" } else { $HostAddress }
$url = "http://${urlHost}:$Port"
$browserJob = $null
$chromeExecutable = $null

if (-not $NoBrowser) {
    if ($ChromePath) {
        if (-not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) {
            throw "Chrome executable does not exist: $ChromePath"
        }
        $chromeExecutable = (Resolve-Path -LiteralPath $ChromePath).ProviderPath
    }
    else {
        $chromeCandidates = @()
        foreach ($basePath in @(${env:ProgramFiles}, ${env:ProgramFiles(x86)}, ${env:LOCALAPPDATA})) {
            if ($basePath) {
                $candidate = Join-Path $basePath 'Google\Chrome\Application\chrome.exe'
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    $chromeCandidates += $candidate
                }
            }
        }
        $chromeExecutable = $chromeCandidates | Select-Object -First 1
    }
}

if (-not $NoBrowser) {
    if (-not $chromeExecutable) {
        throw 'Google Chrome was not found. Install the approved offline Chrome build, pass -ChromePath, or use -NoBrowser to start only the server.'
    }
    $chromeVersion = (Get-Item -LiteralPath $chromeExecutable).VersionInfo.ProductVersion
    if (-not $chromeVersion) {
        throw "Could not determine the Chrome version: $chromeExecutable"
    }
    if ($chromeVersion -cne $ExpectedChromeVersion) {
        throw "Chrome version mismatch. Expected $ExpectedChromeVersion, found $chromeVersion."
    }
    try {
        $browserJob = Start-Job -ScriptBlock {
            param($DashboardUrl, $BrowserExecutable)
            for ($attempt = 0; $attempt -lt 60; $attempt++) {
                try {
                    Invoke-WebRequest -Uri "$DashboardUrl/api/health" -UseBasicParsing -TimeoutSec 1 | Out-Null
                    Start-Process -FilePath $BrowserExecutable -ArgumentList $DashboardUrl
                    return
                }
                catch {
                    Start-Sleep -Milliseconds 500
                }
            }
        } -ArgumentList $url, $chromeExecutable
    }
    catch {
        Write-Warning "Could not schedule the browser launch. Open $url manually."
    }
}

Write-Host "Starting Collaborare dashboard: $url"
Write-Host "Project: $project"
Write-Host "Node.js: $nodeVersion"
if ($chromeExecutable) {
    Write-Host "Chrome: $chromeVersion"
}

try {
    & $node.Source $server '--project' $project '--host' $HostAddress '--port' $Port '--interval' $Interval
    if ($LASTEXITCODE -ne 0) {
        throw "Dashboard exited with code $LASTEXITCODE."
    }
}
finally {
    if ($browserJob) {
        Stop-Job -Job $browserJob -ErrorAction SilentlyContinue
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
}
