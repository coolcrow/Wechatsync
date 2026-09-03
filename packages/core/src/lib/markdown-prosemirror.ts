/**
 * Markdown → Prosemirror 文档转换器（供小红书等 prosemirror 编辑器平台使用）。
 *
 * 能力声明决定节点映射：不支持的格式会降级（表格转段落文本、标题层级截断、
 * 行内标记退化为纯文本等），保证产出的 doc 一定可被目标编辑器接受。
 */

export interface PlatformCapabilities {
  id: string
  outputFormat: 'markdown' | 'html' | 'prosemirror'
  maxHeadingLevel: number
  supportNestedList: boolean
  supportTable: boolean
  supportCodeBlock: boolean
  supportInlineCode: boolean
  supportLink: boolean
  supportImage: boolean
  supportBlockquote: boolean
  supportHorizontalRule: boolean
  supportBold: boolean
  supportItalic: boolean
  supportStrikethrough: boolean
  supportHighlight: boolean
  supportLatex: boolean
}

export const DEFAULT_CAPABILITIES: PlatformCapabilities = {
  id: 'default',
  outputFormat: 'markdown',
  maxHeadingLevel: 6,
  supportNestedList: true,
  supportTable: true,
  supportCodeBlock: true,
  supportInlineCode: true,
  supportLink: true,
  supportImage: true,
  supportBlockquote: true,
  supportHorizontalRule: true,
  supportBold: true,
  supportItalic: true,
  supportStrikethrough: true,
  supportHighlight: true,
  supportLatex: true,
}

export const XIAOHONGSHU_CAPABILITIES: PlatformCapabilities = {
  id: 'xiaohongshu',
  outputFormat: 'prosemirror',
  maxHeadingLevel: 3,
  supportNestedList: false,
  supportTable: false,
  supportCodeBlock: false,
  supportInlineCode: false,
  supportLink: false,
  supportImage: true,
  supportBlockquote: true,
  supportHorizontalRule: false,
  supportBold: false,
  supportItalic: false,
  supportStrikethrough: false,
  supportHighlight: true,
  supportLatex: false,
}

type InlineNode =
  | { type: 'image'; alt: string; url: string }
  | { type: 'link'; url: string; children: InlineNode[] }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'emphasis'; children: InlineNode[] }
  | { type: 'delete'; children: InlineNode[] }
  | { type: 'inlineCode'; value: string }
  | { type: 'break' }
  | { type: 'text'; value: string }

type BlockNode =
  (
    | { type: 'root'; children: BlockNode[] }
    | { type: 'heading'; depth: number; children: InlineNode[] }
    | { type: 'paragraph'; children: InlineNode[] }
    | { type: 'blockquote'; children: BlockNode[] }
    | { type: 'list'; ordered: boolean; start?: number; children: BlockNode[] }
    | { type: 'listItem'; children: BlockNode[] }
    | { type: 'table'; children: BlockNode[] }
    | { type: 'tableRow'; children: BlockNode[] }
    | { type: 'tableCell'; children: InlineNode[] }
    | { type: 'code'; lang?: string; value: string }
    | { type: 'thematicBreak' }
    | { type: 'image'; alt: string; url: string }
  )

export interface UploadedImage {
  url: string
  width: number
  height: number
  fileId: string
}

export interface ConvertImageOptions {
  uploadImage?: (src: string) => Promise<UploadedImage>
  onImageProgress?: (current: number, total: number) => void
}

interface ProseMark {
  type: string
  attrs?: Record<string, unknown>
}

interface ProseNode {
  type: string
  attrs?: Record<string, unknown>
  marks?: ProseMark[]
  content?: ProseNode[]
  text?: string
}

