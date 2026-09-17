/**
 * One sandbox dependency for the data & text plugin.
 *
 * Replaces the hand-written Markdown / YAML / CSV / XML subsets the plugin used
 * to carry. Each of those covered the common case and silently dropped the rest
 * (nested lists, setext headings, footnotes, YAML anchors, quoted CSV newlines…),
 * which is exactly how "Markdown only converted half the document" happened.
 * These libraries implement the actual specs.
 */
export { default as MarkdownIt } from 'markdown-it'
export { default as markdownItFootnote } from 'markdown-it-footnote'
export { default as markdownItTaskLists } from 'markdown-it-task-lists'
export { default as YAML } from 'yaml'
export { default as Papa } from 'papaparse'
export { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser'
