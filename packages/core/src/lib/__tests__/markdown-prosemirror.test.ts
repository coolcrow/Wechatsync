/**
 * Markdown → Prosemirror 转换测试（小红书长文笔记格式）
 */
import { describe, it, expect } from 'vitest'
import {
  markdownToProsemirror,
  parseBlocks,
  XIAOHONGSHU_CAPABILITIES,
  DEFAULT_CAPABILITIES,
} from '../markdown-prosemirror'

describe('markdownToProsemirror', () => {
  it('converts headings with level clamped to maxHeadingLevel', async () => {
    const doc = await markdownToProsemirror('# 一级\n#### 四级\n##### 五级', XIAOHONGSHU_CAPABILITIES)
    const levels = (doc.content as Array<{ type: string; attrs?: { level?: number } }>)
      .filter(n => n.type === 'heading')
      .map(n => n.attrs?.level)
    expect(levels).toEqual([1, 3, 3])
  })

  it('degrades tables to pipe-separated paragraphs for xiaohongshu', async () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const doc = await markdownToProsemirror(md, XIAOHONGSHU_CAPABILITIES)
    const text = JSON.stringify(doc)
    expect(doc.content.every(n => n.type === 'paragraph')).toBe(true)
    expect(text).toContain('A | B')
    expect(text).toContain('1 | 2')
  })

  it('degrades code blocks to plain paragraphs for xiaohongshu', async () => {
    const doc = await markdownToProsemirror('```\nconst a = 1\n```', XIAOHONGSHU_CAPABILITIES)
    expect(doc.content[0].type).toBe('paragraph')
    expect(JSON.stringify(doc)).toContain('const a = 1')
  })

  it('renders bold as highlight when bold unsupported but highlight supported', async () => {
    const doc = await markdownToProsemirror('这是**重点**内容', XIAOHONGSHU_CAPABILITIES)
    const marks = JSON.stringify(doc)
    expect(marks).toContain('highlight')
    expect(marks).not.toContain('"bold"')
  })

  it('keeps bold as bold for default capabilities', async () => {
    const doc = await markdownToProsemirror('这是**重点**内容', DEFAULT_CAPABILITIES)
    expect(JSON.stringify(doc)).toContain('"bold"')
  })

  it('treats indented sub-list lines as separate blocks (no nesting grammar)', async () => {
    const md = '- 外层一\n  - 内层二\n- 外层三'
    const doc = await markdownToProsemirror(md, XIAOHONGSHU_CAPABILITIES)
    const types = doc.content.map(n => n.type)
    expect(types).toEqual(['bulletList', 'paragraph', 'bulletList'])
    expect(JSON.stringify(doc)).toContain('内层二')
  })

  it('uploads images and embeds fileId-backed preview urls', async () => {
    const md = '前文\n![配图](https://example.com/a.png)\n后文'
    const doc = await markdownToProsemirror(md, XIAOHONGSHU_CAPABILITIES, {
      uploadImage: async () => ({
        url: 'https://ros-preview.xhscdn.com/file-1',
        width: 800,
        height: 600,
        fileId: 'file-1',
      }),
    })
    const imageNode = JSON.stringify(doc)
    expect(imageNode).toContain('ros-preview.xhscdn.com/file-1')
    expect(imageNode).toContain('"width":410')
    expect(imageNode).toContain('"height":308')
  })

  it('falls back to original url when image upload is unavailable', async () => {
    const doc = await markdownToProsemirror('![图](https://example.com/a.png)', XIAOHONGSHU_CAPABILITIES)
    expect(JSON.stringify(doc)).toContain('https://example.com/a.png')
  })

  it('guarantees at least one paragraph for empty input', async () => {
    const doc = await markdownToProsemirror('', XIAOHONGSHU_CAPABILITIES)
    expect(doc.type).toBe('doc')
    expect(doc.content.length).toBeGreaterThan(0)
    expect(doc.content[0].type).toBe('paragraph')
  })

  it('parses blockquote containing multiple paragraphs', async () => {
    const doc = await markdownToProsemirror('> 第一段\n>\n> 第二段', XIAOHONGSHU_CAPABILITIES)
    const blockquote = doc.content.find(n => n.type === 'blockquote')
    expect(blockquote).toBeDefined()
  })

  it('produces an ordered list with start attribute under default capabilities', async () => {
    const doc = await markdownToProsemirror('3. 三\n4. 四', DEFAULT_CAPABILITIES)
    const list = doc.content.find(n => n.type === 'orderedList')
    expect(list?.attrs).toEqual({ start: 3, type: null })
  })
})

describe('parseBlocks', () => {
  it('splits fenced code blocks with language', () => {
    const root = parseBlocks('```python\nprint(1)\n```')
    const code = root.children?.[0]
    expect(code?.type).toBe('code')
    expect(code).toMatchObject({ lang: 'python', value: 'print(1)' })
  })

  it('extracts inline marks', () => {
    const root = parseBlocks('普通 **粗** *斜* `码` ~~删~~ [链](https://x.com)')
    const inline = (root.children?.[0] as { children: Array<{ type: string }> }).children.map(n => n.type)
    expect(inline).toContain('strong')
    expect(inline).toContain('emphasis')
    expect(inline).toContain('inlineCode')
    expect(inline).toContain('delete')
    expect(inline).toContain('link')
  })
})