interface ConvertContext {
  capabilities: PlatformCapabilities
  uploadImage?: ConvertImageOptions['uploadImage']
  onImageProgress?: ConvertImageOptions['onImageProgress']
  uploadedImages: Map<string, UploadedImage>
  imageQueue: Array<{ src: string; alt: string }>
}

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let rest = text
  while (rest.length > 0) {
    const image = rest.match(/^!\[([^\]]*)\]\(([^)]+)\)/)
    if (image) {
      nodes.push({ type: 'image', alt: image[1], url: image[2] })
      rest = rest.slice(image[0].length)
      continue
    }
    const link = rest.match(/^\[([^\]]+)\]\(([^)]+)\)/)
    if (link) {
      nodes.push({ type: 'link', url: link[2], children: [{ type: 'text', value: link[1] }] })
      rest = rest.slice(link[0].length)
      continue
    }
    const strong = rest.match(/^(\*\*|__)([^*_]+)\1/)
    if (strong) {
      nodes.push({ type: 'strong', children: [{ type: 'text', value: strong[2] }] })
      rest = rest.slice(strong[0].length)
      continue
    }
    const emphasis = rest.match(/^(\*|_)([^*_]+)\1/)
    if (emphasis) {
      nodes.push({ type: 'emphasis', children: [{ type: 'text', value: emphasis[2] }] })
      rest = rest.slice(emphasis[0].length)
      continue
    }
    const strike = rest.match(/^~~([^~]+)~~/)
    if (strike) {
      nodes.push({ type: 'delete', children: [{ type: 'text', value: strike[1] }] })
      rest = rest.slice(strike[0].length)
      continue
    }
    const code = rest.match(/^`([^`]+)`/)
    if (code) {
      nodes.push({ type: 'inlineCode', value: code[1] })
      rest = rest.slice(code[0].length)
      continue
    }
    if (rest.startsWith('  \n') || rest.startsWith('\n')) {
      nodes.push({ type: 'break' })
      rest = rest.replace(/^(\s*\n|\n)/, '')
      continue
    }
    const nextSpecial = rest.search(/[!\[*_~`\n]/)
    if (nextSpecial === -1) {
      nodes.push({ type: 'text', value: rest })
      break
    }
    if (nextSpecial === 0) {
      nodes.push({ type: 'text', value: rest[0] })
      rest = rest.slice(1)
    } else {
      nodes.push({ type: 'text', value: rest.slice(0, nextSpecial) })
      rest = rest.slice(nextSpecial)
    }
  }
  return nodes
}

export function parseBlocks(markdown: string): Extract<BlockNode, { type: 'root' }> {
  const lines = markdown.split('\n')
  const blocks: BlockNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i])
      i++
      blocks.push({ type: 'code', lang: lang || undefined, value: body.join('\n') })
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: 'heading', depth: heading[1].length, children: parseInline(heading[2]) })
      i++
      continue
    }
    if (/^[-*_]{3,}\s*$/.test(line)) {
      blocks.push({ type: 'thematicBreak' })
      i++
      continue
    }
    if (line.startsWith('>')) {
      const body: string[] = []
      while (
        i < lines.length &&
        (lines[i].startsWith('>') || (lines[i].trim() !== '' && body.length > 0 && !lines[i].match(/^[#\-*\d]/)))
      ) {
        body.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(body.join('\n')).children || [] })
      continue
    }
    if (/^[\-*+]\s+/.test(line)) {
      const items: BlockNode[] = []
      while (i < lines.length && /^[\-*+]\s+/.test(lines[i])) {
        items.push({
          type: 'listItem',
          children: [{ type: 'paragraph', children: parseInline(lines[i].replace(/^[\-*+]\s+/, '')) }],
        })
        i++
      }
      blocks.push({ type: 'list', ordered: false, children: items })
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const first = line.match(/^(\d+)\.\s+/)
      const start = first ? parseInt(first[1], 10) : 1
      const items: BlockNode[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push({
          type: 'listItem',
          children: [{ type: 'paragraph', children: parseInline(lines[i].replace(/^\d+\.\s+/, '')) }],
        })
        i++
      }
      blocks.push({ type: 'list', ordered: true, start, children: items })
      continue
    }
    if (line.includes('|') && line.trim().startsWith('|')) {
      const rows: BlockNode[] = []
      while (i < lines.length && lines[i].includes('|')) {
        const trimmed = lines[i].trim()
        if (!/^\|[\s\-:|]+\|$/.test(trimmed)) {
          const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim())
          rows.push({ type: 'tableRow', children: cells.map((c) => ({ type: 'tableCell', children: parseInline(c) })) })
        }
        i++
      }
      if (rows.length > 0) blocks.push({ type: 'table', children: rows })
      continue
    }
    const paragraph: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('>') &&
      !lines[i].startsWith('```') &&
      !/^[-*+]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^[-*_]{3,}\s*$/.test(lines[i]) &&
      !(lines[i].includes('|') && lines[i].trim().startsWith('|'))
    ) {
      paragraph.push(lines[i])
      i++
    }
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) })
  }
  return { type: 'root', children: blocks }
}

