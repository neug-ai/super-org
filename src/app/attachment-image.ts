import { AttachmentReadError } from './attachment-text.ts'

const maxImageBytes = 10 * 1024 * 1024
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const jpeg = Buffer.from([0xff, 0xd8, 0xff])

export type ProjectImage = { bytes: Buffer; extension: '.png' | '.jpg' | '.webp' }
export const imageExtension = (extension: string) => ['.png', '.jpeg', '.jpg', '.webp'].includes(extension)

/** Identify the actual image bytes, regardless of the sender's filename or HTTP headers. */
export function readAttachmentImage(bytes: Buffer): ProjectImage {
  if (bytes.length > maxImageBytes) throw new AttachmentReadError('图片超过 10 MiB，请压缩后重发。')
  if (bytes.subarray(0, png.length).equals(png)) return { bytes, extension: '.png' }
  if (bytes.subarray(0, jpeg.length).equals(jpeg)) return { bytes, extension: '.jpg' }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return { bytes, extension: '.webp' }
  throw new AttachmentReadError('图片内容无法识别，请发送 PNG、JPEG 或 WebP。')
}
