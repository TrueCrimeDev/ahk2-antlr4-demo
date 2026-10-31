import hljs from 'highlight.js/lib/core';

// The AHK v2 grammar (src/vendor/highlight-ahk2.js) is copied unchanged from
// TrueCrimeDev/AHKv2_LLMs and registers itself on a global `hljs`, as it does on that site.
(globalThis as any).hljs = hljs;

export default hljs;