function collectImages(node: BlockNode | InlineNode, ctx: ConvertContext): void {
  const anyNode = node as { type?: string; url?: string; alt?: string; children?: unknown[] }
  if (anyNode.type === 'image' && typeof anyNode.url === 'string') {
    ctx.imageQueue.push({ src: anyNode.url, alt: anyNode.alt || '' })
  }
  if (Array.isArray(anyNode.children)) {
    for (const child of anyNode.children) collectImages(child as BlockNode | InlineNode, ctx)
  }
}

function isEmptyParagraph(node: ProseNode): boolean {
  return node.type === 'paragraph' && (!node.content || node.content.length === 0)
}

function imageNode(node: { url: string; alt?: string }, ctx: ConvertContext): ProseNode[] {
  const uploaded = ctx.uploadedImages.get(node.url)
  const displayWidth = 410
  if (uploaded) {
    const height = uploaded.width > 0 ? Math.round((displayWidth * uploaded.height) / uploaded.width) : 0
    return [
      {
        type: 'image',
        attrs: { imgs: [{ src: uploaded.url, desc: '', percent: 30, width: displayWidth, height }] },
      },
    ]
  }
  return [
    { type: 'image', attrs: { imgs: [{ src: node.url, desc: '', percent: 30, width: displayWidth, height: 0 }] } },
  ]
}

function inlineNodes(nodes: InlineNode[], ctx: ConvertContext): ProseNode[] {
  const caps = ctx.capabilities
  const result: ProseNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        if (node.value) result.push({ type: 'text', text: node.value })
        break
      case 'strong':
        if (caps.supportBold) {
          for (const child of inlineNodes(node.children, ctx)) {
            if (child.type === 'text') child.marks = [...(child.marks || []), { type: 'bold' }]
            result.push(child)
          }
        } else if (caps.supportHighlight) {
          for (const child of inlineNodes(node.children, ctx)) {
            if (child.type === 'text') child.marks = [...(child.marks || []), { type: 'highlight' }]
            result.push(child)
          }
        } else {
          result.push(...inlineNodes(node.children, ctx))
        }
        break
      case 'emphasis':
        if (caps.supportItalic) {
          for (const child of inlineNodes(node.children, ctx)) {
            if (child.type === 'text') child.marks = [...(child.marks || []), { type: 'italic' }]
            result.push(child)
          }
        } else {
          result.push(...inlineNodes(node.children, ctx))
        }
        break
      case 'delete':
        if (caps.supportStrikethrough) {
          for (const child of inlineNodes(node.children, ctx)) {
            if (child.type === 'text') child.marks = [...(child.marks || []), { type: 'strike' }]
            result.push(child)
          }
        } else {
          result.push(...inlineNodes(node.children, ctx))
        }
        break
      case 'inlineCode':
        if (caps.supportInlineCode) {
          result.push({ type: 'text', text: node.value, marks: [{ type: 'code' }] })
        } else {
          result.push({ type: 'text', text: node.value })
        }
        break
      case 'link':
        if (caps.supportLink) {
          for (const child of inlineNodes(node.children, ctx)) {
            if (child.type === 'text') {
              child.marks = [...(child.marks || []), { type: 'link', attrs: { href: node.url } }]
            }
            result.push(child)
          }
        } else {
          result.push(...inlineNodes(node.children, ctx))
        }
        break
      case 'image':
      case 'break':
        break
      default:
        if ('children' in node && Array.isArray((node as { children?: InlineNode[] }).children)) {
          result.push(...inlineNodes((node as { children: InlineNode[] }).children, ctx))
        }
    }
  }
  return result
}

