@echo off
chcp 65001 >nul
rem .c4d-Dateien auf diese Datei ziehen. Die .glb landet neben der .c4d,
rem danach oeffnet sich die Upload-Seite zum Reinziehen.
if "%~1"=="" (
  echo Zieh eine oder mehrere .c4d-Dateien auf diese Datei.
  pause
  exit /b
)
set "C4DPY=C:\Program Files\Maxon Cinema 4D 2026\c4dpy.exe"
if not exist "%C4DPY%" (
  echo c4dpy nicht gefunden: %C4DPY%
  pause
  exit /b
)
echo Konvertiere mit Cinema 4D ... das dauert beim ersten Mal ca. 30 Sekunden.
"%C4DPY%" "%~dp0c4d_zu_glb.py" %* 2>nul | findstr /b /c:"OK" /c:"FEHLER" /c:"FERTIG" /c:"Keine"
explorer /select,"%~dpn1.glb"
start "" "https://knappmedia.github.io/3d/upload.html"
pause
