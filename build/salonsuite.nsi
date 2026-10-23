!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "TextFunc.nsh"


!ifndef APP_VERSION
  !define APP_VERSION "0.2.0"
!endif

Unicode true
Name "Salón Suite ${APP_VERSION}"
OutFile "..\dist\SalonSuite-${APP_VERSION}-setup.exe"
InstallDir "$APPDATA\SalonSuite"
!ifdef TEST_NO_ADMIN
RequestExecutionLevel user
!else
RequestExecutionLevel highest
!endif
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\launcher.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Salón Suite"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"

Var IsAdmin

Function .onInit
  System::Call 'shell32::IsUserAnAdmin() i .r0'
  StrCpy $IsAdmin $0

  StrCpy $R7 "$LOCALAPPDATA\SalonSuite"
  StrCpy $R8 "$APPDATA\SalonSuite"

  ${If} $IsAdmin == 1
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}

  StrCpy $R6 "$APPDATA\SalonSuite"

  StrCmp $INSTDIR $R7 standard
  StrCmp $INSTDIR $R8 standard
  StrCmp $INSTDIR $R6 standard
  Goto done

  standard:
  ${If} $IsAdmin == 1
    StrCpy $INSTDIR "$APPDATA\SalonSuite"
  ${Else}
    StrCpy $INSTDIR "$LOCALAPPDATA\SalonSuite"
  ${EndIf}

  ReadRegStr $0 HKCU "Software\SalonSuite" "InstallPath"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "Software\SalonSuite" "InstallPath"
  ${EndIf}
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}

  done:
FunctionEnd

Function un.onInit
  System::Call 'shell32::IsUserAnAdmin() i .r0'
  StrCpy $IsAdmin $0
  ${If} $IsAdmin == 1
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
FunctionEnd

Section "Salón Suite" SecMain
  SetOutPath "$INSTDIR"

  ${If} $IsAdmin == 1
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\SalonSuite" "ImagePath"
    ${If} $0 != ""
      nsExec::ExecToLog '"$INSTDIR\salonsuite-service.exe" stop'
      nsExec::ExecToLog '"$INSTDIR\salonsuite-service.exe" uninstall'
    ${EndIf}
  ${EndIf}

  IfFileExists "$INSTDIR\app\data\server.pid" 0 noRunning
    FileOpen $9 "$INSTDIR\app\data\server.pid" r
    FileRead $9 $8
    FileClose $9
    ${TrimNewLines} "$8" $8
    nsExec::ExecToLog 'taskkill /F /PID $8'
    Delete "$INSTDIR\app\data\server.pid"
  noRunning:

  File /r "..\pkg\runtime"
  SetOutPath "$INSTDIR\app"
  File /r /x .env "..\pkg\app\*.*"
  IfFileExists "$INSTDIR\app\.env" noEnv
    File /oname=.env "..\pkg\app\.env"
  noEnv:
  CreateDirectory "$INSTDIR\app\data"
  CreateDirectory "$INSTDIR\app\.license"
  IfFileExists "$INSTDIR\app\data\salon.db" noSeed
    SetOutPath "$INSTDIR\app\data"
    File /oname=salon.db "..\build\seed\salon.db"
  noSeed:

  SetOutPath "$INSTDIR"
  File /oname=launcher.exe "..\pkg\launcher.exe"
  File /oname=salonsuite-service.exe "..\build\installer\salonsuite-service.exe"
  File /oname=salonsuite-service.xml "..\build\installer\salonsuite-service.xml"

  ${If} $IsAdmin == 1
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "DisplayName" "Salón Suite ${APP_VERSION}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "Publisher" "Salón Suite"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "DisplayIcon" '"$INSTDIR\launcher.exe"'
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "InstallLocation" "$INSTDIR"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "NoModify" 1
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "NoRepair" 1
    WriteRegStr HKLM "Software\SalonSuite" "InstallPath" "$INSTDIR"
    WriteRegStr HKLM "Software\SalonSuite" "Version" "${APP_VERSION}"
  ${Else}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "DisplayName" "Salón Suite ${APP_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "Publisher" "Salón Suite"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "DisplayIcon" '"$INSTDIR\launcher.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite" "NoRepair" 1
    WriteRegStr HKCU "Software\SalonSuite" "InstallPath" "$INSTDIR"
    WriteRegStr HKCU "Software\SalonSuite" "Version" "${APP_VERSION}"
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Salón Suite"
  CreateShortCut "$SMPROGRAMS\Salón Suite\Salón Suite.lnk" "$INSTDIR\launcher.exe"
  CreateShortCut "$SMPROGRAMS\Salón Suite\Desinstalar Salón Suite.lnk" "$INSTDIR\uninstall.exe"

  ${If} $IsAdmin == 1
    nsExec::ExecToLog '"$INSTDIR\salonsuite-service.exe" install'
    nsExec::ExecToLog '"$INSTDIR\salonsuite-service.exe" start'
  ${EndIf}
SectionEnd

Section /o "Acceso directo en el escritorio" SecDesktop
  CreateShortCut "$DESKTOP\Salón Suite.lnk" "$INSTDIR\launcher.exe"
SectionEnd

Section "Uninstall"
  ${If} $IsAdmin == 1
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\SalonSuite" "ImagePath"
    ${If} $0 != ""
      nsExec::ExecToLog '"$INSTDIR\salonsuite-service.exe" stop'
      nsExec::ExecToLog '"$INSTDIR\salonsuite-service.exe" uninstall'
    ${EndIf}
  ${EndIf}

  IfFileExists "$INSTDIR\app\data\server.pid" 0 noUnRunning
    FileOpen $9 "$INSTDIR\app\data\server.pid" r
    FileRead $9 $8
    FileClose $9
    ${TrimNewLines} "$8" $8
    nsExec::ExecToLog 'taskkill /F /PID $8'
    Delete "$INSTDIR\app\data\server.pid"
  noUnRunning:

  Delete "$SMPROGRAMS\Salón Suite\Salón Suite.lnk"
  Delete "$SMPROGRAMS\Salón Suite\Desinstalar Salón Suite.lnk"
  RMDir "$SMPROGRAMS\Salón Suite"
  Delete "$DESKTOP\Salón Suite.lnk"

  Delete "$INSTDIR\launcher.exe"
  Delete "$INSTDIR\salonsuite-service.exe"
  Delete "$INSTDIR\salonsuite-service.xml"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\logs"

  MessageBox MB_YESNO|MB_ICONQUESTION "¿Conservar la base de datos y la licencia de este equipo?" /SD IDYES IDYES keepData IDNO deleteData

  deleteData:
  RMDir /r "$INSTDIR\app"
  Goto afterData

  keepData:
  RMDir /r "$INSTDIR\app\node_modules"
  RMDir /r "$INSTDIR\app\public"
  RMDir /r "$INSTDIR\app\src"
  RMDir /r "$INSTDIR\app\views"
  Delete "$INSTDIR\app\server.js"
  Delete "$INSTDIR\app\package.json"
  Delete "$INSTDIR\app\package-lock.json"
  Delete "$INSTDIR\app\.env"

  afterData:
  Delete "$INSTDIR\uninstall.exe"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SalonSuite"
  DeleteRegKey HKLM "Software\SalonSuite"
  DeleteRegKey HKCU "Software\SalonSuite"
  RMDir "$INSTDIR"
SectionEnd