function blockquoteAsParagraphs(
  node: Extract<BlockNode, { type: 'blockquote' }>,
  ctx: ConvertContext
): ProseNode[] {
  const result: ProseNode[] = []
  for (const child of node.children || []) {
    if (child.type !== 'paragraph') continue
    const content = inlineNodes(child.children || [], ctx)
    content.unshift({ type: 'text', text: '> ' })
    result.push({ type: 'paragraph', content })
  }
  return result
}

function tableAsParagraphs(node: Extract<BlockNode, { type: 'table' }>): ProseNode[] {
  const result: ProseNode[] = []
  for (const row of node.children || []) {
    if (row.type !== 'tableRow') continue
    const text = (row.children || [])
      .filter((cell) => cell.type === 'tableCell')
      .map((cell) =>
        (cell.children || [])
          .map((inline) => {
            if (inline.type === 'text') return inline.value
            if ('children' in inline && Array.isArray(inline.children)) {
              return inline.children.map((c) => (('value' in c && c.value) || '') as string).join('')
            }
            return ''
          })
          .join('')
      )
      .join(' | ')
    if (text.trim()) result.push({ type: 'paragraph', content: [{ type: 'text', text }] })
  }
  return result
}

function listNode(node: BlockNode & { type: 'list' }, ctx: ConvertContext): ProseNode[] {
  const content = mapBlocks(node.children || [], ctx)
  if (node.ordered) {
    return [{ type: 'orderedList', attrs: { start: node.start || 1, type: null }, content }]
  }
  return [{ type: 'bulletList', content }]
}

function listItemNode(
  node: Extract<BlockNode, { type: 'listItem' }>,
  ctx: ConvertContext
): ProseNode[] {
  const caps = ctx.capabilities
  const content: ProseNode[] = []
  for (const child of node.children || []) {
    if (child.type === 'paragraph') {
      content.push({ type: 'paragraph', content: inlineNodes(child.children || [], ctx) })
    } else if (child.type === 'list') {
      if (caps.supportNestedList) {
        content.push(...listNode(child, ctx))
      } else {
        for (const inner of child.children || []) {
          if (inner.type !== 'listItem') continue
          for (const paragraph of inner.children || []) {
            if (paragraph.type === 'paragraph') {
              content.push({
                type: 'paragraph',
                content: [{ type: 'text', text: '  • ' }, ...inlineNodes(paragraph.children || [], ctx)],
              })
            }
          }
        }
      }
    }
  }
  return [{ type: 'listItem', content: content.length > 0 ? content : [{ type: 'paragraph' }] }]
}

function paragraphNode(node: BlockNode & { type: 'paragraph' }, ctx: ConvertContext): ProseNode[] {
  const children = node.children || []
  if (children.some((c) => c.type === 'image') && ctx.capabilities.supportImage) {
    const result: ProseNode[] = []
    let textBuffer: InlineNode[] = []
    for (const child of children) {
      if (child.type === 'image') {
        if (textBuffer.length > 0) {
          const content = inlineNodes(textBuffer, ctx)
          if (content.length > 0) result.push({ type: 'paragraph', content })
          textBuffer = []
        }
        result.push(...imageNode(child, ctx))
      } else {
        textBuffer.push(child)
      }
    }
    if (textBuffer.length > 0) {
      const content = inlineNodes(textBuffer, ctx)
      if (content.length > 0) result.push({ type: 'paragraph', content })
    }
    return result.length > 0 ? result : [{ type: 'paragraph' }]
  }
  const content = inlineNodes(children, ctx)
  return content.length === 0 ? [{ type: 'paragraph' }] : [{ type: 'paragraph', content }]
}

