$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\ScreenAgent.cs'
if (-not (Test-Path -LiteralPath $source)) { throw 'FAIL: tray agent with adjustable selection is not implemented.' }
Add-Type -Path @($source, (Join-Path $PSScriptRoot 'AgentTests.cs')) -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Net.Http,System.Web.Extensions
$null = [AgentTests]::Protocol().GetAwaiter().GetResult()
Write-Output 'PASS: registration, authorization, polling, frame retry protocol'
$checks = 0
function Check($condition, [string]$message) {
    if (-not $condition) { throw "FAIL: $message" }
    $script:checks++
}
$bounds = [System.Drawing.Rectangle]::new(-1920, 0, 3840, 1080)
$r = [Shiye.RegionMath]::FromPoints([System.Drawing.Point]::new(900,700), [System.Drawing.Point]::new(100,100))
Check ($r.X -eq 100 -and $r.Y -eq 100 -and $r.Width -eq 800 -and $r.Height -eq 600) 'reverse-direction selection'
$moved = [Shiye.RegionMath]::Move([System.Drawing.Rectangle]::new(100,100,800,600), -3000, 2000, $bounds)
Check ($moved.X -eq -1920 -and $moved.Y -eq 480 -and $moved.Size -eq $r.Size) 'moving clamps to multi-monitor bounds without changing size'
$resized = [Shiye.RegionMath]::Resize($r, 'NW', [System.Drawing.Point]::new(950,800), [System.Drawing.Rectangle]::new(0,0,1920,1080))
Check ($resized.Width -ge 24 -and $resized.Height -ge 24 -and $resized.Right -eq 900 -and $resized.Bottom -eq 700) 'resize cannot invert or collapse rectangle'
Check (-not [Shiye.RegionMath]::IsValid([System.Drawing.Rectangle]::new(0,0,10,10), $bounds)) 'tiny regions rejected'
Check (-not [Shiye.RegionMath]::IsValid([System.Drawing.Rectangle]::new(1900,0,200,200), $bounds)) 'off-screen regions rejected'
Check ([Shiye.RegionMath]::IsValid([System.Drawing.Rectangle]::new(-1800,100,800,600), $bounds)) 'negative monitor coordinates supported'
$state = [Shiye.CaptureState]::new()
$state.Region = [System.Drawing.Rectangle]::new(100,100,800,600)
Check $state.CanCapture 'valid region can capture'
$state.BeginSelection()
Check (-not $state.CanCapture) 'no captures while selector overlay is visible'
$state.EndSelection($null)
Check ($state.CanCapture -and $state.Region.X -eq 100) 'cancel preserves previous region'
$state.BeginSelection()
$state.EndSelection([System.Drawing.Rectangle]::new(200,200,640,480))
Check ($state.CanCapture -and $state.Region.Width -eq 640) 'confirm updates capture region'
$state.BeginSelection()
$state.EndSelection([System.Drawing.Rectangle]::Empty)
Check ($state.Region.Width -eq 640) 'invalid selection never replaces previous region'
Write-Output "PASS: $checks behavior checks"
[AgentTests]::Selector((Join-Path $PSScriptRoot 'selector-preview.png'))
Write-Output 'PASS: selector mouse, keyboard, confirmation, cancellation and render'
[AgentTests]::Lifecycle()
Write-Output 'PASS: tray survives failures, reconnects, keeps heartbeat during selection, blocks invalid captures'
[AgentTests]::Shutdown()
Write-Output 'PASS: shutdown waits for an in-flight request before finishing batch'
