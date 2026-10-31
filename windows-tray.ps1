param([int]$Port = 3000)

# A per-user tray host for the local server. It never stops a server that it
# did not start itself (for example, one running in a developer's terminal).
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$mutex = New-Object System.Threading.Mutex($false, 'Local\InverseAI.NetworkFileSharing.Tray')
if (-not $mutex.WaitOne(0, $false)) { $mutex.Dispose(); exit }

$script:serverProcess = $null
$script:baseUrl = "http://127.0.0.1:$Port"
$script:serverPath = Join-Path $PSScriptRoot 'server.js'
$script:tray = New-Object System.Windows.Forms.NotifyIcon
$script:menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:status = $script:menu.Items.Add('Checking server...')
$script:status.Enabled = $false
$open = $script:menu.Items.Add('Open Network File Sharing')
$start = $script:menu.Items.Add('Start server')
$stop = $script:menu.Items.Add('Stop server started by tray')
[void]$script:menu.Items.Add('-')
$exit = $script:menu.Items.Add('Exit')
$script:tray.ContextMenuStrip = $script:menu
$script:tray.Visible = $true

function Test-Server {
  try {
    $request = [System.Net.WebRequest]::Create("$script:baseUrl/health")
    $request.Timeout = 1000
    $response = $request.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try { $result = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      return $result.ok -eq $true
    } finally { $response.Close() }
  } catch { return $false }
}
function Update-Status {
  $running = Test-Server
  $owned = $null -ne $script:serverProcess -and -not $script:serverProcess.HasExited
  $script:status.Text = if ($running) { 'Server running' } else { 'Server unavailable' }
  $script:tray.Text = "Network File Sharing: $($script:status.Text)"
  $script:tray.Icon = if ($running) { [System.Drawing.SystemIcons]::Information } else { [System.Drawing.SystemIcons]::Warning }
  $start.Enabled = -not $running -and -not $owned
  $stop.Enabled = $owned
}
function Start-Server {
  if (Test-Server) { Update-Status; return }
  try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $env:PORT = "$Port"
    $script:serverProcess = Start-Process -FilePath $node -ArgumentList ('"' + $script:serverPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
  } catch {
    [System.Windows.Forms.MessageBox]::Show("Could not start the server: $($_.Exception.Message)", 'Network File Sharing') | Out-Null
  }
  Update-Status
}
function Stop-OwnedServer {
  if ($null -ne $script:serverProcess -and -not $script:serverProcess.HasExited) {
    $script:serverProcess.Kill()
    $script:serverProcess.WaitForExit()
  }
  $script:serverProcess = $null
  Update-Status
}
$open.Add_Click({ Start-Process "$script:baseUrl/" })
$script:tray.Add_DoubleClick({ Start-Process "$script:baseUrl/" })
$start.Add_Click({ Start-Server })
$stop.Add_Click({ Stop-OwnedServer })
$exit.Add_Click({ [System.Windows.Forms.Application]::ExitThread() })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-Status })
try {
  Start-Server
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  Stop-OwnedServer
  $script:tray.Visible = $false
  $script:tray.Dispose()
  $script:menu.Dispose()
  $timer.Dispose()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