function mapBlock(node: BlockNode, ctx: ConvertContext): ProseNode[] {
  const caps = ctx.capabilities
  switch (node.type) {
    case 'heading':
      return [
        {
          type: 'heading',
          attrs: { level: Math.min(node.depth, caps.maxHeadingLevel) },
          content: inlineNodes(node.children || [], ctx),
        },
      ]
    case 'paragraph':
      return paragraphNode(node, ctx)
    case 'blockquote':
      return caps.supportBlockquote
        ? [{ type: 'blockquote', content: mapBlocks(node.children || [], ctx) }]
        : blockquoteAsParagraphs(node, ctx)
    case 'list':
      return listNode(node, ctx)
    case 'listItem':
      return listItemNode(node, ctx)
    case 'table':
      return caps.supportTable ? [] : tableAsParagraphs(node)
    case 'thematicBreak':
      return caps.supportHorizontalRule ? [{ type: 'horizontalRule' }] : []
    case 'code':
      return caps.supportCodeBlock
        ? [{ type: 'codeBlock', attrs: { language: node.lang || '' }, content: [{ type: 'text', text: node.value }] }]
        : [{ type: 'paragraph', content: [{ type: 'text', text: node.value }] }]
    case 'image':
      return caps.supportImage
        ? imageNode(node, ctx)
        : [{ type: 'paragraph', content: [{ type: 'text', text: `[图片: ${node.alt || node.url}]` }] }]
    default:
      return []
  }
}

function mapBlocks(nodes: BlockNode[], ctx: ConvertContext): ProseNode[] {
  const result: ProseNode[] = []
  for (const node of nodes) result.push(...mapBlock(node, ctx))
  return result
}

function serialize(node: ProseNode): ProseNode {
  const out: ProseNode = { type: node.type }
  if (node.attrs !== undefined) out.attrs = node.attrs
  if (node.marks !== undefined) {
    out.marks = node.marks.map((mark) => {
      const m: ProseMark = { type: mark.type }
      if (mark.attrs !== undefined) m.attrs = mark.attrs
      return m
    })
  }
  if (node.content !== undefined) {
    const content = node.content
      .filter((child) => !(child.type === 'text' && (!child.text || child.text === '')))
      .map(serialize)
    if (content.length > 0) out.content = content
  }
  if (node.text !== undefined) out.text = node.text
  return out
}

export async function markdownToProsemirror(
  markdown: string,
  capabilities: PlatformCapabilities,
  options?: ConvertImageOptions
): Promise<{ type: 'doc'; content: ProseNode[] }> {
  const ctx: ConvertContext = {
    capabilities,
    uploadImage: options?.uploadImage,
    onImageProgress: options?.onImageProgress,
    uploadedImages: new Map(),
    imageQueue: [],
  }

  const root = parseBlocks(markdown)
  collectImages(root, ctx)

  if (ctx.uploadImage && ctx.imageQueue.length > 0) {
    let current = 0
    for (const image of ctx.imageQueue) {
      if (ctx.uploadedImages.has(image.src)) continue
      try {
        current++
        ctx.onImageProgress?.(current, ctx.imageQueue.length)
        const uploaded = await ctx.uploadImage(image.src)
        ctx.uploadedImages.set(image.src, {
          url: uploaded.url,
          width: uploaded.width || 800,
          height: uploaded.height || 600,
          fileId: uploaded.fileId,
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
      } catch (error) {
        console.error('Failed to upload image:', image.src, error)
      }
    }
  }

  let content = mapBlocks(root.children || [], ctx)
  while (content.length > 0 && isEmptyParagraph(content[0])) content.shift()
  if (content.length === 0) content.push({ type: 'paragraph' })
  return { type: 'doc', content: content.map(serialize) }
}
