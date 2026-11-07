// Names AutoHotkey defines before any script code runs.
// Functions and classes: the top-level declarations in the AutoHotkey v2 language server's ahk2.d.ahk
// (thqby/vscode-autohotkey2-lsp), each confirmed to exist in AutoHotkey 2.1-alpha.37 by reading it
// with %name%, plus console-edition additions found the same way. IsSet is syntax rather than a
// function value, and StructFromPtr comes from a newer alpha; both are kept so they are never flagged.

export const BUILTIN_FUNCTIONS: readonly string[] = [
    '_ScriptGetLines', 'Abs', 'ACos', 'ASin', 'ATan', 'ATan2', 'BlockInput', 'CallbackCreate', 'CallbackFree',
    'CaretGetPos', 'Ceil', 'Check', 'Chr', 'Click', 'ClipWait', 'ComCall', 'ComObjActive', 'ComObjConnect',
    'ComObjFlags', 'ComObjFromPtr', 'ComObjGet', 'ComObjQuery', 'ComObjType', 'ComObjValue', 'ControlAddItem',
    'ControlChooseIndex', 'ControlChooseString', 'ControlClick', 'ControlDeleteItem', 'ControlFindItem',
    'ControlFocus', 'ControlGetChecked', 'ControlGetChoice', 'ControlGetClassNN', 'ControlGetEnabled',
    'ControlGetExStyle', 'ControlGetFocus', 'ControlGetHwnd', 'ControlGetIndex', 'ControlGetItems', 'ControlGetPos',
    'ControlGetStyle', 'ControlGetText', 'ControlGetVisible', 'ControlHide', 'ControlHideDropDown', 'ControlMove',
    'ControlSend', 'ControlSendText', 'ControlSetChecked', 'ControlSetEnabled', 'ControlSetExStyle',
    'ControlSetStyle', 'ControlSetText', 'ControlShow', 'ControlShowDropDown', 'CoordMode', 'Cos', 'Critical',
    'DateAdd', 'DateDiff', 'DetectHiddenText', 'DetectHiddenWindows', 'DirCopy', 'DirCreate', 'DirDelete', 'DirExist',
    'DirMove', 'DirSelect', 'DllCall', 'Download', 'DriveEject', 'DriveGetCapacity', 'DriveGetFileSystem',
    'DriveGetLabel', 'DriveGetList', 'DriveGetSerial', 'DriveGetSpaceFree', 'DriveGetStatus', 'DriveGetStatusCD',
    'DriveGetType', 'DriveLock', 'DriveRetract', 'DriveSetLabel', 'DriveUnlock', 'Edit', 'EditGetCurrentCol',
    'EditGetCurrentLine', 'EditGetLine', 'EditGetLineCount', 'EditGetSelectedText', 'EditPaste', 'EnvGet', 'EnvSet',
    'Eval', 'Exit', 'ExitApp', 'Exp', 'FileAppend', 'FileCopy', 'FileCreateShortcut', 'FileDelete', 'FileEncoding',
    'FileExist', 'FileGetAttrib', 'FileGetShortcut', 'FileGetSize', 'FileGetTime', 'FileGetVersion', 'FileInstall',
    'FileMove', 'FileOpen', 'FileRead', 'FileRecycle', 'FileRecycleEmpty', 'FileSelect', 'FileSetAttrib',
    'FileSetTime', 'Floor', 'Format', 'FormatTime', 'GetKeyName', 'GetKeySC', 'GetKeyState', 'GetKeyVK', 'GetMethod',
    'GroupActivate', 'GroupAdd', 'GroupClose', 'GroupDeactivate', 'GuiCtrlFromHwnd', 'GuiFromHwnd', 'HasBase',
    'HasMethod', 'HasProp', 'HotIf', 'HotIfWinActive', 'HotIfWinExist', 'HotIfWinNotActive', 'HotIfWinNotExist',
    'Hotkey', 'Hotstring', 'IL_Add', 'IL_Create', 'IL_Destroy', 'ImageSearch', 'IniDelete', 'IniRead', 'IniWrite',
    'InputBox', 'Inspect', 'InstallKeybdHook', 'InstallMouseHook', 'InStr', 'IsAlnum', 'IsAlpha', 'IsDigit',
    'IsFloat', 'IsInteger', 'IsLabel', 'IsLower', 'IsNumber', 'IsObject', 'IsSet', 'IsSetRef', 'IsSpace', 'IsTime',
    'IsUpper', 'IsXDigit', 'KeyHistory', 'KeyWait', 'ListHotkeys', 'ListLines', 'ListVars', 'ListViewGetContent',
    'Ln', 'LoadPicture', 'Log', 'LTrim', 'Max', 'MenuFromHandle', 'MenuSelect', 'Min', 'Mod', 'MonitorGet',
    'MonitorGetCount', 'MonitorGetName', 'MonitorGetPrimary', 'MonitorGetWorkArea', 'MouseClick', 'MouseClickDrag',
    'MouseGetPos', 'MouseMove', 'MsgBox', 'NumGet', 'NumPut', 'ObjAddRef', 'ObjBindMethod', 'ObjFromPtr',
    'ObjFromPtrAddRef', 'ObjGetBase', 'ObjGetCapacity', 'ObjGetDataPtr', 'ObjGetDataSize', 'ObjHasOwnProp',
    'ObjOwnPropCount', 'ObjOwnProps', 'ObjPtr', 'ObjPtrAddRef', 'ObjRelease', 'ObjSetBase', 'ObjSetCapacity',
    'ObjSetDataPtr', 'OnClipboardChange', 'OnError', 'OnExit', 'OnMessage', 'Ord', 'OutputDebug', 'Pause',
    'Persistent', 'PixelGetColor', 'PixelSearch', 'PostMessage', 'ProcessClose', 'ProcessExist', 'ProcessGetName',
    'ProcessGetParent', 'ProcessGetPath', 'ProcessSetPriority', 'ProcessWait', 'ProcessWaitClose', 'Props', 'Random',
    'RegCreateKey', 'RegDelete', 'RegDeleteKey', 'RegExMatch', 'RegExReplace', 'RegRead', 'RegWrite', 'Reload',
    'Round', 'RTrim', 'Run', 'RunAs', 'RunWait', 'Send', 'SendEvent', 'SendInput', 'SendLevel', 'SendMessage',
    'SendMode', 'SendPlay', 'SendText', 'SetCapsLockState', 'SetControlDelay', 'SetDefaultMouseSpeed', 'SetKeyDelay',
    'SetMouseDelay', 'SetNumLockState', 'SetRegView', 'SetScrollLockState', 'SetStoreCapsLockMode', 'SetTimer',
    'SetTitleMatchMode', 'SetWinDelay', 'SetWorkingDir', 'Shutdown', 'Sin', 'Sleep', 'Sort', 'SoundBeep',
    'SoundGetInterface', 'SoundGetMute', 'SoundGetName', 'SoundGetVolume', 'SoundPlay', 'SoundSetMute',
    'SoundSetVolume', 'SplitPath', 'Sqrt', 'StatusBarGetText', 'StatusBarWait', 'StrCompare', 'StrGet', 'StrLen',
    'StrLower', 'StrPtr', 'StrPut', 'StrReplace', 'StrSplit', 'StrTitle', 'StructFromPtr', 'StrUpper', 'SubStr',
    'Suspend', 'SysGet', 'SysGetIPAddresses', 'Tan', 'Thread', 'Throw', 'ToolTip', 'TraySetIcon', 'TrayTip', 'Trim',
    'TSParse', 'Type', 'VarSetStrCapacity', 'VerCompare', 'WinActivate', 'WinActivateBottom', 'WinActive', 'WinClose',
    'WinExist', 'WinGetAlwaysOnTop', 'WinGetClass', 'WinGetClientPos', 'WinGetControls', 'WinGetControlsHwnd',
    'WinGetCount', 'WinGetEnabled', 'WinGetExStyle', 'WinGetID', 'WinGetIDLast', 'WinGetList', 'WinGetMinMax',
    'WinGetPID', 'WinGetPos', 'WinGetProcessName', 'WinGetProcessPath', 'WinGetStyle', 'WinGetText', 'WinGetTitle',
    'WinGetTransColor', 'WinGetTransparent', 'WinHide', 'WinKill', 'WinMaximize', 'WinMinimize', 'WinMinimizeAll',
    'WinMinimizeAllUndo', 'WinMove', 'WinMoveBottom', 'WinMoveTop', 'WinRedraw', 'WinRestore', 'WinSetAlwaysOnTop',
    'WinSetEnabled', 'WinSetExStyle', 'WinSetRegion', 'WinSetStyle', 'WinSetTitle', 'WinSetTransColor',
    'WinSetTransparent', 'WinShow', 'WinWait', 'WinWaitActive', 'WinWaitClose', 'WinWaitNotActive',
];

