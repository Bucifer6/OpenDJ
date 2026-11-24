; OpenDJ: extra NSIS installer logic (electron-builder "nsis.include").
;
; Each Windows installer only carries the app for its own processor (the x64 one, the ARM64 one; the combined
; OpenDJ-Setup-<version>.exe carries both). Run on the wrong kind of PC, electron-builder's installer extracted
; nothing, still wrote the uninstaller and the shortcuts, and defaulted to "C:\Program Files (x86)": a folder with
; only the uninstaller and a shortcut to an OpenDJ.exe that isn't there. Stop before anything is installed instead,
; and say which file to download.

!macro customInit
  !ifdef APP_ARM64
    !ifndef APP_64
      ${IfNot} ${IsNativeARM64}
        MessageBox MB_OK|MB_ICONSTOP "This OpenDJ installer is for Windows on ARM (e.g. Snapdragon laptops), but this PC has an Intel or AMD processor.$\r$\n$\r$\nPlease download OpenDJ-Setup-${VERSION}-x64.exe, or OpenDJ-Setup-${VERSION}.exe (works on every PC), from the OpenDJ release page.$\r$\n$\r$\nNothing was installed." /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    !endif
  !endif
  !ifndef APP_32
    ${IfNot} ${RunningX64}
    ${AndIfNot} ${IsNativeARM64}
      MessageBox MB_OK|MB_ICONSTOP "OpenDJ needs 64-bit Windows 10 or 11.$\r$\n$\r$\nNothing was installed." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  !endif
!macroend
