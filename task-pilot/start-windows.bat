@echo off
rem Double-click to start the Task Pilot server on Windows.
setlocal
cd /d "%~dp0"
title Task Pilot server

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install the LTS version from https://nodejs.org, then double-click this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing Task Pilot - first run only, this takes a minute...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Created your settings file. It is opening in Notepad now.
  echo Fill it in, save it, close Notepad, then double-click this file again.
  notepad .env
  exit /b 0
)

echo.
echo Starting Task Pilot. Keep this window open - you can minimise it.
echo Closing this window stops the server.
echo.
call npm start
pause
