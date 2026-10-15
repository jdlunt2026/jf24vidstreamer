@echo off
rem Starts the Activity server in this window; restarts it if it crashes.
rem Logs are also written to logs\server.log. Press Ctrl+C to stop.
cd /d "%~dp0.."
node server\supervisor.js
