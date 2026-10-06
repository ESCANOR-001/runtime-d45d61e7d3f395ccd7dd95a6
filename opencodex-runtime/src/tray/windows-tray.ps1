param(
  [Parameter(Mandatory = $true)][string]$BunPath,
  [Parameter(Mandatory = $true)][string]$CliPath,
  [Parameter(Mandatory = $true)][string]$CodexHome,
  [Parameter(Mandatory = $true)][string]$OpenCodexHome,
  # Provenance of $BunPath, chosen when the tray entry was built. Optional so an
  # already-installed launcher command from an older version still starts.
  [ValidateSet("", "override", "bundled", "process")][string]$BunRuntimeSource = "",
  [ValidateSet("Run", "Stop")][string]$Mode = "Run",
  [int]$HostPid = 0,
  [switch]$ConnectOnly
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

# Normalize aliases before deriving singleton/event names. Without this,
# C:\path and C:\path\. create separate tray instances for the same home.
function Normalize-HomePath([string]$Value) {
  $full = [System.IO.Path]::GetFullPath($Value)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full -eq $root) { return $full }
  return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}
$OpenCodexHome = Normalize-HomePath $OpenCodexHome
$CodexHome = Normalize-HomePath $CodexHome

function Load-TrayIcon([string]$Name) {
  $path = Join-Path $OpenCodexHome $Name
  if (-not [System.IO.File]::Exists($path)) { return $null }
  try {
    return New-Object System.Drawing.Icon($path)
  } catch {
    return $null
  }
}
$customTrayIcon = Load-TrayIcon "remodex-tray.ico"
$trayIcon = if ($null -ne $customTrayIcon) { $customTrayIcon } else { [System.Drawing.SystemIcons]::Application }

function Get-StableHash([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value.ToLowerInvariant())
    $hash = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").Substring(0, 20)
    return $hash
  } finally {
    $sha.Dispose()
  }
}

