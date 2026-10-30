# Bluetooth helper for Speaker Queue (Windows). Prints JSON.
#   bluetooth.ps1 list                 -> paired devices + radio state
#   bluetooth.ps1 connect "<name>"     -> (re)connect a paired audio device by name
#   bluetooth.ps1 radio on             -> switch the Bluetooth radio on
param(
  [Parameter(Position = 0)] [string]$Action = 'list',
  [Parameter(Position = 1)] [string]$Name = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BtApi {
  [StructLayout(LayoutKind.Sequential)]
  public struct SYSTEMTIME { public ushort wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct BLUETOOTH_DEVICE_INFO {
    public uint dwSize;
    public ulong Address;
    public uint ulClassofDevice;
    [MarshalAs(UnmanagedType.Bool)] public bool fConnected;
    [MarshalAs(UnmanagedType.Bool)] public bool fRemembered;
    [MarshalAs(UnmanagedType.Bool)] public bool fAuthenticated;
    public SYSTEMTIME stLastSeen;
    public SYSTEMTIME stLastUsed;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string szName;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct BLUETOOTH_DEVICE_SEARCH_PARAMS {
    public uint dwSize;
    [MarshalAs(UnmanagedType.Bool)] public bool fReturnAuthenticated;
    [MarshalAs(UnmanagedType.Bool)] public bool fReturnRemembered;
    [MarshalAs(UnmanagedType.Bool)] public bool fReturnUnknown;
    [MarshalAs(UnmanagedType.Bool)] public bool fReturnConnected;
    [MarshalAs(UnmanagedType.Bool)] public bool fIssueInquiry;
    public byte cTimeoutMultiplier;
    public IntPtr hRadio;
  }
  [DllImport("bthprops.cpl", SetLastError = true)] public static extern IntPtr BluetoothFindFirstDevice(ref BLUETOOTH_DEVICE_SEARCH_PARAMS p, ref BLUETOOTH_DEVICE_INFO info);
  [DllImport("bthprops.cpl", SetLastError = true)] public static extern bool BluetoothFindNextDevice(IntPtr h, ref BLUETOOTH_DEVICE_INFO info);
  [DllImport("bthprops.cpl", SetLastError = true)] public static extern bool BluetoothFindDeviceClose(IntPtr h);
  [DllImport("bthprops.cpl", SetLastError = true)] public static extern uint BluetoothSetServiceState(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO info, ref Guid guid, uint flags);
}
'@

function Get-Devices {
  $list = New-Object System.Collections.ArrayList
  $p = New-Object BtApi+BLUETOOTH_DEVICE_SEARCH_PARAMS
  $p.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][BtApi+BLUETOOTH_DEVICE_SEARCH_PARAMS])
  $p.fReturnAuthenticated = $true; $p.fReturnRemembered = $true; $p.fReturnConnected = $true
  $p.fReturnUnknown = $false; $p.fIssueInquiry = $false; $p.cTimeoutMultiplier = 1; $p.hRadio = [IntPtr]::Zero
  $info = New-Object BtApi+BLUETOOTH_DEVICE_INFO
  $info.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][BtApi+BLUETOOTH_DEVICE_INFO])
  $h = [BtApi]::BluetoothFindFirstDevice([ref]$p, [ref]$info)
  if ($h -eq [IntPtr]::Zero) { return @() }
  do {
    $major = ($info.ulClassofDevice -shr 8) -band 0x1F
    [void]$list.Add([pscustomobject]@{
      name = $info.szName
      address = ('{0:X12}' -f $info.Address)
      connected = [bool]$info.fConnected
      remembered = [bool]$info.fRemembered
      authenticated = [bool]$info.fAuthenticated
      audio = ($major -eq 4)
      raw = $info
    })
    $info = New-Object BtApi+BLUETOOTH_DEVICE_INFO
    $info.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][BtApi+BLUETOOTH_DEVICE_INFO])
  } while ([BtApi]::BluetoothFindNextDevice($h, [ref]$info))
  [void][BtApi]::BluetoothFindDeviceClose($h)
  return $list
}

function Get-RadioState {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $asTask = $asTaskGeneric.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
    $task = $asTask.Invoke($null, @([Windows.Devices.Radios.Radio]::GetRadiosAsync()))
    $task.Wait(5000) | Out-Null
    $bt = $task.Result | Where-Object { $_.Kind -eq 'Bluetooth' } | Select-Object -First 1
    if ($null -eq $bt) { return 'none' }
    return [string]$bt.State
  } catch { return 'unknown' }
}

