# make-cert.ps1 -- generate a self-signed PFX for dsh-videocall
#
# Why: phones opening a LAN IP need HTTPS (secure context) before the browser
# will hand over the camera. This cert puts every saved network IP into SAN, so
# switching WiFi does NOT require regenerating the certificate.
#
# Usage:
#   pwsh -File tools/make-cert.ps1
#   pwsh -File tools/make-cert.ps1 -Ip 192.168.1.100
#   pwsh -File tools/make-cert.ps1 -Ips "192.168.1.100,10.0.0.5,172.16.0.9"
#   pwsh -File tools/make-cert.ps1 -Out certs/dev.pfx -Password secret
#
# Pure .NET, does not touch the Windows certificate store.

param(
  [string]$Ip = "",
  [string]$Ips = "",
  [string]$Out = "",
  [string]$Password = "dsh-videocall",
  [int]$Years = 2
)

$ErrorActionPreference = "Stop"

# ---- collect IPs ----------------------------------------------------------
$ipList = @()
if ($Ips) {
  $ipList += ($Ips -split '[,;\s]+' | Where-Object { $_ -and $_ -match '^\d{1,3}(\.\d{1,3}){3}$' })
}
if ($Ip) {
  if ($Ip -match '^\d{1,3}(\.\d{1,3}){3}$') { $ipList += $Ip }
}

if ($ipList.Count -eq 0) {
  $auto = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
    Sort-Object -Property SkipAsSource, InterfaceIndex |
    Select-Object -First 1 -ExpandProperty IPAddress)
  if (-not $auto) { throw "No LAN IP found. Pass -Ip or -Ips explicitly." }
  $ipList += $auto
}

$ipList = $ipList | Select-Object -Unique
Write-Host ("IPs in SAN: " + ($ipList -join ", "))

# ---- output path ----------------------------------------------------------
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Out) { $Out = Join-Path $root "certs\dev.pfx" }
$outDir = Split-Path -Parent $Out
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# ---- build the certificate ------------------------------------------------
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=dsh-videocall",
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )

  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  foreach ($a in $ipList) {
    try { $san.AddIpAddress([System.Net.IPAddress]::Parse($a)) } catch { Write-Host ("  skip bad IP: " + $a) }
  }
  $san.AddIpAddress([System.Net.IPAddress]::Loopback)
  $san.AddDnsName("localhost")
  $san.AddDnsName("dsh-videocall.local")
  $req.CertificateExtensions.Add($san.Build())

  $ekuColl = [System.Security.Cryptography.OidCollection]::new()
  $ekuColl.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1")) | Out-Null
  $eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($ekuColl, $false)
  $req.CertificateExtensions.Add($eku)

  $bc = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $false)
  $req.CertificateExtensions.Add($bc)

  $cert = $req.CreateSelfSigned(
    [DateTimeOffset]::UtcNow.AddDays(-1),
    [DateTimeOffset]::UtcNow.AddYears($Years)
  )

  $pfx = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $Password)
  [System.IO.File]::WriteAllBytes($Out, $pfx)

  Write-Host ("PFX written: " + $Out)
  Write-Host "  subject : CN=dsh-videocall"
  Write-Host ("  SAN IPs : " + ($ipList -join ", ") + ", 127.0.0.1")
  Write-Host "  SAN DNS : localhost, dsh-videocall.local"
  Write-Host ("  valid   : " + $Years + " year(s) from today")
  Write-Host ("  password: " + $Password)
} finally {
  $rsa.Dispose()
}
