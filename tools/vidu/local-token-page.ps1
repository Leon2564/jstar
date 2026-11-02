param([int]$Port = 18765)

$ErrorActionPreference = 'Stop'
$prefix = "http://127.0.0.1:$Port/"
$envPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\.env'))
$nonce = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()

function Send-Html([Net.HttpListenerResponse]$response, [string]$html, [int]$status = 200) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($html)
  $response.StatusCode = $status
  $response.ContentType = 'text/html; charset=utf-8'
  $response.ContentLength64 = $bytes.Length
  $response.Headers['Cache-Control'] = 'no-store'
  $response.Headers['X-Frame-Options'] = 'DENY'
  $response.Headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.Close()
}

function Parse-Form([string]$body) {
  $form = @{}
  foreach ($part in $body.Split('&', [StringSplitOptions]::RemoveEmptyEntries)) {
    $pair = $part.Split('=', 2)
    $key = [Net.WebUtility]::UrlDecode($pair[0].Replace('+', ' '))
    $value = if ($pair.Length -gt 1) { [Net.WebUtility]::UrlDecode($pair[1].Replace('+', ' ')) } else { '' }
    $form[$key] = $value
  }
  return $form
}

function Page([string]$message = '', [bool]$error = $false) {
  $note = if ($message) { "<p class='notice $($error ? 'bad' : 'ok')'>$([Net.WebUtility]::HtmlEncode($message))</p>" } else { '' }
  return @"
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JSTAR · Vidu 配置</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 70% 10%,#2d315d,#12152f 62%);color:#f2e9ee;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(92vw,480px);padding:34px;border:1px solid rgba(242,233,238,.25);background:rgba(22,25,54,.72);box-shadow:0 28px 80px rgba(0,0,0,.35);backdrop-filter:blur(18px)}.brand{letter-spacing:.28em;color:#e3a8b2;font-family:Georgia,serif}.sub{margin:10px 0 28px;color:rgba(242,233,238,.68);line-height:1.7;font-size:14px}label{display:block;margin-bottom:10px;font-size:13px;letter-spacing:.08em}input{width:100%;height:48px;padding:0 14px;border:1px solid rgba(242,233,238,.35);background:rgba(7,9,28,.65);color:#fff;font:15px ui-monospace,monospace;outline:none}input:focus{border-color:#e3a8b2;box-shadow:0 0 0 3px rgba(227,168,178,.12)}button{width:100%;height:48px;margin-top:16px;border:0;background:#d98d9c;color:#171934;font-weight:700;letter-spacing:.12em;cursor:pointer}.notice{padding:12px 14px;font-size:13px;line-height:1.5}.ok{background:rgba(114,188,153,.15);border:1px solid rgba(114,188,153,.45)}.bad{background:rgba(225,109,122,.15);border:1px solid rgba(225,109,122,.45)}.privacy{margin:16px 0 0;color:rgba(242,233,238,.5);font-size:12px;line-height:1.6}
</style></head><body><main class="card"><div class="brand">✦ JSTAR</div><h1>连接 Vidu</h1><p class="sub">输入内容只会保存到本机项目的私密环境配置中，不会发送到聊天窗口。</p>$note<form method="post" action="/save"><input type="hidden" name="nonce" value="$nonce"><label for="token">VIDU API TOKEN</label><input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required autofocus><button type="submit">保存到本机</button></form><p class="privacy">页面仅监听 127.0.0.1，保存成功后会自动关闭本地输入服务。</p></main></body></html>
"@
}

$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Vidu local token page: $prefix"

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    if ($request.HttpMethod -eq 'GET' -and $request.Url.AbsolutePath -eq '/') {
      Send-Html $context.Response (Page)
      continue
    }
    if ($request.HttpMethod -eq 'POST' -and $request.Url.AbsolutePath -eq '/save') {
      $reader = [IO.StreamReader]::new($request.InputStream, $request.ContentEncoding)
      try { $form = Parse-Form $reader.ReadToEnd() } finally { $reader.Dispose() }
      $token = [string]$form['token']
      if ($form['nonce'] -ne $nonce -or $token -notmatch '^[A-Za-z0-9_.-]{20,}$') {
        Send-Html $context.Response (Page 'Token 格式不正确，请重新输入。' $true) 400
        continue
      }
      $lines = [Collections.Generic.List[string]]::new()
      if ([IO.File]::Exists($envPath)) {
        foreach ($line in [IO.File]::ReadAllLines($envPath)) { $lines.Add($line) }
      }
      $found = $false
      for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^VIDU_API_TOKEN=') { $lines[$i] = "VIDU_API_TOKEN=$token"; $found = $true; break }
      }
      if (-not $found) { $lines.Add("VIDU_API_TOKEN=$token") }
      $tempPath = "$envPath.vidu.tmp"
      [IO.File]::WriteAllLines($tempPath, $lines, [Text.UTF8Encoding]::new($false))
      [IO.File]::Move($tempPath, $envPath, $true)
      Send-Html $context.Response (Page '已安全保存。现在可以关闭此页面并回到 Codex。')
      break
    }
    $context.Response.StatusCode = 404
    $context.Response.Close()
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
