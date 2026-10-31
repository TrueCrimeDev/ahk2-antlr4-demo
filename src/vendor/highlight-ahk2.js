// highlight-ahk2.js - AutoHotkey v2 syntax grammar for highlight.js
// Matches VS Code Dark+ theme colors for AHK v2 through v2.1-alpha.26

hljs.registerLanguage('ahk2', function(hljs) {

  // Struct/class declarations -- keyword + the type name highlighted as a
  // class title (teal). Uses the begin-array form so the captured name gets
  // its own scope; a plain `match` mode is terminal and would drop `contains`.
  var STRUCT_DEF = {
    begin: [/\bStruct\b/, /\s+/, /[A-Za-z_]\w*/],
    beginScope: { 1: 'keyword', 3: 'title.class' },
    relevance: 10
  };

  var CLASS_DEF = {
    begin: [/\bclass\b/, /\s+/, /[A-Za-z_]\w*/],
    beginScope: { 1: 'keyword', 3: 'title.class' }
  };

  // extends keyword + parent class name
  var EXTENDS_DEF = {
    begin: [/\bextends\b/, /\s+/, /[A-Za-z_]\w*/],
    beginScope: { 1: 'keyword', 3: 'title.class' }
  };

  // Built-in functions that use parentheses
  var BUILTIN_FUNCS = '(?:' + [
    'MsgBox', 'InputBox', 'ToolTip', 'FileOpen', 'FileRead', 'FileAppend',
    'DllCall', 'CallbackCreate', 'CallbackFree', 'ComObject', 'RegRead',
    'RegWrite', 'WinExist', 'WinActive', 'WinActivate', 'WinClose', 'WinWait',
    'WinWaitActive', 'WinGetTitle', 'WinGetClass', 'WinGetPos', 'WinMove',
    'WinHide', 'WinShow', 'WinSetTitle', 'WinGetText', 'WinMinimize',
    'WinMaximize', 'WinRestore', 'WinGetControls',
    'ControlGetText', 'ControlSetText', 'ControlClick', 'ControlSend', 'ControlFocus',
    'Send', 'SendInput', 'SendEvent', 'Click', 'MouseMove', 'MouseClick',
    'MouseGetPos', 'KeyWait', 'GetKeyState', 'Hotkey', 'SetTimer', 'Sleep',
    'Run', 'RunWait', 'ProcessExist', 'ProcessClose', 'ProcessWait',
    'EnvGet', 'EnvSet', 'SysGet', 'MonitorGet', 'MonitorGetCount',
    'Format', 'FormatTime', 'StrLen', 'StrLower', 'StrUpper', 'StrReplace',
    'StrSplit', 'SubStr', 'InStr', 'RegExMatch', 'RegExReplace',
    'Trim', 'LTrim', 'RTrim', 'Sort', 'Type', 'IsSet', 'IsObject',
    'HasProp', 'HasOwnProp', 'HasMethod', 'HasBase', 'ObjOwnPropCount',
    'GetOwnPropDesc', 'DefineProp', 'Sqrt', 'Abs', 'Min', 'Max', 'Mod',
    'Round', 'Floor', 'Ceil', 'Log', 'Ln', 'Exp',
    'Map', 'Array', 'Buffer', 'Gui', 'Menu', 'MenuBar',
    'OnMessage', 'OnExit', 'OnError', 'OnClipboardChange',
    'SetTitleMatchMode', 'DetectHiddenWindows', 'CoordMode', 'SendMode',
    'SetWorkingDir', 'Persistent', 'Chr', 'Ord', 'NumGet', 'NumPut',
    'StrGet', 'StrPut', 'FileExist', 'DirExist', 'String',
    'Reload', 'ExitApp', 'Suspend', 'Pause'
  ].join('|') + ')';

  return {
    name: 'AutoHotkey v2',
    aliases: ['ahk', 'ahk2', 'autohotkey'],
    case_insensitive: false,
    contains: [
      // Block comments
      hljs.COMMENT('/\\*', '\\*/'),

      // Line comments
      hljs.COMMENT(';', '$'),

      // Struct definition
      STRUCT_DEF,

      // Class definition
      CLASS_DEF,

      // extends keyword
      EXTENDS_DEF,

      // Directives - purple
      {
        className: 'meta',
        begin: /#(?:Requires|Include|Import|Module|SingleInstance|HotIf|DllLoad|Warn|ErrorStdOut|NoTrayIcon)\b/,
        relevance: 10
      },

      // Strings - double quoted
      {
        className: 'string',
        begin: '"',
        end: '"',
        contains: [{ begin: /`./ }]
      },

      // Strings - single quoted
      {
        className: 'string',
        begin: "'",
        end: "'",
        contains: [{ begin: /`./ }]
      },

      // Typed field annotations
      {
        className: 'type',
        begin: /\b(?:i8|u8|i16|u16|i32|u32|i64|u64|iptr|uptr|Int8|UInt8|Int16|UInt16|Int32|UInt32|Int64|UInt64|IntPtr|UIntPtr|Float32|Float64)\b/,
        relevance: 8
      },

      // Control flow keywords - blue
      {
        className: 'keyword',
        begin: /\b(?:if|else|for|while|loop|return|break|continue|switch|case|default|try|catch|finally|throw|static|global|local|export|in|not|and|or|is|this|super|unset)\b/
      },

      // Built-in variables (A_ prefix) - light blue
      {
        className: 'variable.language',
        begin: /\bA_\w+\b/
      },

      // Built-in functions/commands -- match with OR without parens (command style)
      {
        className: 'built_in',
        begin: new RegExp('\\b' + BUILTIN_FUNCS + '\\b'),
        relevance: 0
      },

      // Punctuation: parens, brackets, braces -- white
      {
        className: 'punctuation',
        begin: /[()[\]{}]/,
        relevance: 0
      },

      // Fat arrow operator
      {
        className: 'operator',
        begin: /=>/
      },

      // Assignment and comparison operators
      {
        className: 'operator',
        begin: /(?::=|\.=|\+=|-=|\*=|\/=|==|!=|<=|>=|&&|\|\||<<|>>|\*\*|~=)/
      },

      // Colons (field type separator, ternary) -- white
      {
        className: 'punctuation',
        begin: /:/,
        relevance: 0
      },

      // Commas -- white
      {
        className: 'punctuation',
        begin: /,/,
        relevance: 0
      },

      // Constructor/class calls (PascalCase + parens) - yellow
      {
        className: 'title.function.invoke',
        begin: /\b[A-Z]\w*(?=\s*\()/,
        relevance: 0
      },

      // Function declarations
      {
        className: 'title.function',
        begin: /\b[a-zA-Z_]\w*(?=\s*\([^)]*\)\s*[\{=])/,
        relevance: 2
      },

      // Function/method calls - yellow
      {
        className: 'title.function.invoke',
        begin: /\b[a-z_]\w*(?=\s*\()/,
        relevance: 0
      },

      // Method calls after dot
      {
        className: 'title.function.invoke',
        begin: /(?:\.)\w+(?=\s*\()/
      },

      // Property access after dot - light blue
      {
        className: 'property',
        begin: /(?:\.)\w+/,
        relevance: 0
      },

      // Hex numbers
      {
        className: 'number',
        begin: /\b0[xX][0-9a-fA-F]+\b/
      },

      // Float numbers
      {
        className: 'number',
        begin: /\b\d+\.\d+\b/
      },

      // Integer numbers
      {
        className: 'number',
        begin: /\b\d+\b/,
        relevance: 0
      },

      // Hotkey labels
      {
        className: 'symbol',
        begin: /^\s*[#!^+<>*~$]*\w[^\n:]*(?=::)/,
        relevance: 5
      }
    ]
  };
});
