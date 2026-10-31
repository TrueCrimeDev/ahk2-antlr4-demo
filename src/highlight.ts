import type CodeMirror from 'codemirror';
import hljs from './hljs-global';
import './vendor/highlight-ahk2.js';

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
        const code = editor.getValue();
        const html = hljs.highlight(code, { language: 'ahk2', ignoreIllegals: true }).value;
        const tpl = document.createElement('template');
        tpl.innerHTML = html;

        const ranges: [number, number, string][] = [];
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

        editor.operation(() => {
            for (const m of this.marks) m.clear();
            this.marks = ranges.map(([from, to, cls]) =>
                editor.markText(editor.posFromIndex(from), editor.posFromIndex(to), { className: cls }));
        });
    }
}
