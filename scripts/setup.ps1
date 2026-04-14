param(
    [string]$IpfsApi = "http://127.0.0.1:5001/api/v0"
)

Write-Host "=== FileSync Setup ==="

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 未安装"
}

$env:IPFS_API = $IpfsApi
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "启动命令: npm start"
Write-Host "控制台地址: http://127.0.0.1:8384/ui"
