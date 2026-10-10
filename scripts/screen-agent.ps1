param(
    [Parameter(Mandatory=$true)][string]$ServerUrl,
    [string]$PairToken,
    [int]$X = 0, [int]$Y = 0, [int]$Width = 0, [int]$Height = 0,
    [switch]$SelectOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ScreenDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[void][ScreenDpi]::SetProcessDPIAware()

function Select-CaptureRegion {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $background = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($background)
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
    $graphics.Dispose()
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Select capture area - drag a rectangle; Esc cancels'
    $form.FormBorderStyle = 'None'; $form.StartPosition = 'Manual'; $form.Bounds = $bounds
    $form.BackgroundImage = $background; $form.TopMost = $true; $form.KeyPreview = $true
    $form.Cursor = [System.Windows.Forms.Cursors]::Cross
    $script:regionStart = $null; $script:regionRect = [System.Drawing.Rectangle]::Empty
    $form.Add_MouseDown({ param($sender,$event) $script:regionStart = $event.Location })
    $form.Add_MouseMove({ param($sender,$event)
        if ($null -ne $script:regionStart) {
            $script:regionRect = New-Object System.Drawing.Rectangle([Math]::Min($script:regionStart.X,$event.X), [Math]::Min($script:regionStart.Y,$event.Y), [Math]::Abs($event.X-$script:regionStart.X), [Math]::Abs($event.Y-$script:regionStart.Y))
            $sender.Invalidate()
        }
    })
    $form.Add_Paint({ param($sender,$event)
        if ($script:regionRect.Width -gt 0) { $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Lime,3); $event.Graphics.DrawRectangle($pen,$script:regionRect); $pen.Dispose() }
    })
    $form.Add_MouseUp({ param($sender,$event)
        if ($script:regionRect.Width -gt 20 -and $script:regionRect.Height -gt 20) { $sender.DialogResult = 'OK'; $sender.Close() }
    })
    $form.Add_KeyDown({ param($sender,$event) if ($event.KeyCode -eq 'Escape') { $sender.DialogResult = 'Cancel'; $sender.Close() } })
    $result = $form.ShowDialog(); $form.Dispose(); $background.Dispose()
    if ($result -ne 'OK') { throw 'Region selection cancelled.' }
    return New-Object System.Drawing.Rectangle(($bounds.Left + $script:regionRect.X),($bounds.Top + $script:regionRect.Y),$script:regionRect.Width,$script:regionRect.Height)
}

if (-not $SelectOnly -and -not $PairToken) { $PairToken = Read-Host 'Pairing code shown on the controller PC' }
if ($Width -le 0 -or $Height -le 0) {
    $launcher = New-Object System.Windows.Forms.Form
    $launcher.Text = 'Capture setup'; $launcher.Size = New-Object System.Drawing.Size(300,130)
    $launcher.StartPosition = 'CenterScreen'; $launcher.TopMost = $true
    $launcher.FormBorderStyle = 'FixedToolWindow'; $launcher.ShowInTaskbar = $false
    $button = New-Object System.Windows.Forms.Button
    $button.Text = 'Select capture region'; $button.Dock = 'Fill'
    $button.Add_Click({ $launcher.DialogResult = 'OK'; $launcher.Close() })
    $launcher.Controls.Add($button)
    $choice = $launcher.ShowDialog(); $launcher.Dispose()
    if ($choice -ne 'OK') { exit 0 }
    $rect = Select-CaptureRegion; $X = $rect.X; $Y = $rect.Y; $Width = $rect.Width; $Height = $rect.Height
}
if ($Width -le 0 -or $Height -le 0 -or ([long]$Width * $Height) -gt 32000000) { throw 'Capture area is invalid or too large.' }
Write-Host "Fixed region: -X $X -Y $Y -Width $Width -Height $Height"
if ($SelectOnly) { exit 0 }
$base = $ServerUrl.TrimEnd('/')
$headers = @{ Authorization = "Bearer $PairToken" }
function Post-Json($route, $payload) {
    $json = $payload | ConvertTo-Json -Compress -Depth 8
    return Invoke-RestMethod -Uri "$base$route" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 8
}
$registration = Post-Json '/api/source/register' @{ name = $env:COMPUTERNAME }
$headers['X-Client-Id'] = $registration.clientId
$script:batch = $null; $script:count = 0; $script:nextShot = 0L; $ack = ''; $lastCommand = ''; $watch = [System.Diagnostics.Stopwatch]::StartNew()
function Finish-Batch([string]$failure = '') {
    if ($null -ne $script:batch) {
        $payload = @{ batchId = $script:batch.id; error = $failure }
        $script:batch = $null
        [void](Post-Json '/api/source/finish' $payload)
    }
}
function Send-Screenshot {
    $bitmap = New-Object System.Drawing.Bitmap($Width,$Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $stream = New-Object System.IO.MemoryStream
    try {
        $graphics.CopyFromScreen($X,$Y,0,0,(New-Object System.Drawing.Size($Width,$Height)))
        $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
        $frameId = [guid]::NewGuid().ToString(); $time = [Uri]::EscapeDataString([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'))
        $uri = "$base/api/frame?batchId=$($script:batch.id)&frameId=$frameId&capturedAt=$time"
        $bytes = $stream.ToArray()
        try { [void](Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType 'image/png' -Body $bytes -TimeoutSec 8) }
        catch { [void](Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType 'image/png' -Body $bytes -TimeoutSec 8) }
    } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
}
Write-Host 'Connected. Capture starts only on controller commands. Keep this window open; Ctrl+C exits.'
try {
    while ($true) {
        $poll = Invoke-RestMethod -Uri "$base/api/source/poll?ack=$ack" -Headers $headers -TimeoutSec 8
        $command = $poll.command
        if ($null -ne $command -and $command.id -ne $lastCommand) {
            $lastCommand = $command.id; $ack = $command.id
            if ($command.type -eq 'capture') {
                $script:batch = $command.batch; $script:count = 0
                $script:nextShot = $watch.ElapsedMilliseconds
                if ($script:batch.mode -ne 'single') { $script:nextShot += 1000 }
            } elseif ($command.type -eq 'stop') { Finish-Batch }
            elseif ($command.type -eq 'exit') { Finish-Batch; break }
            elseif ($command.type -eq 'region') {
                $r = $command.region
                $X = [int]$r.x; $Y = [int]$r.y; $Width = [int]$r.width; $Height = [int]$r.height
            }
            elseif ($command.type -eq 'question') { [void](Post-Json '/api/source/question' @{ text = $command.text; batchId = $command.batchId }) }
        }
        if ($null -ne $script:batch -and $watch.ElapsedMilliseconds -ge $script:nextShot) {
            try {
                Send-Screenshot; $script:count++
                if ($script:batch.mode -eq 'single' -or ($script:batch.mode -eq 'five' -and $script:count -ge 5)) { Finish-Batch }
                else { $script:nextShot = [Math]::Max(($script:nextShot + 1000),$watch.ElapsedMilliseconds) }
            } catch { $message = $_.Exception.Message; Finish-Batch $message; Write-Warning $message }
        }
        Start-Sleep -Milliseconds 150
    }
} finally { try { Finish-Batch 'Capture agent stopped' } catch {} }