function Set-RadioOn {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $asTask = $asTaskGeneric.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  $task = $asTask.Invoke($null, @([Windows.Devices.Radios.Radio]::GetRadiosAsync()))
  $task.Wait(5000) | Out-Null
  $bt = $task.Result | Where-Object { $_.Kind -eq 'Bluetooth' } | Select-Object -First 1
  if ($null -eq $bt) { throw 'No Bluetooth radio found' }
  $asTask2 = $asTaskGeneric.MakeGenericMethod([Windows.Devices.Radios.RadioAccessStatus])
  $t2 = $asTask2.Invoke($null, @($bt.SetStateAsync([Windows.Devices.Radios.RadioState]::On)))
  $t2.Wait(8000) | Out-Null
  return [string]$t2.Result
}

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 4 }

switch ($Action.ToLower()) {
  'list' {
    $devs = Get-Devices | ForEach-Object { [pscustomobject]@{ name = $_.name; address = $_.address; connected = $_.connected; audio = $_.audio } }
    Out-Json ([pscustomobject]@{ ok = $true; radio = (Get-RadioState); devices = @($devs) })
  }
  'radio' {
    try { $r = Set-RadioOn; Out-Json ([pscustomobject]@{ ok = $true; result = $r }) }
    catch { Out-Json ([pscustomobject]@{ ok = $false; error = $_.Exception.Message }) }
  }
  'connect' {
    $dev = Get-Devices | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if ($null -eq $dev) { Out-Json ([pscustomobject]@{ ok = $false; error = "'$Name' is not paired with this PC. Pair it once in Windows Bluetooth settings." }); exit 0 }
    if ($dev.connected) { Out-Json ([pscustomobject]@{ ok = $true; connected = $true; note = 'already connected' }); exit 0 }
    $info = $dev.raw
    $a2dp = [Guid]'0000110B-0000-1000-8000-00805F9B34FB'   # Audio Sink (A2DP)
    $hfp  = [Guid]'0000111E-0000-1000-8000-00805F9B34FB'   # Hands-free
    $codes = @()
    # Toggling the audio service off and on makes Windows (re)connect the device.
    $codes += [BtApi]::BluetoothSetServiceState([IntPtr]::Zero, [ref]$info, [ref]$a2dp, 0)
    Start-Sleep -Milliseconds 400
    $codes += [BtApi]::BluetoothSetServiceState([IntPtr]::Zero, [ref]$info, [ref]$a2dp, 1)
    $codes += [BtApi]::BluetoothSetServiceState([IntPtr]::Zero, [ref]$info, [ref]$hfp, 1)
    $connected = $false
    for ($i = 0; $i -lt 12 -and -not $connected; $i++) {
      Start-Sleep -Milliseconds 1000
      $again = Get-Devices | Where-Object { $_.name -eq $Name } | Select-Object -First 1
      if ($null -ne $again -and $again.connected) { $connected = $true }
    }
    $err = $null
    if (-not $connected) { $err = "Could not connect. Is '$Name' switched on, in range, and not connected to another device?" }
    Out-Json ([pscustomobject]@{ ok = $connected; connected = $connected; codes = $codes; error = $err })
  }
  'disconnect' {
    $dev = Get-Devices | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if ($null -eq $dev) { Out-Json ([pscustomobject]@{ ok = $false; error = "'$Name' is not paired with this PC." }); exit 0 }
    $info = $dev.raw
    $a2dp = [Guid]'0000110B-0000-1000-8000-00805F9B34FB'
    $hfp  = [Guid]'0000111E-0000-1000-8000-00805F9B34FB'
    # Disabling the audio services drops the link. They stay disabled until the next 'connect',
    # so the speaker can be used with another device meanwhile.
    $c1 = [BtApi]::BluetoothSetServiceState([IntPtr]::Zero, [ref]$info, [ref]$a2dp, 0)
    $c2 = [BtApi]::BluetoothSetServiceState([IntPtr]::Zero, [ref]$info, [ref]$hfp, 0)
    $gone = $false
    for ($i = 0; $i -lt 8 -and -not $gone; $i++) {
      Start-Sleep -Milliseconds 800
      $again = Get-Devices | Where-Object { $_.name -eq $Name } | Select-Object -First 1
      if ($null -eq $again -or -not $again.connected) { $gone = $true }
    }
    Out-Json ([pscustomobject]@{ ok = $gone; connected = (-not $gone); codes = @($c1, $c2) })
  }
  default { Out-Json ([pscustomobject]@{ ok = $false; error = "unknown action $Action" }) }
}
