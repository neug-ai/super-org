import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { readAttachmentText } from '../src/app/attachment-text.ts'

it('labels PPTX text by presentation order rather than the names of slide files', async () => {
  const bytes = readFileSync(new URL('./fixtures/reordered-slides.pptx', import.meta.url))
  await expect(readAttachmentText('reordered-slides.pptx', bytes, new AbortController().signal)).resolves.toEqual({
    text: '[幻灯片 1]\nFirst & reordered\n\n[幻灯片 2]\nSecond in the presentation',
    partial: true,
  })
})
