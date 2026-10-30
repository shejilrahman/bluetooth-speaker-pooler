netsh advfirewall firewall delete rule name="BT Speaker Pooler" | Out-Null
netsh advfirewall firewall add rule name="BT Speaker Pooler" dir=in action=allow protocol=TCP localport=3010 profile=private,domain,public | Out-Null
# keep the PC awake: no sleep/hibernate on power or battery, closing the lid does nothing
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
Set-Content -Path 'D:\bluetooth speaker pooler\dist\bin\admin-setup.done' -Value (Get-Date)