@echo off
echo Launching Zoom as ZoomUser...
echo.
echo First time: Enter password "Zoom1132!" - it will be saved for next time.
echo.
runas /savecred /user:ZoomUser "C:\Program Files\Zoom\bin\Zoom.exe"
