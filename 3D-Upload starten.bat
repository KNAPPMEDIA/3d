@echo off
chcp 65001 >nul
title 3D-Upload - Fenster offen lassen
cd /d "%~dp0"
node uploader\server.mjs --open
if errorlevel 1 pause
