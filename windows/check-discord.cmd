@echo off
rem Checks the Discord app setup and creates the Activity launch command if missing.
cd /d "%~dp0.."
echo Paste your bot token (Developer Portal - your app - Bot - Reset Token)
echo and press Enter. It is only used for this check and is not saved.
set /p DISCORD_BOT_TOKEN=Bot token: 
node server\check-discord.js
set DISCORD_BOT_TOKEN=
pause
