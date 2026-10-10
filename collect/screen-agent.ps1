param(
    [string]$ServerUrl,
    [string]$PairToken,
    [int]$X = 0, [int]$Y = 0, [int]$Width = 0, [int]$Height = 0,
    [switch]$SelectOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'ScreenAgent.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Net.Http,System.Web.Extensions
    [Shiye.AgentApp]::Initialize()
    $options = New-Object Shiye.AgentOptions
    $options.ServerUrl = $ServerUrl
    $options.PairToken = $PairToken
    $options.Region = New-Object System.Drawing.Rectangle($X, $Y, $Width, $Height)
    $options.LogPath = Join-Path $PSScriptRoot 'capture-agent.log'
    if ($SelectOnly) {
        $region = [Shiye.AgentApp]::SelectRegion($options.Region)
        if ($null -ne $region) { Write-Output "Fixed region: -X $($region.X) -Y $($region.Y) -Width $($region.Width) -Height $($region.Height)" }
    } else {
        [Shiye.AgentApp]::Run($options)
    }
} catch {
    $message = $_.Exception.ToString()
    Add-Content -LiteralPath (Join-Path $PSScriptRoot 'capture-agent.log') -Value $message -Encoding UTF8
    [void][System.Windows.Forms.MessageBox]::Show($message, 'Screen agent startup failed')
    throw
}
