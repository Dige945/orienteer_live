@echo off
set "CLOUDFLARED="
for /f "delims=" %%I in ('where cloudflared 2^>nul') do if not defined CLOUDFLARED set "CLOUDFLARED=%%I"
if not defined CLOUDFLARED if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" set "CLOUDFLARED=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not defined CLOUDFLARED (
  echo cloudflared was not found.
  echo.
  echo Install it first:
  echo   winget install Cloudflare.cloudflared
  echo.
  echo Or download it from:
  echo   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  echo.
  pause
  exit /b 1
)

echo Starting Cloudflare Tunnel for http://localhost:3000 ...
echo.
echo Keep this window open while phones are connected.
echo Copy the https://*.trycloudflare.com URL into the Android app server field.
echo Using HTTP/2 transport for better compatibility on networks that block QUIC/UDP.
echo.
"%CLOUDFLARED%" tunnel --protocol http2 --url http://localhost:3000
