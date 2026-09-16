<#
.SYNOPSIS
    飞鸽AI客服视觉服务环境配置脚本
.DESCRIPTION
    创建 Python 虚拟环境并安装视觉服务所需依赖
    1. 检查 Python >= 3.10
    2. 创建 vision/venv 虚拟环境
    3. 安装 vision/requirements.txt 依赖
.NOTES
    运行方式: powershell -ExecutionPolicy Bypass -File vision/setup-vision.ps1
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPath = Join-Path $PSScriptRoot "venv"
$VenvPython = Join-Path $VenvPath "Scripts\python.exe"
$RequirementsFile = Join-Path $PSScriptRoot "requirements.txt"

function Write-Step($msg) { Write-Host "`n[1] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [XX] $msg" -ForegroundColor Red }

# ============ 1. 检查 Python ============
Write-Step "检查 Python 环境..."
try {
    $pyVersion = & python --version 2>&1
    $pyMatch = [regex]::Match($pyVersion, "Python (\d+)\.(\d+)\.(\d+)")
    if (-not $pyMatch.Success) {
        Write-Err "无法解析 Python 版本: $pyVersion"
        Write-Err "请从 https://python.org 安装 Python 3.10+ 并添加到 PATH"
        exit 1
    }
    $major = [int]$pyMatch.Groups[1].Value
    $minor = [int]$pyMatch.Groups[2].Value
    if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 10)) {
        Write-Err "Python 版本过低: $pyVersion，需要 3.10+"
        exit 1
    }
    Write-Ok "Python $pyVersion"
} catch {
    Write-Err "Python 未安装或不在 PATH 中"
    Write-Err "请从 https://python.org 安装 Python 3.10+"
    exit 1
}

# ============ 2. 创建虚拟环境 ============
Write-Step "创建 Python 虚拟环境..."
if (Test-Path $VenvPython) {
    Write-Warn "虚拟环境已存在: $VenvPath"
    $overwrite = Read-Host "  是否重新创建? (y/N)"
    if ($overwrite -ne 'y') {
        Write-Ok "跳过虚拟环境创建"
    } else {
        Remove-Item -Recurse -Force $VenvPath
        & python -m venv $VenvPath
        Write-Ok "虚拟环境已重建: $VenvPath"
    }
} else {
    & python -m venv $VenvPath
    if (Test-Path $VenvPython) {
        Write-Ok "虚拟环境已创建: $VenvPath"
    } else {
        Write-Err "虚拟环境创建失败"
        exit 1
    }
}

# ============ 3. 升级 pip ============
Write-Step "升级 pip..."
& $VenvPython -m pip install --upgrade pip --quiet
Write-Ok "pip 已升级"

# ============ 4. 安装依赖 ============
Write-Step "安装视觉服务依赖..."
Write-Host "  正在安装 (可能需要 5-10 分钟，请耐心等待)..."
& $VenvPython -m pip install -r $RequirementsFile
if ($LASTEXITCODE -ne 0) {
    Write-Err "依赖安装失败"
    Write-Warn "常见原因: 网络问题、Visual Studio Build Tools 缺失"
    Write-Warn "PaddlePaddle 可能需要指定版本，尝试: pip install paddlepaddle==2.6.1"
    exit 1
}
Write-Ok "依赖安装完成"

# ============ 5. 验证安装 ============
Write-Step "验证核心依赖..."
$deps = @("cv2", "paddleocr", "win32gui", "numpy", "ultralytics")
$allOk = $true
foreach ($dep in $deps) {
    $result = & $VenvPython -c "import $dep; print('$dep ok')" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Ok $result
    } else {
        Write-Err "$dep 导入失败: $result"
        $allOk = $false
    }
}

# ============ 6. 摘要 ============
Write-Step "安装摘要"
Write-Host ""
Write-Host "  虚拟环境: $VenvPath" -ForegroundColor White
Write-Host "  Python:   $($pyVersion.ToString().Trim())" -ForegroundColor White
Write-Host "  依赖状态: $(if ($allOk) { '全部正常' } else { '部分异常，请检查上方日志' })" -ForegroundColor $(if ($allOk) { 'Green' } else { 'Yellow' })
Write-Host ""
Write-Host "  PaddleOCR 模型将在首次启动视觉服务时自动下载" -ForegroundColor Gray
Write-Host ""

if ($allOk) {
    Write-Ok "视觉服务环境配置完成！"
    Write-Host "  启动命令: $VenvPython vision_service.py" -ForegroundColor Gray
} else {
    Write-Warn "部分依赖异常，视觉服务可能无法正常启动"
}
