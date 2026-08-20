$chrome = "C:\Users\tea9yu\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe"
$repo = "C:\Users\tea9yu\trello-threads"
Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*ms-playwright*" } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
foreach ($p in @(@{port=9222;dir='profile-a'}, @{port=9223;dir='profile-b'})) {
  Start-Process -FilePath $chrome -ArgumentList @(
    "--remote-debugging-port=$($p.port)", "--remote-allow-origins=*",
    "--user-data-dir=$repo\$($p.dir)", "--load-extension=$repo",
    "--disable-extensions-except=$repo", "--no-first-run",
    "--no-default-browser-check", "--new-window", "https://trello.com/"
  )
}
Start-Sleep -Seconds 8
foreach ($port in 9222,9223) {
  try { $v = Invoke-RestMethod "http://127.0.0.1:$port/json/version" -TimeoutSec 5; Write-Output "$port OK $($v.Browser)" }
  catch { Write-Output "$port DOWN" }
}