export const BUILTIN_CLASSES: readonly string[] = [
    'Any', 'Array', 'BoundFunc', 'Buffer', 'Class', 'ClipboardAll', 'Closure', 'ComObjArray', 'ComObject', 'ComValue',
    'ComValueRef', 'Enumerator', 'Error', 'File', 'Float', 'Func', 'Gui', 'IndexError', 'InputHook', 'Integer', 'Map',
    'MemberError', 'MemoryError', 'Menu', 'MenuBar', 'MethodError', 'Number', 'Object', 'OSError', 'Primitive',
    'PropertyError', 'PropRef', 'RegExMatchInfo', 'String', 'TargetError', 'TimeoutError', 'TypeError', 'UnsetError',
    'UnsetItemError', 'ValueError', 'VarRef', 'ZeroDivisionError',
];

/** Built-in variables (A_...) from the same declarations file. */
export const BUILTIN_VARIABLES: readonly string[] = [
    'A_AhkPath', 'A_AhkVersion', 'A_AllowMainWindow', 'A_AppData', 'A_AppDataCommon', 'A_Args', 'A_Clipboard',
    'A_ComSpec', 'A_ComputerName', 'A_ControlDelay', 'A_CoordModeCaret', 'A_CoordModeMenu', 'A_CoordModeMouse',
    'A_CoordModePixel', 'A_CoordModeToolTip', 'A_Cursor', 'A_DD', 'A_DDD', 'A_DDDD', 'A_DefaultMouseSpeed',
    'A_Desktop', 'A_DesktopCommon', 'A_DetectHiddenText', 'A_DetectHiddenWindows', 'A_EndChar', 'A_EventInfo',
    'A_FileEncoding', 'A_HotIf', 'A_HotkeyInterval', 'A_HotkeyModifierTimeout', 'A_Hour', 'A_IconFile',
    'A_IconHidden', 'A_IconNumber', 'A_IconTip', 'A_Index', 'A_InitialWorkingDir', 'A_Is64bitOS', 'A_IsAdmin',
    'A_IsCompiled', 'A_IsCritical', 'A_IsPaused', 'A_IsSuspended', 'A_KeyDelay', 'A_KeyDelayPlay', 'A_KeyDuration',
    'A_KeyDurationPlay', 'A_KeybdHookInstalled', 'A_Language', 'A_LastError', 'A_LineFile', 'A_LineNumber',
    'A_ListLines', 'A_LoopField', 'A_LoopFileAttrib', 'A_LoopFileDir', 'A_LoopFileExt', 'A_LoopFileFullPath',
    'A_LoopFileName', 'A_LoopFilePath', 'A_LoopFileShortName', 'A_LoopFileShortPath', 'A_LoopFileSize',
    'A_LoopFileSizeKB', 'A_LoopFileSizeMB', 'A_LoopFileTimeAccessed', 'A_LoopFileTimeCreated',
    'A_LoopFileTimeModified', 'A_LoopReadLine', 'A_LoopRegKey', 'A_LoopRegName', 'A_LoopRegTimeModified',
    'A_LoopRegType', 'A_MDay', 'A_MM', 'A_MMM', 'A_MMMM', 'A_MSec', 'A_MaxHotkeysPerInterval', 'A_MenuMaskKey',
    'A_Min', 'A_Mon', 'A_MouseDelay', 'A_MouseDelayPlay', 'A_MouseHookInstalled', 'A_MyDocuments', 'A_Now',
    'A_NowUTC', 'A_OSVersion', 'A_PriorHotkey', 'A_PriorKey', 'A_ProgramFiles', 'A_Programs', 'A_ProgramsCommon',
    'A_PtrSize', 'A_RegView', 'A_ScreenDPI', 'A_ScreenHeight', 'A_ScreenWidth', 'A_ScriptDir', 'A_ScriptFullPath',
    'A_ScriptHwnd', 'A_ScriptName', 'A_Sec', 'A_SendLevel', 'A_SendMode', 'A_Space', 'A_StartMenu',
    'A_StartMenuCommon', 'A_Startup', 'A_StartupCommon', 'A_StoreCapsLockMode', 'A_Tab', 'A_Temp', 'A_ThisFunc',
    'A_ThisHotkey', 'A_TickCount', 'A_TimeIdle', 'A_TimeIdleKeyboard', 'A_TimeIdleMouse', 'A_TimeIdlePhysical',
    'A_TimeSincePriorHotkey', 'A_TimeSinceThisHotkey', 'A_TitleMatchMode', 'A_TitleMatchModeSpeed', 'A_TrayMenu',
    'A_UserName', 'A_WDay', 'A_WinDelay', 'A_WinDir', 'A_WorkingDir', 'A_YDay', 'A_YWeek', 'A_YYYY', 'A_Year',
];

/** Words the scope analysis can see as names but that are always defined. */
export const ALWAYS_DEFINED: readonly string[] = ['true', 'false', 'unset', 'this', 'super', 'ThisHotkey', 'value'];

const lower = (list: readonly string[]) => new Map(list.map(n => [n.toLowerCase(), n] as const));
export const BUILTIN_FUNCTION_MAP = lower(BUILTIN_FUNCTIONS);
export const BUILTIN_CLASS_MAP = lower(BUILTIN_CLASSES);
export const BUILTIN_VARIABLE_MAP = lower([...BUILTIN_VARIABLES, ...ALWAYS_DEFINED]);

/** Is this name defined by AutoHotkey itself? */
export function isBuiltin(name: string): boolean {
    const l = name.toLowerCase();
    return BUILTIN_FUNCTION_MAP.has(l) || BUILTIN_CLASS_MAP.has(l) || BUILTIN_VARIABLE_MAP.has(l);
}
