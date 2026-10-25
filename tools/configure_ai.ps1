$ErrorActionPreference = 'Stop'
$privateDirectory = Join-Path $env:LOCALAPPDATA 'CidneyAurum\secrets'
$key = Read-Host '请输入 DeepSeek API Key（输入内容不显示）' -AsSecureString
if ($key.Length -lt 12) { throw 'API Key 为空或过短，没有保存。' }
New-Item -ItemType Directory -Path $privateDirectory -Force | Out-Null
$encrypted = $key | ConvertFrom-SecureString
[IO.File]::WriteAllText((Join-Path $privateDirectory 'deepseek.dpapi'), $encrypted, [Text.UTF8Encoding]::new($false))
Write-Output '已使用当前 Windows 用户的 DPAPI 保存到本机私有目录。'
