# 虾皮控制中台启动脚本：安装依赖（首次）→ 构建界面（缺失时）→ 启动或重启本地服务 → 打开浏览器
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$url = 'http://127.0.0.1:8787'

function Get-Health {
    try { return Invoke-RestMethod "$url/api/health" -TimeoutSec 2 } catch { return $null }
}

try {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw '未找到 Node.js。请先安装 Node.js 20.19+ 或 22.12+，再双击启动。' }
    $nodePath = $node.Source
    $expected = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version

    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
        Write-Host '首次运行，正在安装依赖……'
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重试。' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist/index.html'))) {
        Write-Host '正在构建界面……'
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw '界面构建失败。' }
    }

    $health = Get-Health
    if ($health -and $health.app -eq 'shopee-vn-workbench' -and $health.version -ne $expected) {
        Write-Host "检测到旧版本服务（$($health.version)），正在重启为 $expected ……"
        Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
        for ($i = 0; $i -lt 20 -and (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
        $health = $null
    }

    $ready = $health -and $health.app -eq 'shopee-vn-workbench'
    if (-not $ready) {
        if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { throw '8787 端口已被其他程序占用，请先关闭该程序。' }
        $entry = Join-Path $PSScriptRoot 'server/index.mjs'
        Start-Process -FilePath $nodePath -ArgumentList ('"' + $entry + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $PSScriptRoot 'workbench.log') -RedirectStandardError (Join-Path $PSScriptRoot 'workbench-error.log') | Out-Null
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 300
            $health = Get-Health
            if ($health -and $health.app -eq 'shopee-vn-workbench') { $ready = $true; break }
        }
    }
    if (-not $ready) { throw '工作台未能启动，请查看文件夹中的 workbench-error.log。' }
    Start-Process $url
} catch {
    Write-Host ''
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
