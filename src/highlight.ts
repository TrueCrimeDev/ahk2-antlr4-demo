import type CodeMirror from 'codemirror';
import hljs from './hljs-global';
import './vendor/highlight-ahk2.js';

/** [from, to, classes] in UTF-16 offsets of the whole document. Sorted, non-overlapping. */
export type HighlightRange = [number, number, string];

let cachedCode: string | null = null;
let cachedRanges: HighlightRange[] = [];

/** highlight.js ranges for the code. The last result is cached, so the editor and the graph share it. */
export function highlightRanges(code: string): HighlightRange[] {
    if (code === cachedCode) return cachedRanges;
    const html = hljs.highlight(code, { language: 'ahk2', ignoreIllegals: true }).value;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const ranges: HighlightRange[] = [];
    let offset = 0;
    const walk = (node: Node, classes: string) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
                const len = child.textContent!.length;
                if (classes && len) ranges.push([offset, offset + len, classes]);
                offset += len;
            } else if (child instanceof HTMLElement) {
                walk(child, (classes + ' ' + child.className).trim());
            }
        }
    };
    walk(tpl.content, '');
    cachedCode = code;
    cachedRanges = ranges;
    return ranges;
}

/** HTML for a short snippet, colored with the same classes as the editor. hljs escapes the text. */
export function highlightSnippet(code: string): string {
    return hljs.highlight(code, { language: 'ahk2', ignoreIllegals: true }).value;
}

/** highlight.js classes at a document offset ('' for plain text). */
export function classesAt(code: string, offset: number): string {
    const ranges = highlightRanges(code);
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const [from, to, cls] = ranges[mid];
        if (offset < from) hi = mid - 1;
        else if (offset >= to) lo = mid + 1;
        else return cls;
    }
    return '';
}

/** The editor's VS Code Dark+ color for a set of highlight.js classes (see styles.css). */
export function colorForClasses(classes: string): string {
    const list = classes.split(/\s+/);
    // The innermost scope is last, and it decides the color, as in the editor.
    for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        if (c === 'class_' && list.includes('hljs-title')) return '#4ec9b0';
        if (c === 'function_' && list.includes('hljs-title')) return '#dcdcaa';
        const color = HLJS_COLORS[c];
        if (color) return color;
    }
    return '#9cdcfe';
}

const HLJS_COLORS: Record<string, string> = {
    'hljs-keyword': '#569cd6',
    'hljs-literal': '#569cd6',
    'hljs-type': '#4ec9b0',
    'hljs-built_in': '#dcdcaa',
    'hljs-symbol': '#dcdcaa',
    'hljs-string': '#ce9178',
    'hljs-number': '#b5cea8',
    'hljs-comment': '#6a9955',
    'hljs-meta': '#c586c0',
    'hljs-variable': '#9cdcfe',
    'hljs-params': '#9cdcfe',
    'hljs-property': '#9cdcfe',
    'hljs-operator': '#d4d4d4',
    'hljs-punctuation': '#d4d4d4',
};

/**
 * Colors the editor with highlight.js and the AHK v2 grammar from the AHKv2_LLMs site.
 * highlight.js works on the whole document, so its output is applied as CodeMirror marks.
 */
export class Highlighter {
    private marks: CodeMirror.TextMarker[] = [];
    private timer: number | undefined;

    constructor(private editor: CodeMirror.Editor) {
        editor.on('change', () => {
            clearTimeout(this.timer);
            this.timer = window.setTimeout(() => this.apply(), 60);
        });
        this.apply();
    }

    apply() {
        const editor = this.editor;
        const ranges = highlightRanges(editor.getValue());
        editor.operation(() => {
            for (const m of this.marks) m.clear();
            this.marks = ranges.map(([from, to, cls]) =>
                editor.markText(editor.posFromIndex(from), editor.posFromIndex(to), { className: cls }));
        });
    }
}
