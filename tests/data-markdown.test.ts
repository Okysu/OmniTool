import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPlugin } from './harness/plugin'

let plugin: ReturnType<typeof loadPlugin>

beforeAll(() => {
  plugin = loadPlugin('src/plugins/builtin/data-tools.js', ['data-libs'])
})

async function fragment(markdown: string, params: Record<string, unknown> = {}): Promise<string> {
  const result = await plugin.run('markdown', [{ name: 'input.md', content: markdown }], { mode: 'fragment', ...params })
  return result.outputs[0].text
}

/** Visible text of an HTML fragment, whitespace-collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('markdown: block structure', () => {
  it('renders ATX headings h1–h6 with stable ids', async () => {
    const html = await fragment('# 一\n## Two words\n### 三\n#### 4\n##### 5\n###### 6')
    for (let level = 1; level <= 6; level++) expect(html).toMatch(new RegExp(`<h${level} id="[^"]+">`))
    expect(html).toContain('<h2 id="two-words">Two words</h2>')
    expect(html).toContain('<h1 id="一">一</h1>')
  })

  it('renders setext headings (the underline style)', async () => {
    const html = await fragment('Title\n=====\n\nSubtitle\n--------')
    expect(html).toContain('>Title</h1>')
    expect(html).toContain('>Subtitle</h2>')
  })

  it('de-duplicates heading ids', async () => {
    const html = await fragment('## 用法\n\n## 用法')
    expect(html).toContain('id="用法"')
    expect(html).toContain('id="用法-1"')
  })

  it('renders nested unordered and ordered lists, including `1)` markers', async () => {
    const html = await fragment('- a\n  - a.1\n    - a.1.i\n- b\n\n1) one\n2) two\n   1. two.one')
    expect(html.match(/<ul>/g)?.length).toBe(3)
    expect(html.match(/<ol>/g)?.length).toBe(2)
    expect(visibleText(html)).toContain('a.1.i')
    expect(visibleText(html)).toContain('two.one')
  })

  it('keeps multi-paragraph list items together', async () => {
    const html = await fragment('1. First item\n\n   Continued paragraph of the first item.\n\n2. Second item')
    expect(html.match(/<li>/g)?.length).toBe(2)
    expect(html).toContain('Continued paragraph of the first item.')
  })

  it('preserves an ordered list start number', async () => {
    expect(await fragment('7. seven\n8. eight')).toContain('<ol start="7">')
  })

  it('renders GFM task lists as disabled checkboxes', async () => {
    const html = await fragment('- [x] done\n- [ ] todo')
    expect(html.match(/type="checkbox"/g)?.length).toBe(2)
    expect(html).toMatch(/checked/)
    expect(html).toMatch(/disabled/)
  })

  it('renders nested blockquotes and lazy continuation lines', async () => {
    const html = await fragment('> outer\n> > inner\nlazy line')
    expect(html.match(/<blockquote>/g)?.length).toBe(2)
    expect(html).toContain('lazy line')
  })

  it('renders fenced code with ``` and ~~~ plus the language class, escaping content', async () => {
    const html = await fragment('```ts\nconst a = 1 < 2 && "x"\n```\n\n~~~python\nprint("hi")\n~~~')
    expect(html).toContain('<code class="language-ts">')
    expect(html).toContain('<code class="language-python">')
    expect(html).toContain('1 &lt; 2 &amp;&amp; &quot;x&quot;')
  })

  it('does not treat `#` inside a code block as a heading', async () => {
    const html = await fragment('```\n# not a heading\n```')
    expect(html).not.toContain('<h1')
  })

  it('renders indented code blocks', async () => {
    expect(await fragment('para\n\n    indented code\n')).toContain('<pre><code>indented code')
  })

  it('renders GFM tables with column alignment', async () => {
    const html = await fragment('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |\n| d | e | f |')
    expect(html).toContain('<table>')
    expect(html).toContain('style="text-align:left"')
    expect(html).toContain('style="text-align:center"')
    expect(html).toContain('style="text-align:right"')
    expect(html.match(/<tr>/g)?.length).toBe(3)
  })

  it('renders thematic breaks in all three spellings', async () => {
    const html = await fragment('a\n\n---\n\nb\n\n***\n\nc\n\n___\n\nd')
    expect(html.match(/<hr>/g)?.length).toBe(3)
  })

  it('renders footnotes with back-references', async () => {
    const html = await fragment('Claim.[^1]\n\n[^1]: Source here.')
    expect(html).toContain('class="footnotes"')
    expect(html).toContain('Source here.')
    expect(html).toMatch(/href="#fnref/)
  })
})

describe('markdown: inline', () => {
  it('renders emphasis, strong, strikethrough and inline code', async () => {
    const html = await fragment('*em* _em_ **strong** __strong__ ~~gone~~ `code`')
    expect(html.match(/<em>/g)?.length).toBe(2)
    expect(html.match(/<strong>/g)?.length).toBe(2)
    expect(html).toContain('<s>gone</s>')
    expect(html).toContain('<code>code</code>')
  })

  it('handles emphasis next to CJK text', async () => {
    expect(await fragment('中文**加粗**中文')).toContain('<strong>加粗</strong>')
  })

  it('keeps relative links intact (the old converter rewrote them to #)', async () => {
    const html = await fragment('[设计](docs/design/01-architecture.md) [锚点](#top) [上级](../x.md)')
    expect(html).toContain('href="docs/design/01-architecture.md"')
    expect(html).toContain('href="#top"')
    expect(html).toContain('href="../x.md"')
  })

  it('renders images with alt text and titles', async () => {
    expect(await fragment('![a cat](cat.png "Cat")')).toContain('<img src="cat.png" alt="a cat" title="Cat">')
  })

  it('autolinks bare URLs', async () => {
    expect(await fragment('see https://example.com/path now')).toContain('<a href="https://example.com/path">')
  })

  it('renders hard line breaks, and soft breaks only when asked', async () => {
    expect(await fragment('a  \nb')).toContain('a<br>')
    expect(await fragment('a\nb')).not.toContain('<br>')
    expect(await fragment('a\nb', { breaks: true })).toContain('a<br>')
  })

  it('decodes entities and backslash escapes', async () => {
    const html = await fragment('&copy; \\*not em\\*')
    expect(html).toContain('©')
    expect(html).toContain('*not em*')
    expect(html).not.toContain('<em>')
  })
})

describe('markdown: safety', () => {
  it('escapes raw HTML instead of passing it through', async () => {
    const html = await fragment('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
  })

  it('neutralises javascript: and data: links', async () => {
    const html = await fragment('[x](javascript:alert(1)) [y](data:text/html,<b>)')
    expect(html).not.toMatch(/href="javascript:/i)
    expect(html).not.toMatch(/href="data:/i)
  })
})

describe('markdown: document output', () => {
  it('produces a complete HTML document titled from the first heading', async () => {
    const result = await plugin.run('markdown', [{ name: 'notes.md', content: '# 周报\n\n正文' }], { mode: 'html' })
    const html = result.outputs[0].text
    expect(result.outputs[0].name).toBe('notes.html')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>周报</title>')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it('escapes a user-supplied title', async () => {
    const result = await plugin.run('markdown', [{ name: 'x.md', content: 'x' }], { mode: 'html', title: '</title><script>' })
    expect(result.outputs[0].text).toContain('<title>&lt;/title&gt;&lt;script&gt;</title>')
  })

  it('inserts a table of contents linking to every heading', async () => {
    const html = await fragment('# A\n## B\n### C', { toc: true })
    expect(html.indexOf('class="toc"')).toBeLessThan(html.indexOf('<h1'))
    for (const id of ['a', 'b', 'c']) expect(html).toContain(`href="#${id}"`)
  })

  it('extracts an outline from ATX and setext headings but not code', async () => {
    const result = await plugin.run('markdown', [{ name: 'd.md', content: 'Top\n===\n\n## Sub\n\n```\n# fake\n```\n\n### Deep' }], { mode: 'outline' })
    expect(result.outputs[0].text).toBe('- Top\n  - Sub\n    - Deep')
  })
})

describe('markdown: nothing is dropped from real documents', () => {
  const root = resolve(__dirname, '..')
  const documents: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.md')) documents.push(path)
    }
  }
  walk(join(root, 'docs'))
  documents.push(join(root, 'README.md'))

  it('found the repository documents', () => {
    expect(documents.length).toBeGreaterThanOrEqual(8)
  })

  for (const path of documents) {
    it(`converts ${relative(root, path)} completely`, async () => {
      const source = readFileSync(path, 'utf8')
      // Compare with all whitespace removed: tag stripping inserts spaces around
      // inline code, which is formatting, not lost content.
      const squash = (value: string) => value.replace(/\s+/g, '')
      const text = squash(visibleText(await fragment(source)))

      // Every heading survives. Only unambiguous inline markers are stripped;
      // underscores stay because identifiers like NS_ERROR_... use them.
      const headings = [...source.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
        m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, ''),
      )
      for (const heading of headings) expect(text).toContain(squash(heading))

      // The tail of the document survives - this is what "only half converted" breaks.
      const lastProse = source
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /[\p{L}\p{N}]{2,}/u.test(line) && !line.startsWith('|') && !line.startsWith('```'))
        .pop()!
      const words = lastProse
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|[`>#]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1)
      for (const word of words.slice(-3)) expect(text).toContain(squash(word))
    })
  }
})
