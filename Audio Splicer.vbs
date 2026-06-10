' Launches the Audio Splicer app with no console window.
' The server opens its own app window and shuts itself down after the window closes.
Set sh = CreateObject("WScript.Shell")
appDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
sh.Run "node """ & appDir & "\app\server.mjs""", 0, False
