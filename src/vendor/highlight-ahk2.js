// highlight-ahk2.js - AutoHotkey v2 syntax grammar for highlight.js
// Matches VS Code Dark+ theme colors for AHK v2 through v2.1-alpha.26
//
// From TrueCrimeDev/AHKv2_LLMs (e4e3f5e), with fixes found by cross-checking against
// the ANTLR lexer on ~1,300 scripts (AHK docs examples and the AHKv2_LLMs examples):
// - Keywords, built-ins and directives match in any case (AutoHotkey is case-insensitive).
// - Added keywords: as, until, goto, Loop Files/Parse/Read/Reg, get/set accessors, true/false.
// - Quoted strings end at the end of the line, so one stray quote can't color later lines.
// - Continuation-section strings ("\n(\n...\n)") are one string.
// - Hotkey labels only match real hotkey syntax, so " :: " inside a string isn't a hotkey.
// - Hotstrings: trigger is a symbol; auto-replace text is shown as text, not code.
// - Any #Directive at the start of a line (but not a # hotkey like #c::); its argument is
//   shown as a string, except #HotIf, whose argument is an expression.
// - A ; comment needs whitespace or the start of a line before it, as in AutoHotkey.

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

  var ESCAPE = { begin: /`./ };
  var STRING_DQ = { className: 'string', begin: '"', end: /"|$/, contains: [ESCAPE] };
  var STRING_SQ = { className: 'string', begin: "'", end: /'|$/, contains: [ESCAPE] };
  var CONT_STRING_DQ = {
    className: 'string',
    begin: /"(?=[^"\n]*\r?\n(?:[ \t]*;[^\n]*\r?\n)*[ \t]*\()/,
    end: /^[ \t]*\)[^\n"]*"/
  };
  var CONT_STRING_SQ = {
    className: 'string',
    begin: /'(?=[^'\n]*\r?\n(?:[ \t]*;[^\n]*\r?\n)*[ \t]*\()/,
    end: /^[ \t]*\)[^\n']*'/
  };

  var language = {
    name: 'AutoHotkey v2',
    aliases: ['ahk', 'ahk2', 'autohotkey'],
    case_insensitive: true,
    contains: [
      // Block comments
      hljs.COMMENT('/\\*', '\\*/'),

      // Line comments: AutoHotkey requires whitespace (or line start) before ;
      hljs.COMMENT(/(?<=^|[ \t]);/, /$/),

      // Hotstrings ::trigger::replacement or :options:trigger::replacement.
      // With the X option the replacement is code; otherwise it is literal text.
      {
        className: 'symbol',
        begin: /^[ \t]*:[^:\n]*x[^:\n]*:[^\n]*?::/,
        relevance: 5
      },
      {
        className: 'symbol',
        begin: /^[ \t]*:[^:\n]*:[^\n]*?::/,
        relevance: 5,
        starts: {
          className: 'string',
          end: /$/,
          contains: [hljs.COMMENT(/(?<=[ \t]);/, /$/)]
        }
      },

      // Hotkey labels: optional modifiers, a key or key name, optional "& key" and "up", then ::
      {
        className: 'symbol',
        begin: /^[ \t]*[#!^+<>*~$]*(?:\w+|[^\s:])(?:[ \t]+&[ \t]+(?:\w+|[^\s:]))?(?:[ \t]+up)?::/,
        relevance: 5
      },

      // Struct definition
      STRUCT_DEF,

      // Class definition
      CLASS_DEF,

      // extends keyword
      EXTENDS_DEF,

      // #HotIf takes an expression, so its argument is highlighted as code.
      {
        className: 'meta',
        begin: /^[ \t]*#hotif\b(?!::)/,
        relevance: 10
      },

      // Other directives - purple. Any #Name at the start of a line, except # hotkeys such as #c::
      // Their arguments are literal text (#Requires AutoHotkey v2.0, #Include <Lib>), shown as strings.
      {
        className: 'meta',
        begin: /^[ \t]*#[a-z_]\w*\b(?!::)/,
        relevance: 10,
        starts: {
          className: 'string',
          end: /$/,
          contains: [
            hljs.COMMENT(/(?<=[ \t]);/, /$/),
            // A lone number or true/false argument (#InputLevel 1, #UseHook true) keeps its own color.
            { className: 'number', begin: /(?<=^[ \t]*#\w+[ \t]+)(?:0x[0-9a-f]+|\d+)(?=[ \t]*(?:;|$))/ },
            { className: 'literal', begin: /(?<=^[ \t]*#\w+[ \t]+)(?:true|false)(?=[ \t]*(?:;|$))/ }
          ]
        }
      },

      // Continuation-section strings: an unclosed quote, then ( ... ) on the following lines
      CONT_STRING_DQ,
      CONT_STRING_SQ,

      // Strings. Outside continuation sections a string can't span lines,
      // so it also ends at the end of the line.
      STRING_DQ,
      STRING_SQ,

      // Typed field annotations
      {
        className: 'type',
        begin: /\b(?:i8|u8|i16|u16|i32|u32|i64|u64|iptr|uptr|Int8|UInt8|Int16|UInt16|Int32|UInt32|Int64|UInt64|IntPtr|UIntPtr|Float32|Float64)\b/,
        relevance: 8
      },

      // Loop sub-commands
      {
        className: 'keyword',
        begin: /\bloop[ \t]+(?:files|parse|read|reg)\b/
      },

      // Control flow keywords - blue
      {
        className: 'keyword',
        begin: /\b(?:if|else|for|while|loop|until|return|break|continue|goto|switch|case|default|try|catch|finally|throw|as|static|global|local|export|in|not|and|or|is|this|super|unset)\b/
      },

      // Property accessors: get/set before { or =>
      {
        className: 'keyword',
        begin: /\b(?:get|set)\b(?=[ \t]*(?:\{|=>))/
      },

      // true / false
      {
        className: 'literal',
        begin: /\b(?:true|false)\b/
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
      }
    ]
  };

  // Continuation sections: a line that is just ( [options] through a line starting with ).
  // The lines are joined, so strings inside may span lines.
  var CONT_SECTION = {
    begin: /^[ \t]*\((?=[^)\n]*$)/,
    beginScope: 'punctuation',
    end: /^[ \t]*\)/,
    endScope: 'punctuation',
    contains: language.contains.map(function(m) {
      if (m === STRING_DQ) return { className: 'string', begin: '"', end: '"', contains: [ESCAPE] };
      if (m === STRING_SQ) return { className: 'string', begin: "'", end: "'", contains: [ESCAPE] };
      return m;
    })
  };
  language.contains.splice(language.contains.indexOf(STRING_DQ), 0, CONT_SECTION);
  return language;
});
