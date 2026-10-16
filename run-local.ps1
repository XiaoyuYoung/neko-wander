$ErrorActionPreference = 'Stop'
$packageDir = $PSScriptRoot
$repository = (Resolve-Path (Join-Path $packageDir '..\..\..')).Path
$entry = (Join-Path $packageDir 'src\index.ts').Replace('\', '/')
$overlay = Join-Path $packageDir 'cordis.local.generated.yml'

if (-not $env:AMAP_WEB_KEY -or -not $env:AMAP_JS_KEY -or -not $env:AMAP_JS_SECURITY_CODE) {
  throw 'Set AMAP_WEB_KEY, AMAP_JS_KEY and AMAP_JS_SECURITY_CODE first.'
}

@"
- insert:
    - id: neko-wander
      name: '$entry'
      config:
        webServiceKey: !!js process.env.AMAP_WEB_KEY
        jsApiKey: !!js process.env.AMAP_JS_KEY
        jsSecurityCode: !!js process.env.AMAP_JS_SECURITY_CODE
"@ | Set-Content -LiteralPath $overlay -Encoding utf8

if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $packageDir '.dsh-local' }
Push-Location $repository
try { node --import tsx/esm apps/cli/src/bin.ts web --patch $overlay --no-open @args }
finally { Pop-Location }
