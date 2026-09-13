@echo off
cd /d "%~dp0"
REM Start the PYNX API and storefront server on port 5000.
node server/index.js
pause
