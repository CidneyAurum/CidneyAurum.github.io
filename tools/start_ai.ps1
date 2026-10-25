param(
    [string]$Model = 'deepseek-flash',
    [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'CidneyAurum\secrets\deepseek.dpapi')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $SecretPath)) {
    throw '未找到本机 AI 凭证。请先运行 tools/configure_ai.ps1。'
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$secureKey = Get-Content -Raw -LiteralPath $SecretPath | ConvertTo-SecureString
$credential = [PSCredential]::new('deepseek', $secureKey)
$previousKey = $env:DEEPSEEK_API_KEY
$previousModel = $env:DEEPSEEK_MODEL
try {
    $env:DEEPSEEK_API_KEY = $credential.GetNetworkCredential().Password
    $env:DEEPSEEK_MODEL = $Model
    & node (Join-Path $repoRoot 'server\local-ai.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'AI 网关未能启动，请检查服务日志。' }
} finally {
    $env:DEEPSEEK_API_KEY = $previousKey
    $env:DEEPSEEK_MODEL = $previousModel
}
