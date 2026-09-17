/**
 * Tutorial lessons, authored as Markdown in `docs/learn/`.
 *
 * One file per lesson, readable on its own (GitHub renders it fine) and also
 * the source of `llms-full.txt` for AI agents. The format:
 *
 *   ---
 *   title: 读取输入文件
 *   chapter: 基础
 *   sample: text | csv | image | none
 *   sampleName: notes.txt          (optional)
 *   sampleText: …                  (optional, for text / csv)
 *   ---
 *   Prose, with ordinary code blocks as examples.
 *
 *   ```js starter        the code the editor opens with
 *   ```js solution       what 「显示答案」 swaps in
 *
 * The first `# heading` is not needed; `title` names the lesson.
 */
export interface Lesson {
  id: string
  order: number
  title: string
  chapter: string
  sample: 'text' | 'csv' | 'image' | 'none'
  sampleName: string
  sampleText: string
  /** Markdown with the starter and solution blocks removed. */
  body: string
  starter: string
  solution: string
}

const FENCE = /^```js (starter|solution)\n([\s\S]*?)^```\s*$/gm

export function parseLesson(fileName: string, source: string): Lesson {
  const match = /^([0-9]+)-([a-z0-9-]+)\.md$/.exec(fileName)
  if (!match) throw new Error(`教程文件名应形如 01-hello.md：${fileName}`)
  const text = source.replace(/\r\n/g, '\n')
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)
  const meta: Record<string, string> = {}
  if (front) {
    for (const line of front[1].split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line)
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1').replace(/\\n/g, '\n')
    }
  }
  let rest = front ? text.slice(front[0].length) : text
  const code: Record<string, string> = {}
  rest = rest.replace(FENCE, (_all, kind: string, body: string) => {
    code[kind] = body
    return ''
  })
  if (!code.starter) throw new Error(`${fileName} 缺少 \`\`\`js starter 代码块`)
  const sample = (['text', 'csv', 'image', 'none'] as const).find((s) => s === meta.sample) ?? 'none'
  return {
    id: match[2],
    order: Number(match[1]),
    title: meta.title || match[2],
    chapter: meta.chapter || '',
    sample,
    sampleName: meta.sampleName || { text: 'notes.txt', csv: 'data.csv', image: 'photo.png', none: '' }[sample],
    sampleText: meta.sampleText || '',
    body: rest.replace(/\n{3,}/g, '\n\n').trim(),
    starter: code.starter,
    solution: code.solution ?? code.starter,
  }
}

const files = import.meta.glob('../../../docs/learn/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export const LESSONS: Lesson[] = Object.entries(files)
  .map(([path, source]) => parseLesson(path.split('/').pop()!, source))
  .sort((a, b) => a.order - b.order)
