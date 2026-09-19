@echo off
title Orion Social — Orion Key bridge (:8790)
cd /d "%~dp0"
python main.py
if errorlevel 1 pause
