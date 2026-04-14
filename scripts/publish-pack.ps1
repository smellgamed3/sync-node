param(
    [string]$Scope = "",
    [string]$ShareRoot = ""
)

if ($Scope) { $env:NPM_SCOPE = $Scope }
if ($ShareRoot) { $env:NPM_SHARE_ROOT = $ShareRoot }

node "$PSScriptRoot/publish-pack.mjs"
exit $LASTEXITCODE
