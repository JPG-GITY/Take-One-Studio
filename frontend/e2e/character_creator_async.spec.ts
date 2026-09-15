import { test, expect } from './isolation'

// El Character Creator no retiene al usuario mientras se escribe la lámina.
//
// Al pulsar "Generate character sheet" el modal construía el prompt de la lámina — una
// llamada al backend con 120 s de timeout — y sólo se cerraba cuando respondía. Durante ese
// minuto largo el Studio quedaba inservible detrás del modal. Ahora el modal entrega la
// PETICIÓN y se cierra al instante: el Studio muestra la tarjeta pendiente en el timeline y
// la generación sigue por su cuenta.
//
// Se fija con el montaje del prompt DELIBERADAMENTE LENTO: si el modal esperara, el test
// fallaría en la primera aserción.

const PROMPT_BUILD_MS = 3000

const open = async (page: import('@playwright/test').Page) => {
  const sent: Array<{ prompt?: string; count?: number }> = []
  let buildCalls = 0
  await page.route('**/api/assets/board-prompt', async (r) => {
    buildCalls++
    await new Promise((res) => setTimeout(res, PROMPT_BUILD_MS))
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ board_prompt: 'ASSEMBLED SHEET PROMPT — full body, grey seamless' }) })
  })
  await page.route('**/api/studio/image', (r) => {
    sent.push(r.request().postDataJSON() as { prompt?: string; count?: number })
    return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'stub' }) })
  })
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByTestId('studio-toggle').click({ timeout: 20_000 })
  await page.waitForTimeout(1200)
  await page.getByTestId('studio-mode').click()
  await page.getByTestId('open-character-creator').click()
  await expect(page.getByText('AI Character Creator')).toBeVisible({ timeout: 15_000 })
  return { sent, builds: () => buildCalls }
}

test('generar una lámina cierra el modal al instante y sigue en el timeline', async ({ page }) => {
  test.setTimeout(90_000)
  const { sent, builds } = await open(page)
  await page.getByPlaceholder(/man in his 30s/).fill('man in his 30s, lean build, curly dark hair')

  const t0 = Date.now()
  await page.getByTestId('cc-generate-character').click()
  // Cerrado antes de que el montaje del prompt haya podido siquiera responder.
  await expect(page.getByText('AI Character Creator')).toHaveCount(0, { timeout: PROMPT_BUILD_MS - 1000 })
  const closedIn = Date.now() - t0
  console.log(`[cc] modal cerrado en ${closedIn} ms (el prompt tarda ${PROMPT_BUILD_MS} ms)`)
  expect(closedIn).toBeLessThan(PROMPT_BUILD_MS)

  // Y el trabajo se ve: tarjeta pendiente con lo que el director escribió.
  const pending = page.getByTestId('studio-pending-image')
  await expect(pending).toBeVisible()
  await expect(pending).toContainText('man in his 30s')

  // El prompt se montó una vez y la generación sale con el texto ensamblado, no con la descripción.
  await expect.poll(() => sent.length, { timeout: 30_000, intervals: [300] }).toBe(1)
  console.log('[cc] enviado →', JSON.stringify(sent[0]).slice(0, 160))
  expect(builds()).toBe(1)
  expect(sent[0].prompt).toContain('ASSEMBLED SHEET PROMPT')
})

test('sin descripción no se cierra: el aviso se ve donde se escribe', async ({ page }) => {
  const { sent, builds } = await open(page)
  await page.getByTestId('cc-generate-character').click()
  await expect(page.getByText(/Describe the character first/)).toBeVisible()
  await expect(page.getByText('AI Character Creator')).toBeVisible()
  expect(builds()).toBe(0)
  expect(sent.length).toBe(0)
})
