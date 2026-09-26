import { createWorker, type Worker } from 'tesseract.js'

let workerPromise: Promise<Worker> | null = null

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(['jpn', 'eng'])
      await worker.setParameters({
        preserve_interword_spaces: '1',
      })
      return worker
    })()
  }
  return workerPromise
}

/** Focus OCR on the middle card band of a phone screenshot. */
async function cropForPostcard(image: File | Blob | string): Promise<Blob> {
  if (typeof createImageBitmap === 'undefined') {
    // Node smoke tests: no canvas crop
    if (typeof image === 'string') {
      const res = await fetch(image)
      return res.blob()
    }
    return image
  }

  let blob: Blob
  if (typeof image === 'string') {
    const res = await fetch(image)
    blob = await res.blob()
  } else {
    blob = image
  }

  const bitmap = await createImageBitmap(blob)
  const w = bitmap.width
  const h = bitmap.height
  // Center band where Pikmin Bloom postcard card usually sits
  const sx = Math.floor(w * 0.08)
  const sy = Math.floor(h * 0.12)
  const sw = Math.floor(w * 0.84)
  const sh = Math.floor(h * 0.62)

  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return blob
  }
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  bitmap.close()

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas toBlob failed'))),
      'image/png',
    )
  })
}

export async function recognizeText(
  image: File | Blob | string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const worker = await getWorker()
  onProgress?.(15)
  let target: File | Blob | string = image
  try {
    target = await cropForPostcard(image)
  } catch {
    target = image
  }
  onProgress?.(40)
  const result = await worker.recognize(target)
  onProgress?.(100)
  return result.data.text ?? ''
}

export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return
  const w = await workerPromise
  await w.terminate()
  workerPromise = null
}
