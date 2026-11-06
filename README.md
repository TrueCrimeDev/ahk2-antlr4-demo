# AutoHotkey v2 AST Explorer

A fork of [Descolada/ahk2-antlr4-demo](https://github.com/Descolada/ahk2-antlr4-demo) that adds tools for reading and checking the parse tree from Descolada's AutoHotkey v2 ANTLR4 grammar.

**Live:** https://truecrimedev.github.io/ahk2-antlr4-demo/

## What this fork adds

- **Lint checks with one-click fixes.** Seven rules, each based on behavior checked on AutoHotkey 2.1-alpha (see the table below). Problems with an obvious repair get a **Fix** button in the Problems list and in the gutter hint; Ctrl+Z undoes it.
- **Scope-aware references.** Put the cursor on a name to highlight every use of that same variable, following AutoHotkey's rules: assume-local functions, `global` declarations, parameters, and closures that share an outer function's variables. The bar under the editor says what the name is ("local variable of Bump", "parameter of Outer, captured by this closure", "function", ...). **Ctrl+click** or **F12** jumps to the definition; **F2** renames every reference.
- **Share links and files.** **Share** copies a link with the code compressed into it (an unedited example gets a short `#ex=` link). **Open…** or dropping a file on the editor loads an `.ahk` file (UTF-8, UTF-8 with BOM or UTF-16). Shared and opened code goes into its own slot, so it never replaces "Your code".
- **Command-line linter** for scripts, CI and AI coding harnesses: see below.
- **Examples picker.** A dropdown above the editor with Weird AHK parser edge cases, lint demos and a syntax tour, plus ‹ › buttons to step through them. Each one has a note on how AutoHotkey reads it and where this grammar disagrees. "Your code" keeps your own script, edits to an example are kept (with Reset to restore it), and `#ex=<id>` links open an example, e.g. [`#ex=insane-pipes`](https://truecrimedev.github.io/ahk2-antlr4-demo/#ex=insane-pipes).
- **Click-to-source linking.** Click a node in the graph or outline to highlight its code. Move the editor cursor to mark the deepest node under it. A breadcrumb shows the selected node's path; click any part to select that ancestor.
- **Problems panel.** Lexer and parser errors appear with positions instead of replacing the tree, plus the lint rules, all marked in the editor gutter and underlined.
- **Graph view** with drag to pan, wheel or pinch to zoom, and Fit / 1:1 buttons.
  - Boxes are colored by kind (statement, declaration, expression, literal, name, directive, structure), with a key in the corner.
  - Boxes show the grammar's labeled alternative when there is one, such as `AssignmentExpression` or `FunctionCallAccess` instead of `singleExpression`.
  - **Merge chains** (on by default) draws each chain of single-child rules as one box, with the wrapper rules in small gray text, and drops empty `eos` leaves. This roughly halves the number of boxes. Hover a box for its full chain.
  - Tokens are dark code chips colored exactly like the editor's highlighting.
  - Clicking a box selects its code and fades everything outside its subtree; click empty space to clear. Hovering a box marks its code in the editor.
- **Outline view.** A collapsible text tree with line:column positions. It handles programs too large for Graphviz.
- **Tokens view.** The exact token stream the parser reads after whitespace preprocessing, or every lexer token including hidden-channel comments and whitespace.
- **Node search** across the graph and outline, with Enter / Shift+Enter to step through matches.
- **Syntax highlighting** with the highlight.js 11.9 grammar and VS Code Dark+ colors from [AHKv2_LLMs](https://truecrimedev.github.io/AHKv2_LLMs/). `src/vendor/highlight-ahk2.js` starts from that repo's copy, with fixes found by checking it against the ANTLR lexer on about 1,300 scripts: keywords in any case, strings that can't run past their line, continuation sections, hotkeys and hotstrings. The header of the file lists the changes.
- **Lint hints in the gutter.** Click or tap a colored dot next to a line number to see that line's problems, with docs links; click a problem to select its code.
- Light and dark page themes, a phone layout, and your code and edited examples saved in the browser between visits.

## Lint rules

| Rule | Checks |
|:--|:--|
| `arg-alias` | A plain variable passed as an argument is not read until the call runs, so another argument that assigns, increments or `&`-references it changes what the function receives. `x := 1, Pair(x, x := 2)` passes `[2, 2]`. See the known limitation under [Parameters](https://www.autohotkey.com/docs/alpha/Functions.htm#param). |
| `global-shadow` | Functions and hotkeys are assume-local, so `count++` or `total += x` on a global without `global count` changes a new local that has no value: "This local variable has not been assigned a value." Fix: add the `global` line (one-line hotkeys get a block). |
| `name-conflict` | Names ignore case, and a function or class name can't be assigned in the scope that defines it, so `t := 1` next to `T()` stops the script from loading ("This Func cannot be assigned a value."). Covers `:=`, `+=`, `++`, `for`, `catch` and `&`. Locals that shadow a global function are fine. |
| `property-call` | `obj.f()` passes `obj` as a hidden first argument, so a function stored with `obj.f := () => ...` or `{f: () => ...}` throws "Too many parameters passed to function." Fix: `obj.f.Call()`. |
| `string-compare` | `<`, `>`, `<=` and `>=` throw TypeError ("Expected a Number but got a String") on non-numeric strings in v2.1. Fix: `StrCompare(a, b) < 0`. |
| `space-index` | `value [1]` indexes `value` even with the space, so `"Total: " [1, 2].Length` throws PropertyError. This grammar shows a concatenation there instead. Fix: join with `.`, or remove the space. |
| `callback-arity` | `Hotkey`, `HotIf`, `SetTimer`, `OnMessage`, `OnClipboardChange`, `OnError`, `OnExit`, Gui `OnEvent` / `OnNotify` / `OnCommand` and `Menu.Add` check a callback's parameters when it is registered and throw "Invalid callback function" if it can't accept what they pass. Checked for inline fat-arrow functions and for functions declared in the script. Parameter counts come from AutoHotkey's `ValidateFunctor` call sites. Fix for inline fat arrows: add `*`. |

## Command-line linter

`cli/ahk-ast.mjs` is a single-file build of the parser, lint rules and scope analysis. It needs only Node 18 or later.

```sh
node cli/ahk-ast.mjs lint script.ahk              # script.ahk:3:5: warning global-shadow: ...
node cli/ahk-ast.mjs lint --json a.ahk b.ahk      # machine-readable, with fixes as edits
node cli/ahk-ast.mjs lint --fix script.ahk        # apply the one-click fixes in place
node cli/ahk-ast.mjs ast script.ahk               # parse tree as JSON, with grammar labels
node cli/ahk-ast.mjs symbols script.ahk           # variables/functions/classes, scopes, references
node cli/ahk-ast.mjs rules
```

`lint` exits with 1 when there are errors (add `--strict` to count warnings too) and 2 on bad usage. Use `-` as the file name to read standard input.

## Development

```sh
npm install
npm start          # dev server
npm run typecheck
npm run test:highlight                      # targeted highlighting checks
npm run test:lint                           # lint rules and their fixes
npm run check:highlight-corpus -- <folder>  # compare highlighting with the lexer on your .ahk files
npm run build      # writes the site to docs/, a root index.html that loads it, and cli/ahk-ast.mjs
```

Source layout:

| File | Purpose |
|:--|:--|
| `src/lexing.ts` | Token preprocessing from the original demo |
| `src/parse.ts` | Lexing and parsing with positioned diagnostics |
| `src/model.ts` | Display tree, source ranges, collapse logic |
| `src/lint.ts` | Lint rules and fixes |
| `src/scope.ts` | Scopes, symbols and references |
| `src/cli.ts` | Command-line linter (built to `cli/ahk-ast.mjs`) |
| `src/examples.ts` | Example scripts for the picker |
| `src/graph.ts`, `src/outline.ts`, `src/tokens.ts` | Views |
| `src/highlight.ts` | Applies highlight.js output to the editor |
| `src/index.ts` | Editor and UI wiring |
| `src/index.html` | Page source; the root `index.html` is generated by the build |

The grammar in `src/grammar` and the generated parser in `src/parser` are unchanged from upstream.
