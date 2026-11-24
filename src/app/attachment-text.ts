import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, posix } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { SaxesParser } from 'saxes'
import { fromBuffer, type Entry, type ZipFile } from 'yauzl'

const exec = promisify(execFile)
export const maxAttachmentBytes = 25 * 1024 * 1024
const maxExtractBytes = 2 * 1024 * 1024
const maxText = 18_000
const maxSlides = 120
const skippedTags = new Set(['script', 'style', 'head', 'iframe', 'template', 'noscript', 'object', 'svg'])

/** An attachment failure whose message is safe to show in the originating conversation. */
export class AttachmentReadError extends Error {}

function htmlText(data: Buffer): string {
  const text: string[] = []
  const nodes: DefaultTreeAdapterMap['node'][] = [parse(data.toString('utf8'))]
  let length = 0
  while (nodes.length && length < maxText) {
    const node = nodes.pop()!
    if ('tagName' in node && skippedTags.has(node.tagName)) continue
    if ('value' in node && typeof node.value === 'string') {
      const value = node.value.trim()
      if (value) { text.push(value); length += value.length + 1 }
    }
    if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) nodes.push(node.childNodes[i]!)
  }
  return text.join('\n')
}

function slideText(xml: string): string {
  const parser = new SaxesParser({ xmlns: true })
  const pieces: string[] = []
  let inText = false
  parser.on('opentag', tag => { inText = tag.local === 't' && ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'].includes(tag.uri) })
  parser.on('closetag', tag => {
    if (tag.local === 'p') pieces.push('\n')
    inText = false
  })
  parser.on('text', text => { if (inText) pieces.push(text) })
  parser.write(xml).close()
  return pieces.join('').trim()
}

function openZip(data: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => fromBuffer(data, { lazyEntries: true, autoClose: false }, (error, zip) => {
    if (error || !zip) reject(error ?? new Error('Missing PowerPoint archive'))
    else resolve(zip)
  }))
}

function orderedSlides(presentation: string, relationships: string): string[] {
  const targets = new Map<string, string>()
  const rels = new SaxesParser({ xmlns: true })
  rels.on('opentag', tag => {
    const { Id, Type, Target, TargetMode } = tag.attributes
    if (tag.local !== 'Relationship' || !Id || !Target || !Type?.value.endsWith('/slide') || TargetMode?.value === 'External') return
    targets.set(Id.value, Target.value.startsWith('/') ? Target.value.slice(1) : posix.join('ppt', Target.value))
  })
  rels.write(relationships).close()
  const order: string[] = []
  const manifest = new SaxesParser({ xmlns: true })
  manifest.on('opentag', tag => {
    if (tag.local !== 'sldId') return
    const id = Object.values(tag.attributes).find(attr => attr.local === 'id' && attr.uri.endsWith('/relationships'))
    const target = id && targets.get(id.value)
    if (!target) throw new AttachmentReadError('无法确定这份演示稿的幻灯片顺序。')
    order.push(target)
  })
  manifest.write(presentation).close()
  return order
}

async function presentationText(data: Buffer): Promise<string> {
  const zip = await openZip(data)
  try {
    const manifest = 'ppt/presentation.xml'
    const rels = 'ppt/_rels/presentation.xml.rels'
    const entries = await new Promise<Map<string, Entry>>((resolve, reject) => {
      const found = new Map<string, Entry>()
      zip.on('error', reject)
      zip.on('end', () => resolve(found))
      zip.on('entry', (entry: Entry) => {
        if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.fileName) || entry.fileName === manifest || entry.fileName === rels) {
          found.set(entry.fileName, entry)
          if (found.size > maxSlides + 2) { reject(new AttachmentReadError('演示文稿页数超过读取上限。')); return }
        }
        zip.readEntry()
      })
      zip.readEntry()
    })
    let totalBytes = 0
    const extract = async (path: string) => {
      const entry = entries.get(path)
      if (!entry) throw new AttachmentReadError('演示文稿缺少幻灯片或顺序信息。')
      totalBytes += entry.uncompressedSize
      if (totalBytes > maxExtractBytes) throw new AttachmentReadError('演示文稿的可提取内容超过读取上限。')
      const stream = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(error ?? new Error('Missing slide')); return }
        resolve(stream)
      }))
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of stream) {
        bytes += chunk.length
        if (bytes > entry.uncompressedSize) throw new AttachmentReadError('幻灯片数据超过声明的大小。')
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString('utf8')
    }
    const order = orderedSlides(await extract(manifest), await extract(rels))
    if (order.length > maxSlides) throw new AttachmentReadError('演示文稿页数超过读取上限。')
    const pages: string[] = []
    let length = 0
    for (const [index, path] of order.entries()) {
      const text = slideText(await extract(path))
      if (!text) continue
      pages.push(`[幻灯片 ${index + 1}]\n${text}`)
      length += text.length
      if (length >= maxText) break
    }
    return pages.join('\n\n')
  } finally { zip.close() }
}

async function pdfText(data: Buffer, signal: AbortSignal): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'super-org-attachment-'))
  try {
    const path = join(directory, 'document.pdf')
    await writeFile(path, data, { mode: 0o600 })
    try {
      const { stdout } = await exec('pdftotext', ['-layout', path, '-'], { signal, timeout: 15_000, maxBuffer: maxExtractBytes })
      return stdout.split('\f').map((page, index) => page.trim() && `[第 ${index + 1} 页]\n${page.trim()}`).filter(Boolean).join('\n\n')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AttachmentReadError('服务尚未安装 PDF 文本提取工具 pdftotext。')
      throw error
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export function attachmentFormat(name: string): string {
  return extname(name).toLowerCase()
}

export const supportedAttachment = (name: string) => ['.htm', '.html', '.pptx', '.pdf', '.txt', '.md'].includes(attachmentFormat(name))

export async function readAttachmentText(name: string, data: Buffer, signal: AbortSignal): Promise<{ text: string; partial: boolean }> {
  if (data.length > maxAttachmentBytes) throw new AttachmentReadError('附件超过大小上限。')
  const format = attachmentFormat(name)
  if (['.html', '.htm', '.txt', '.md'].includes(format) && data.length > maxExtractBytes) throw new AttachmentReadError('文本附件超过读取上限。')
  const text = (format === '.pptx' ? await presentationText(data) : format === '.pdf' ? await pdfText(data, signal)
    : format === '.htm' || format === '.html' ? htmlText(data) : data.toString('utf8')).trim()
  if (!text) throw new AttachmentReadError('附件没有可提取的文字，可能只有图片或扫描件。')
  return { text: text.slice(0, maxText), partial: text.length >= maxText || ['.html', '.htm', '.pdf', '.pptx'].includes(format) }
}
