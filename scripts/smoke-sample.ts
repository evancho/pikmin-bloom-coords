/**
 * Smoke: OCR sample postcard → parse → geocode.
 * Run: npx tsx scripts/smoke-sample.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorker } from 'tesseract.js'
import { formatCoords } from '../src/lib/coords.ts'
import { geocodeBest } from '../src/lib/geocode.ts'
import { parseLocationFromOcr, localityHints } from '../src/lib/parseLocation.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sample = join(root, 'public/samples/postcard-taki-jinja.jpg')

async function main() {
  const buf = readFileSync(sample)
  console.log('OCR starting…')
  const worker = await createWorker('jpn+eng')
  const { data } = await worker.recognize(buf)
  await worker.terminate()
  console.log('--- OCR text ---')
  console.log(data.text)
  const parsed = parseLocationFromOcr(data.text ?? '')
  console.log('--- parsed ---')
  console.log(JSON.stringify(parsed, null, 2))
  const { candidates, usedQuery } = await geocodeBest(
    parsed.searchQueries,
    undefined,
    localityHints(parsed),
  )
  console.log('--- geocode ---')
  console.log('usedQuery:', usedQuery)
  for (const c of candidates) {
    console.log(formatCoords(c.lat, c.lng), '·', c.displayName)
  }
  if (!candidates.length) {
    console.error('No candidates found')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
