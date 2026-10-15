@echo off
rem Starts the streamer in this window; restarts it if it crashes.
rem Logs are also written to logs\bot.log. Press Ctrl+C to stop.
cd /d "%~dp0.."
node src\supervisor.js