$stableHash = Get-StableHash $OpenCodexHome
$stopEventCreated = $false
$stopEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "Local\OpenCodexTrayStop-$stableHash", [ref]$stopEventCreated)
if ($Mode -eq "Stop") {
  [void]$stopEvent.Set()
  $stopEvent.Dispose()
  exit 0
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\OpenCodexTray-$stableHash", [ref]$createdNew)
if (-not $createdNew) {
  $stopEvent.Dispose()
  $mutex.Dispose()
  exit 0
}

$heartbeatPath = Join-Path $OpenCodexHome "tray-heartbeat.json"
$actionLogPath = Join-Path $OpenCodexHome "tray-actions.log"

function Write-ActionLog([string]$Message) {
  $line = "[$([DateTimeOffset]::Now.ToString('o'))] $Message"
  [System.IO.File]::AppendAllText($actionLogPath, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function ConvertTo-NativeArgument([string]$Value) {
  if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw "Invalid native command argument"
  }
  return '"' + $Value + '"'
}

function Start-OcxCommand([string[]]$CommandArgs, [switch]$TrackExit) {
  try {
    $allArgs = @($CliPath) + $CommandArgs
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $BunPath
    $psi.Arguments = (($allArgs | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " ")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.EnvironmentVariables["CODEX_HOME"] = $CodexHome
    $psi.EnvironmentVariables["OPENCODEX_HOME"] = $OpenCodexHome
    if ($BunRuntimeSource) {
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_SOURCE"] = $BunRuntimeSource
      # Paired with the source so a later relaunch can tell the marker still describes
      # this binary rather than one it merely inherited.
      $psi.EnvironmentVariables["OCX_BUN_RUNTIME_PATH"] = $BunPath
    }
    $process = [System.Diagnostics.Process]::Start($psi)
    if ($null -eq $process) { throw "Process did not start" }
    Write-ActionLog "dispatched $($CommandArgs -join ' ')"
    if ($TrackExit) { return $process }
    $process.Dispose()
    return $true
  } catch {
    Write-ActionLog "launch failed: $($_.Exception.GetType().Name)"
    $notify.ShowBalloonTip(5000, "Remodex action failed", "The action could not start. Run rmx doctor for details.", [System.Windows.Forms.ToolTipIcon]::Error)
    return $false
  }
}

function Read-ListenTarget {
  foreach ($path in @((Join-Path $OpenCodexHome "runtime-port.json"), (Join-Path $OpenCodexHome "config.json"))) {
    try {
      $value = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
      $candidate = [int]$value.port
      if ($candidate -gt 0 -and $candidate -le 65535) {
        $candidateHost = [string]$value.hostname
        $ip = $null
        $hostName = if ([string]::IsNullOrWhiteSpace($candidateHost) -or $candidateHost -in @("localhost", "0.0.0.0", "::", "[::]")) {
          "127.0.0.1"
        } elseif ([System.Net.IPAddress]::TryParse($candidateHost.Trim("[", "]"), [ref]$ip)) {
          if ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) { "[$($ip.ToString())]" } else { $ip.ToString() }
        } else {
          "127.0.0.1"
        }
        return @{ port = $candidate; host = $hostName; pid = $value.pid }
      }
    } catch { }
  }
  return @{ port = 10100; host = "127.0.0.1"; pid = $null }
}

$httpHandler = New-Object System.Net.Http.HttpClientHandler
$httpHandler.UseProxy = $false
$httpHandler.UseCookies = $false
$httpClient = New-Object System.Net.Http.HttpClient($httpHandler)
$httpClient.Timeout = [TimeSpan]::FromMilliseconds(700)
$cacheControl = New-Object System.Net.Http.Headers.CacheControlHeaderValue
$cacheControl.NoCache = $true
$cacheControl.NoStore = $true
$httpClient.DefaultRequestHeaders.CacheControl = $cacheControl

$notify = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add("🔴 Offline · Refresh")
$openItem = $menu.Items.Add("Open dashboard")
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$proxyLifecycleItem = $menu.Items.Add("Start Proxy")
$applyChangesItem = $menu.Items.Add("Apply Changes")
$restartCodexItem = $menu.Items.Add("Restart Codex")
$restartRemodexItem = $menu.Items.Add("Restart Remodex")
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$restartDesktopItem = $menu.Items.Add("Restart desktop application (advanced)…")
$checkUpdateItem = $menu.Items.Add("Check package updates")
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add("Quit desktop shell")

# The Connect tray controls only Remodex. Keep Codex configuration and desktop
# restart actions out of this menu, including after a fresh Windows sign-in.
if ($ConnectOnly) {
  foreach ($item in @($applyChangesItem, $restartCodexItem, $restartDesktopItem, $checkUpdateItem)) {
    $item.Visible = $false
  }
}

$actionItems = @(
  $proxyLifecycleItem,
  $applyChangesItem,
  $restartCodexItem,
  $restartRemodexItem,
  $restartDesktopItem,
  $checkUpdateItem
)

$script:online = $false
$script:port = 10100
$script:proxyPid = $null
$script:pendingAction = $null
$script:pendingStarted = 0L
$script:pendingDeadline = 0L
$script:pendingOldProxyPid = $null
$script:pendingProcess = $null
$script:pendingExpectation = $null
$script:pendingItem = $null
$script:healthProbe = $null
$script:healthProbeTarget = $null
$script:nextHealthProbeAt = 0L
$script:lastHeartbeatAt = 0L
$healthProbeIntervalMs = 1000
$heartbeatIntervalMs = 3000

function Reset-ActionLabels {
  $proxyLifecycleItem.Text = if ($script:online) { "Stop Proxy" } else { "Start Proxy" }
  $applyChangesItem.Text = "Apply Changes"
  $restartCodexItem.Text = "Restart Codex"
  $restartRemodexItem.Text = "Restart Remodex"
  $restartDesktopItem.Text = "Restart desktop application (advanced)…"
  $checkUpdateItem.Text = "Check package updates"
}

function Update-ActionAvailability {
  $busy = $null -ne $script:pendingAction
  foreach ($item in $actionItems) { $item.Enabled = -not $busy }
}

function Set-PendingAction(
  [string]$Action,
  [int]$TimeoutSeconds,
  [ValidateSet("online", "offline", "restarted", "process")][string]$Expectation,
  [System.Windows.Forms.ToolStripMenuItem]$Item
) {
  if ($null -ne $script:pendingAction) {
    Write-ActionLog "$Action ignored because $($script:pendingAction) is still pending"
    return $false
  }
  if ($null -ne $script:pendingProcess) {
    try {
      $script:pendingProcess.Dispose()
    } catch {
      Write-ActionLog "pending process dispose failed: $($_.Exception.GetType().Name)"
    }
    $script:pendingProcess = $null
  }
  $script:pendingAction = $Action
  $script:pendingStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $script:pendingDeadline = $script:pendingStarted + ($TimeoutSeconds * 1000)
  $script:pendingOldProxyPid = $script:proxyPid
  $script:pendingExpectation = $Expectation
  $script:pendingItem = $Item
  Update-ActionAvailability
  return $true
}

function Complete-PendingAction([bool]$Success) {
  if ($null -eq $script:pendingAction) { return }
  $action = $script:pendingAction
  $script:pendingAction = $null
  $script:pendingExpectation = $null
  $script:pendingItem = $null
  if ($null -ne $script:pendingProcess) {
    try {
      $script:pendingProcess.Dispose()
    } catch {
      Write-ActionLog "pending process dispose failed: $($_.Exception.GetType().Name)"
    }
    $script:pendingProcess = $null
  }
  if ($Success) {
    Write-ActionLog "$action completed (port=$($script:port), pid=$($script:proxyPid))"
    $notify.ShowBalloonTip(2500, "Remodex", "$action completed.", [System.Windows.Forms.ToolTipIcon]::Info)
  } else {
    Write-ActionLog "$action failed to reach the expected state"
    $notify.ShowBalloonTip(5000, "Remodex action failed", "$action did not reach the expected state. Run rmx doctor for details.", [System.Windows.Forms.ToolTipIcon]::Error)
  }
  Reset-ActionLabels
  Update-ActionAvailability
}

function Start-PendingCommand(
  [string]$Action,
  [string]$ProgressLabel,
  [string[]]$CommandArgs,
  [int]$TimeoutSeconds,
  [ValidateSet("online", "offline", "restarted", "process")][string]$Expectation,
  [System.Windows.Forms.ToolStripMenuItem]$Item
) {
  if (-not (Set-PendingAction -Action $Action -TimeoutSeconds $TimeoutSeconds -Expectation $Expectation -Item $Item)) {
    return
  }
  $Item.Text = $ProgressLabel
  $pending = Start-OcxCommand $CommandArgs -TrackExit
  if ($pending -is [System.Diagnostics.Process]) {
    $script:pendingProcess = $pending
  } else {
    Complete-PendingAction $false
  }
}

function Apply-HealthResult($target, $health) {
  $script:port = [int]$target.port
  $pidMatches = $null -eq $target.pid -or [int]$target.pid -eq [int]$health.pid
  $script:online = $null -ne $health -and $health.status -eq "ok" -and $health.service -eq "opencodex" -and [int]$health.port -eq $script:port -and $pidMatches
  $script:proxyPid = if ($script:online) { [int]$health.pid } else { $null }
  if ($script:online) {
    # The first row represents live runtime reachability only. Startup safety is
    # a protected dashboard diagnostic; requesting it here without a dashboard
    # session made every healthy npm tray look degraded.
    $notify.Text = "Remodex: Ready"
    $statusItem.Text = "🟢 Ready · port $($script:port) · PID $($script:proxyPid) · Refresh"
  } else {
    $statusItem.Text = "🔴 Offline · Refresh"
    $notify.Text = "Remodex: Offline"
  }
  if ($null -ne $script:pendingAction) {
    $statusItem.Text = "🟡 $($script:pendingAction)…"
  }
}

function Health-TargetKey($target) {
  return "$($target.host)|$($target.port)|$($target.pid)"
}

function Start-HealthProbe {
  if ($null -ne $script:healthProbe) { return }
  $target = Read-ListenTarget
  $script:port = [int]$target.port
  $origin = "http://$($target.host):$($script:port)"
  $probeUrl = "$origin/healthz?trayProbe=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  try {
    # Do not wait on the UI thread. Timer ticks observe completion and apply only
    # a result for the same runtime-port identity that was originally probed.
    $script:healthProbe = $httpClient.GetStringAsync($probeUrl)
    $script:healthProbeTarget = $target
  } catch {
    Apply-HealthResult $target $null
    $script:nextHealthProbeAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $healthProbeIntervalMs
  }
}

function Complete-HealthProbe {
  if ($null -eq $script:healthProbe -or -not $script:healthProbe.IsCompleted) { return }
  $probe = $script:healthProbe
  $target = $script:healthProbeTarget
  $script:healthProbe = $null
  $script:healthProbeTarget = $null
  $health = $null
  try {
    $health = $probe.GetAwaiter().GetResult() | ConvertFrom-Json
  } catch { }
  $currentTarget = Read-ListenTarget
  if ((Health-TargetKey $target) -eq (Health-TargetKey $currentTarget)) {
    Apply-HealthResult $target $health
    $script:nextHealthProbeAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $healthProbeIntervalMs
  } else {
    # The service moved while the request was in flight. Discard that answer and
    # immediately probe the new port/PID rather than flashing stale state.
    $script:nextHealthProbeAt = 0L
  }
}

function Write-TrayHeartbeat([long]$Now) {
  if ($script:lastHeartbeatAt -ne 0L -and $Now -lt $script:lastHeartbeatAt + $heartbeatIntervalMs) { return }
  $heartbeat = @{ pid = $PID; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  if ($HostPid -gt 0) { $heartbeat.hostPid = $HostPid }
  $heartbeatJson = $heartbeat | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($heartbeatPath, $heartbeatJson, (New-Object System.Text.UTF8Encoding($false)))
  $script:lastHeartbeatAt = $Now
}

function Update-TrayState {
  Complete-HealthProbe
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($null -eq $script:healthProbe -and $now -ge $script:nextHealthProbeAt) {
    Start-HealthProbe
  }
  Write-TrayHeartbeat $now
  if ($null -ne $script:pendingAction) {
    $elapsed = $now - $script:pendingStarted
    $reached = ($script:pendingExpectation -eq "online" -and $script:online) -or
      ($script:pendingExpectation -eq "offline" -and -not $script:online) -or
      ($script:pendingExpectation -eq "restarted" -and $elapsed -gt 3000 -and $script:online -and $script:proxyPid -ne $script:pendingOldProxyPid)
    $commandFailed = $false
    $commandComplete = $false
    if ($null -ne $script:pendingProcess) {
      try {
        $commandComplete = $script:pendingProcess.HasExited
        $commandFailed = $commandComplete -and $script:pendingProcess.ExitCode -ne 0
      } catch {
        Write-ActionLog "pending process result inspection failed: $($_.Exception.GetType().Name)"
        # If we cannot inspect the tracked command, we cannot prove it is still
        # healthy. Fail the pending action instead of silently waiting for a later
        # timeout and presenting an indeterminate process as success-capable.
        $commandFailed = $true
      }
    }
    if ($commandFailed) { Complete-PendingAction $false }
    elseif ($script:pendingExpectation -eq "process" -and $commandComplete) { Complete-PendingAction $true }
    elseif ($reached) { Complete-PendingAction $true }
    elseif ($now -gt $script:pendingDeadline) { Complete-PendingAction $false }
  }
  if ($null -eq $script:pendingAction) { Reset-ActionLabels }
  Update-ActionAvailability
}

$openItem.add_Click({ Start-OcxCommand @("gui") })
$statusItem.add_Click({
  $statusItem.Text = "↻ Checking runtime…"
  $script:nextHealthProbeAt = 0L
  Update-TrayState
})
$proxyLifecycleItem.add_Click({
  if ($script:online) {
    Start-PendingCommand -Action "Stop Proxy" -ProgressLabel "Stopping Proxy…" -CommandArgs @("stop") -TimeoutSeconds 20 -Expectation "offline" -Item $proxyLifecycleItem
  } else {
    # service start can spend 20s and the CLI then observes health for another 40s.
    Start-PendingCommand -Action "Start Proxy" -ProgressLabel "Starting Proxy…" -CommandArgs @("__tray-start") -TimeoutSeconds 75 -Expectation "online" -Item $proxyLifecycleItem
  }
})
$applyChangesItem.add_Click({
  Start-PendingCommand -Action "Apply Changes" -ProgressLabel "Applying changes…" -CommandArgs @("sync") -TimeoutSeconds 180 -Expectation "process" -Item $applyChangesItem
})
$restartCodexItem.add_Click({
  Start-PendingCommand -Action "Restart Codex" -ProgressLabel "Restarting Codex…" -CommandArgs @("__desktop-restart-codex") -TimeoutSeconds 60 -Expectation "process" -Item $restartCodexItem
})
$restartRemodexItem.add_Click({
  # /api/system/restart may drain active work for 60s and then spend up to 70s
  # handing off to an identity-verified replacement. The tray observes health/PID
  # rather than the detached CLI exit, so keep a watchdog margin around that shared
  # lifecycle budget. The CLI remains the lifecycle owner; the tray never kills.
  Start-PendingCommand -Action "Restart Remodex" -ProgressLabel "Restarting Remodex…" -CommandArgs @("__tray-restart") -TimeoutSeconds 160 -Expectation "restarted" -Item $restartRemodexItem
})
$restartDesktopItem.add_Click({
  Start-PendingCommand -Action "Restart desktop application" -ProgressLabel "Restarting desktop application…" -CommandArgs @("__desktop-restart-client") -TimeoutSeconds 60 -Expectation "process" -Item $restartDesktopItem
})
$checkUpdateItem.add_Click({
  Start-PendingCommand -Action "Open package updater" -ProgressLabel "Opening package updater…" -CommandArgs @("gui", "--update") -TimeoutSeconds 90 -Expectation "process" -Item $checkUpdateItem
})
$exitItem.add_Click({ [System.Windows.Forms.Application]::Exit() })
$notify.add_DoubleClick({ Start-OcxCommand @("gui") })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.add_Tick({
  if ($stopEvent.WaitOne(0)) {
    [System.Windows.Forms.Application]::Exit()
    return
  }
  Update-TrayState
})
$notify.ContextMenuStrip = $menu
$notify.Icon = $trayIcon
$notify.Visible = $true
$notify.Text = "Remodex: Checking..."

try {
  Update-TrayState
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $timer.Dispose()
  $notify.Visible = $false
  if ($null -ne $script:pendingProcess) {
    try { $script:pendingProcess.Dispose() } catch { $null = $_ }
  }
  $notify.Dispose()
  $httpClient.Dispose()
  $httpHandler.Dispose()
  if ($null -ne $customTrayIcon) { $customTrayIcon.Dispose() }
  $menu.Dispose()
  try { Remove-Item -LiteralPath $heartbeatPath -Force -ErrorAction SilentlyContinue } catch { }
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
  $stopEvent.Dispose()
}
