; The installer of the Divvun keyboard text service, the TSF text input
; processor built from kbdgen's crates/kbd-tsf. Keyboard installers embed it
; and run it silently before registering any layout (kbdgen spec
; tsf.installer.bundle); actions/kbd-tsf/installer.ts compiles it.
;
; Defines (ISCC /D):
;   TipVersion  the kbd-tsf package version the DLLs were built with
;   PayloadDir  the directory `kbdgen tsf` wrote the four DLLs to
;   Sign        set when ISCC is given a `signtool` (/S) to sign with
;   Clsid       the text service's CLSID; a test build's KBD_TSF_CLSID
;   AppGuid     the installer's AppId, without braces; a test build's own
;
; Every version goes into its own directory under the 64-bit
; %ProgramFiles%, which DllRegisterServer insists on
; (tsf.register.upgrade, tsf.security.appcontainer). Files there inherit the
; %ProgramFiles% ACL, which grants read and execute to both package SIDs; a
; successful registration is the check that they do. Registering the new
; version points InprocServer32 at it, after which older version
; directories are deleted, or deleted at restart while a process still has
; one of their DLLs loaded.
;
; Exit codes beyond Inno's own: 10 when a DLL failed to register. Setup
; refuses to start (Inno's exit code for a failed InitializeSetup) when a
; newer version is registered: it upgrades but never downgrades.
;
; The uninstaller refuses while any language profile remains under the
; CLSID in CTF\TIP, so removing one keyboard never breaks another
; (tsf.register.uninstall). Keyboard uninstallers run it after kbdi has
; removed their profiles; the last one removes the text service.

#ifndef TipVersion
  #error Define TipVersion, the kbd-tsf package version
#endif
#ifndef PayloadDir
  #error Define PayloadDir, the directory holding the four text service DLLs
#endif
#ifndef Clsid
  #define Clsid "{5E668C8A-2FB8-41D2-90B1-9C132653FA9D}"
#endif
#ifndef AppGuid
  #define AppGuid "D75B9208-31F3-44DA-9F6F-CD1AD320E17A"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "divvun-tip"
#endif

[Setup]
AppId={{{#AppGuid}}
AppName=Divvun Text Service
AppVersion={#TipVersion}
AppVerName=Divvun Text Service {#TipVersion}
AppPublisher=Divvun
AppPublisherURL=https://divvun.no/
UninstallDisplayName=Divvun Text Service
DefaultDirName={commonpf}\Divvun\Text Service
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
CreateUninstallRegKey=yes
PrivilegesRequired=admin
; Every Windows a keyboard installer accepts (tsf.installer.layout-dlls),
; and Arm64 Windows 10 besides, where the text service needs no x64 code.
ArchitecturesAllowed=x86os or x64os or arm64
ArchitecturesInstallIn64BitMode=x64os or arm64
MinVersion=6.3.9200
; Never close or restart the processes that have the text service loaded:
; nothing here overwrites a loaded file.
CloseApplications=no
RestartApplications=no
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
#ifdef Sign
SignTool=signtool
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; A version directory's contents never change, so an existing file is that
; version's and stays: a loaded DLL cannot be overwritten anyway.
Source: "{#PayloadDir}\divvun_tip_x86.dll"; DestDir: "{app}\{#TipVersion}"; Flags: onlyifdoesntexist uninsrestartdelete
Source: "{#PayloadDir}\divvun_tip_x64.dll"; DestDir: "{app}\{#TipVersion}"; Flags: onlyifdoesntexist uninsrestartdelete; Check: Is64BitInstallMode
Source: "{#PayloadDir}\divvun_tip_arm64.dll"; DestDir: "{app}\{#TipVersion}"; Flags: onlyifdoesntexist uninsrestartdelete; Check: IsArm64
Source: "{#PayloadDir}\divvun_tip.dll"; DestDir: "{app}\{#TipVersion}"; Flags: onlyifdoesntexist uninsrestartdelete; Check: IsArm64

[Code]
const
  Clsid = '{#Clsid}';
  TipVersion = '{#TipVersion}';
  RegistrationFailedExitCode = 10;

var
  RegistrationFailed: Boolean;

{ Removes and returns S up to the first Sep; all of S if there is none. }
function TakeUntil(var S: String; Sep: String): String;
var
  P: Integer;
begin
  P := Pos(Sep, S);
  if P = 0 then
  begin
    Result := S;
    S := '';
  end else
  begin
    Result := Copy(S, 1, P - 1);
    Delete(S, 1, P);
  end;
end;

{ S up to the first Sep; all of S if there is none. Assigning TakeUntil's
  result to the variable it takes loses the result in Pascal Script. }
function Before(S: String; Sep: String): String;
begin
  Result := S;
  if Pos(Sep, S) > 0 then
    Result := Copy(S, 1, Pos(Sep, S) - 1);
end;

function IsNumeric(S: String): Boolean;
var
  I: Integer;
begin
  Result := S <> '';
  for I := 1 to Length(S) do
    if (S[I] < '0') or (S[I] > '9') then
      Result := False;
end;

function SignOf(N: Integer): Integer;
begin
  if N < 0 then
    Result := -1
  else if N > 0 then
    Result := 1
  else
    Result := 0;
end;

{ Compares two dot-separated identifiers as SemVer does: numbers by value
  (any length), numbers below names, names by ASCII. }
function CompareIdentifier(A, B: String): Integer;
begin
  if IsNumeric(A) and IsNumeric(B) then
  begin
    while (Length(A) > 1) and (A[1] = '0') do Delete(A, 1, 1);
    while (Length(B) > 1) and (B[1] = '0') do Delete(B, 1, 1);
    if Length(A) <> Length(B) then
      Result := SignOf(Length(A) - Length(B))
    else
      Result := SignOf(CompareStr(A, B));
  end
  else if IsNumeric(A) then
    Result := -1
  else if IsNumeric(B) then
    Result := 1
  else
    Result := SignOf(CompareStr(A, B));
end;

{ Compares two SemVer versions, such as 0.1.0 and the 0.1.0-dev.<timestamp>
  of a development build; build metadata is ignored. }
function CompareVersion(A, B: String): Integer;
var
  CoreA, CoreB: String;
  I: Integer;
begin
  A := Before(A, '+');
  B := Before(B, '+');
  CoreA := TakeUntil(A, '-');
  CoreB := TakeUntil(B, '-');
  Result := 0;
  for I := 1 to 3 do
  begin
    Result := CompareIdentifier(TakeUntil(CoreA, '.'), TakeUntil(CoreB, '.'));
    if Result <> 0 then
      Exit;
  end;
  if (A = '') and (B = '') then
    Exit;
  if A = '' then
  begin
    Result := 1;
    Exit;
  end;
  if B = '' then
  begin
    Result := -1;
    Exit;
  end;
  while (A <> '') or (B <> '') do
  begin
    if A = '' then
    begin
      Result := -1;
      Exit;
    end;
    if B = '' then
    begin
      Result := 1;
      Exit;
    end;
    Result := CompareIdentifier(TakeUntil(A, '.'), TakeUntil(B, '.'));
    if Result <> 0 then
      Exit;
  end;
end;

{ The version whose DLL InprocServer32 names: the name of its directory.
  The 64-bit view's row is the one the categories go with; on x86 Windows
  there is only one view. Empty when the text service is not registered. }
function RegisteredVersion: String;
var
  Key, Server: String;
  Found: Boolean;
begin
  Result := '';
  Key := 'SOFTWARE\Classes\CLSID\' + Clsid + '\InprocServer32';
  if IsWin64 then
    Found := RegQueryStringValue(HKLM64, Key, '', Server)
  else
    Found := RegQueryStringValue(HKLM, Key, '', Server);
  if Found and (Server <> '') then
    Result := ExtractFileName(ExtractFileDir(Server));
end;

function InitializeSetup: Boolean;
var
  Installed: String;
begin
  Result := True;
  Installed := RegisteredVersion;
  Log('Registered text service version: ' + Installed);
  if (Installed <> '') and (CompareVersion(Installed, TipVersion) > 0) then
  begin
    Log('Not downgrading the text service from ' + Installed + ' to ' + TipVersion);
    SuppressibleMsgBox('Divvun Text Service ' + Installed + ' is newer than ' + TipVersion + ' and stays installed.', mbInformation, MB_OK, IDOK);
    Result := False;
  end;
end;

{ Runs regsvr32 silently; True if it registered (or unregistered) the DLL. }
function RegSvr32(Exe, Args, Dll: String): Boolean;
var
  Code: Integer;
begin
  Result := False;
  if not FileExists(Dll) then
    Exit;
  if not Exec(Exe, Args + ' /s "' + Dll + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := -1;
  Log(Exe + ' ' + Args + ' ' + Dll + ': exit code ' + IntToStr(Code));
  Result := Code = 0;
end;

{ The regsvr32 of the 32-bit view: SysWOW64's on 64-bit Windows. }
function RegSvr32X86: String;
begin
  if IsWin64 then
    Result := ExpandConstant('{syswow64}\regsvr32.exe')
  else
    Result := ExpandConstant('{sys}\regsvr32.exe');
end;

{ The native DLL that writes the 64-bit view and owns the categories
  (tsf.arch.registration), or '' on x86 Windows. }
function NativeDll(Dir: String): String;
begin
  if IsArm64 then
    Result := Dir + '\divvun_tip_arm64.dll'
  else if IsWin64 then
    Result := Dir + '\divvun_tip_x64.dll'
  else
    Result := '';
end;

{ Deletes Dir and everything in it; files a process has loaded, and the
  directories holding them, go at the next restart instead. }
procedure DeleteTree(Dir: String);
var
  Find: TFindRec;
  Path: String;
begin
  if FindFirst(Dir + '\*', Find) then
  try
    repeat
      if (Find.Name <> '.') and (Find.Name <> '..') then
      begin
        Path := Dir + '\' + Find.Name;
        if Find.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then
          DeleteTree(Path)
        else if not DeleteFile(Path) then
        begin
          Log('In use, deleting at restart: ' + Path);
          RestartReplace(Path, '');
        end;
      end;
    until not FindNext(Find);
  finally
    FindClose(Find);
  end;
  if not RemoveDir(Dir) then
    RestartReplace(Dir, '');
end;

{ Deletes every version directory in the app directory but Keep's. }
procedure DeleteVersionsExcept(Keep: String);
var
  Find: TFindRec;
  App: String;
begin
  App := ExpandConstant('{app}');
  if FindFirst(App + '\*', Find) then
  try
    repeat
      if (Find.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0) and
         (Find.Name <> '.') and (Find.Name <> '..') and
         (CompareText(Find.Name, Keep) <> 0) then
      begin
        Log('Deleting text service version directory ' + Find.Name);
        DeleteTree(App + '\' + Find.Name);
      end;
    until not FindNext(Find);
  finally
    FindClose(Find);
  end;
end;

{ Registers the 32-bit view first, then the native DLL that owns the
  categories, so a failure leaves any older version's registration in
  place. Older versions are deleted only once both point at this one. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  Dir: String;
begin
  if CurStep <> ssPostInstall then
    Exit;
  Dir := ExpandConstant('{app}\' + TipVersion);
  RegistrationFailed := not RegSvr32(RegSvr32X86, '', Dir + '\divvun_tip_x86.dll');
  if not RegistrationFailed and IsWin64 then
    RegistrationFailed := not RegSvr32(ExpandConstant('{sys}\regsvr32.exe'), '', NativeDll(Dir));
  if RegistrationFailed then
    Log('The text service did not register; keeping older versions')
  else
    DeleteVersionsExcept(TipVersion);
end;

function GetCustomSetupExitCode: Integer;
begin
  if RegistrationFailed then
    Result := RegistrationFailedExitCode
  else
    Result := 0;
end;

{ Whether a keyboard still has a language profile under the CLSID. CTF\TIP
  is shared between the registry views. }
function ProfilesRemain: Boolean;
var
  Key: String;
  Languages, Profiles: TArrayOfString;
  I: Integer;
begin
  Result := False;
  Key := 'SOFTWARE\Microsoft\CTF\TIP\' + Clsid + '\LanguageProfile';
  if not RegGetSubkeyNames(HKLM, Key, Languages) then
    Exit;
  for I := 0 to GetArrayLength(Languages) - 1 do
    if RegGetSubkeyNames(HKLM, Key + '\' + Languages[I], Profiles) and
       (GetArrayLength(Profiles) > 0) then
    begin
      Log('Language profile remains under ' + Languages[I]);
      Result := True;
    end;
end;

function InitializeUninstall: Boolean;
begin
  Result := not ProfilesRemain;
  if not Result and not UninstallSilent then
    MsgBox('Divvun keyboards still use the Divvun Text Service. Uninstall them first.', mbError, MB_OK);
end;

{ Unregisters every version's DLLs. Only the registered version's remove
  anything: another version's DllUnregisterServer leaves a registration
  naming a different path alone. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Find: TFindRec;
  App, Dir: String;
begin
  App := ExpandConstant('{app}');
  if FindFirst(App + '\*', Find) then
  try
    repeat
      if (Find.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0) and
         (Find.Name <> '.') and (Find.Name <> '..') then
      begin
        Dir := App + '\' + Find.Name;
        if CurUninstallStep = usUninstall then
        begin
          if IsWin64 then
            RegSvr32(ExpandConstant('{sys}\regsvr32.exe'), '/u', NativeDll(Dir));
          RegSvr32(RegSvr32X86, '/u', Dir + '\divvun_tip_x86.dll');
        end
        else if CurUninstallStep = usPostUninstall then
          DeleteTree(Dir);
      end;
    until not FindNext(Find);
  finally
    FindClose(Find);
  end;
end;
