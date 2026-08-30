#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,

    [ValidateRange(1, 65535)]
    [int]$Port = 43110,

    [ValidateRange(250, 3600000)]
    [int]$Interval = 2000,

    [string]$HostAddress = '127.0.0.1',

    [string]$NodeCommand = 'node',

    [string]$ChromePath,

    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
    throw "Project directory does not exist: $ProjectPath"
}

$node = Get-Command $NodeCommand -ErrorAction SilentlyContinue
if (-not $node) {
    throw "Node.js was not found: $NodeCommand. Install Node.js 18 or newer."
}

$majorVersion = [int]((& $node.Source '--version').TrimStart('v').Split('.')[0])
if ($majorVersion -lt 18) {
    throw "Node.js 18 or newer is required; found version $majorVersion."
}

$project = (Resolve-Path -LiteralPath $ProjectPath).ProviderPath
$server = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\dashboard\server.js')).ProviderPath
$browserHost = if ($HostAddress -in @('0.0.0.0', '::')) { '127.0.0.1' } else { $HostAddress }
$urlHost = if ($browserHost.Contains(':') -and -not $browserHost.StartsWith('[')) { "[$browserHost]" } else { $browserHost }
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
    try {
        $browserJob = Start-Job -ScriptBlock {
            param($DashboardUrl, $BrowserExecutable)
            for ($attempt = 0; $attempt -lt 60; $attempt++) {
                try {
                    Invoke-WebRequest -Uri "$DashboardUrl/api/health" -UseBasicParsing -TimeoutSec 1 | Out-Null
                    if ($BrowserExecutable) {
                        Start-Process -FilePath $BrowserExecutable -ArgumentList $DashboardUrl
                    }
                    else {
                        Start-Process $DashboardUrl
                    }
                    return
                }
                catch {
                    Start-Sleep -Milliseconds 500
                }
            }
        } -ArgumentList $url, $chromeExecutable
        if (-not $chromeExecutable) {
            Write-Warning 'Chrome was not found in a standard location. The Windows default browser will be used.'
        }
    }
    catch {
        Write-Warning "Could not schedule the browser launch. Open $url manually."
    }
}

Write-Host "Starting Collaborare dashboard: $url"
Write-Host "Project: $project"

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
