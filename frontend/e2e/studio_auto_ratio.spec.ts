import { test, expect } from './isolation'

// Studio: "Auto" sigue la proporción de la imagen de referencia, y el formato viaja.
//
// Seedream no tiene un "respeta la proporción de la referencia": `size` es un tier o un
// WxH exacto. Así que Auto MIDE la referencia y calcula el WxH a su proporción, al
// presupuesto de píxeles de la calidad elegida, con lados ×16. Antes el selector mandaba
// (1:1 por defecto) aunque la fuente fuera vertical, y el formato ni se enviaba.
//
// Se fija en la RED: qué `size` y qué `output_format` recibe /api/studio/image.

const PNG_1200x1600 = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 1600
  const g = c.getContext('2d')!; g.fillStyle = '#7fa'; g.fillRect(0, 0, 1200, 1600)
  return c.toDataURL('image/png')
})

type Sent = { size?: string; output_format?: string }

const setup = async (page: import('@playwright/test').Page): Promise<Sent[]> => {
  const sent: Sent[] = []
  await page.route('**/api/studio/image', (r) => {
    const b = r.request().postDataJSON() as Sent
    sent.push({ size: b.size, output_format: b.output_format })
    return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'stub' }) })
  })
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByTestId('studio-toggle').click({ timeout: 20_000 })
  await page.waitForTimeout(1200)
  return sent
}

const attachRef = async (page: import('@playwright/test').Page) => {
  const dataUrl = await PNG_1200x1600(page)
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64')
  await page.getByTestId('studio-ref-input').setInputFiles({ name: 'ref.png', mimeType: 'image/png', buffer: bytes })
  await expect(page.getByTestId('studio-ref-thumb').first()).toBeVisible({ timeout: 15_000 })
}

const generate = async (page: import('@playwright/test').Page, sent: Sent[]) => {
  await page.getByPlaceholder(/Describe the scene/).fill('same woman, same pose, studio light')
  await page.getByTestId('studio-generate').click({ timeout: 20_000 })
  await expect.poll(() => sent.length, { timeout: 30_000, intervals: [300] }).toBeGreaterThan(0)
  return sent[sent.length - 1]
}

const ratioOf = (size: string) => { const [w, h] = size.split('x').map(Number); return { w, h, r: w / h, px: w * h } }

test('Auto (por defecto) respeta la proporción de la referencia, en 2K y ×16', async ({ page }) => {
  const sent = await setup(page)
  await attachRef(page)
  const s = await generate(page, sent)
  console.log('[auto] enviado →', JSON.stringify(s))
  expect(s.size).toMatch(/^\d+x\d+$/)
  const { w, h, r, px } = ratioOf(s.size!)
  expect(Math.abs(r - 0.75)).toBeLessThan(0.02)        // 1200/1600
  expect(w % 16).toBe(0); expect(h % 16).toBe(0)
  expect(px).toBeGreaterThanOrEqual(3_686_400)        // suelo Lite
  expect(px).toBeLessThanOrEqual(4_624_220)           // techo Pro (clase 2K)
  expect(s.output_format).toBe('png')                  // formato por defecto
})

test('JPG y 4K: el formato viaja como jpeg y el tamaño sube a la clase 4K sin perder la proporción', async ({ page }) => {
  const sent = await setup(page)
  await attachRef(page)
  await page.getByTestId('img-format-jpeg').click()
  await page.getByTestId('img-quality-4K').click()      // fuerza Lite
  const s = await generate(page, sent)
  console.log('[auto] enviado →', JSON.stringify(s))
  const { r, px } = ratioOf(s.size!)
  expect(Math.abs(r - 0.75)).toBeLessThan(0.02)
  expect(px).toBeGreaterThan(4_624_220)               // más que la clase 2K
  expect(px).toBeLessThanOrEqual(16_777_216)          // techo Lite
  expect(s.output_format).toBe('jpeg')
})

test('sin referencia, Auto cae a 1:1 — no hay de qué inferir', async ({ page }) => {
  const sent = await setup(page)
  const s = await generate(page, sent)
  expect(s.size).toBe('2048x2048')
})
