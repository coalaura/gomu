@echo off

if not exist bin (
	mkdir bin
)

go build -C .\analyzer -o ..\bin\gomu-win32-x64.exe