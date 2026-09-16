param(
    [string]$RemoteUrl = "https://github.com/PassengerDong/PassengerDong.github.io.git",
    [string]$SourceBranch = "source",
    [string]$Message = "Update blog $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    [switch]$SkipSourcePush,
    [switch]$SkipHexoDeploy,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [string[]]$Arguments = @()
    )

    $commandLine = "$File $($Arguments -join ' ')".Trim()
    Write-Host "> $commandLine" -ForegroundColor DarkGray

    if ($DryRun) {
        return
    }

    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $commandLine"
    }
}

function Get-NativeOutput {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [string[]]$Arguments = @()
    )

    $output = & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    return ($output -join "`n").Trim()
}

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Text)
    Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Test-GitProxy {
    $proxy = Get-NativeOutput "git" @("config", "--global", "--get", "https.proxy")
    if ([string]::IsNullOrWhiteSpace($proxy)) {
        Write-Host "No global Git HTTPS proxy configured."
        return
    }

    Write-Host "Git HTTPS proxy: $proxy"

    if ($proxy -match "127\.0\.0\.1:(\d+)") {
        $port = [int]$Matches[1]
        $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if (-not $listener) {
            Write-Warning "Git proxy points to 127.0.0.1:$port, but nothing is listening there. Start the proxy app or unset git proxy before deploy."
        }
    }
}

$repoRoot = (Get-Location).Path
$requiredFiles = @("package.json", "_config.yml")

foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $file))) {
        throw "Please run this script from the Hexo project root. Missing: $file"
    }
}

Write-Host "Hexo blog deploy helper" -ForegroundColor Green
Write-Host "Root: $repoRoot"
Write-Host "Remote: $RemoteUrl"
Write-Host "Source branch: $SourceBranch"

Write-Step "Check git repository"
Invoke-Native "git" @("rev-parse", "--is-inside-work-tree")

Write-Step "Ensure origin remote"
$originUrl = Get-NativeOutput "git" @("remote", "get-url", "origin")

if ([string]::IsNullOrWhiteSpace($originUrl)) {
    Invoke-Native "git" @("remote", "add", "origin", $RemoteUrl)
} elseif ($originUrl -ne $RemoteUrl) {
    Write-Host "origin currently points to: $originUrl" -ForegroundColor Yellow
    Invoke-Native "git" @("remote", "set-url", "origin", $RemoteUrl)
} else {
    Write-Host "origin already points to target repository."
}

Write-Step "Check git proxy"
Test-GitProxy

if (-not $SkipSourcePush) {
    Write-Step "Commit and push Hexo source"

    $currentBranch = Get-NativeOutput "git" @("branch", "--show-current")
    if ($currentBranch -ne $SourceBranch) {
        if (-not $DryRun) {
            & git show-ref --verify --quiet "refs/heads/$SourceBranch"
            $branchExists = ($LASTEXITCODE -eq 0)
        } else {
            $branchExists = $true
        }

        if ($branchExists) {
            Invoke-Native "git" @("switch", $SourceBranch)
        } else {
            Invoke-Native "git" @("switch", "-c", $SourceBranch)
        }
    }

    Invoke-Native "git" @("add", "-A")

    $pendingChanges = Get-NativeOutput "git" @("status", "--porcelain")
    if (-not [string]::IsNullOrWhiteSpace($pendingChanges)) {
        Invoke-Native "git" @("commit", "-m", $Message)
    } else {
        Write-Host "No source changes to commit."
    }

    Invoke-Native "git" @("push", "-u", "origin", $SourceBranch)
} else {
    Write-Step "Skip source push"
}

Write-Step "Generate Hexo site"
Invoke-Native "pnpm" @("exec", "hexo", "clean")
Invoke-Native "pnpm" @("exec", "hexo", "generate")

if (-not $SkipHexoDeploy) {
    Write-Step "Deploy generated site"
    Invoke-Native "pnpm" @("exec", "hexo", "deploy")
} else {
    Write-Step "Skip Hexo deploy"
}

Write-Host "`nDone." -ForegroundColor Green
