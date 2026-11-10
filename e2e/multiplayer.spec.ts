/**
 * E2E: справжній сервер (webServer у playwright.config.ts), два окремі браузерні контексти
 * (як два різні гравці), одна кімната.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";

/** Мінімальна форма тестових ручок window.__lab, яку читає цей тест. */
declare global {
  interface Window {
    __lab: {
      welcome?: { shipId: number; playerId: number };
      conn?: { isOpen: boolean; on(type: "welcome", fn: () => void): () => void };
      welcomes?: number;
      game?: { buffer: { items: { byId: Map<number, { x: number; y: number }> }[] } };
    };
  }
}

async function join(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/?room=alpha&name=${name}&fast`);
  await page.waitForFunction(() => window.__lab.game !== undefined);
  return page;
}

const roster = (page: Page) => page.locator(".room-ui .roster");

test("two players: same roster, movement is seen by the other, chat arrives", async ({
  browser,
}) => {
  const ann = await join(browser, "Ann");
  const bob = await join(browser, "Bob");

  // 1. Склад однаковий в обох
  await expect(roster(ann)).toContainText("Ann");
  await expect(roster(ann)).toContainText("Bob");
  await expect(roster(bob)).toHaveText((await roster(ann).textContent()) ?? "");

  // 2. Ann летить — Bob бачить рух її корабля не пізніше ніж за 500 мс
  const annShip = await ann.evaluate(() => window.__lab.welcome?.shipId ?? -1);
  const positionOfAnnSeenByBob = () =>
    bob.evaluate((id) => {
      const last = window.__lab.game?.buffer.items.at(-1);
      const e = last?.byId.get(id);
      return e ? { x: e.x, y: e.y } : null;
    }, annShip);

  const before = await positionOfAnnSeenByBob();
  expect(before).not.toBeNull();
  await ann.bringToFront();
  await ann.keyboard.down("ArrowUp");
  const t0 = Date.now();
  await expect
    .poll(
      async () => {
        const now = await positionOfAnnSeenByBob();
        return now && before ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
      },
      { timeout: 500, intervals: [25] },
    )
    .toBeGreaterThan(2);
  const seenAfter = Date.now() - t0;
  await ann.keyboard.up("ArrowUp");
  test.info().annotations.push({ type: "movement-seen-after-ms", description: String(seenAfter) });

  // 3. Чат
  await ann.keyboard.press("Enter");
  await ann.keyboard.type("hello from e2e");
  await ann.keyboard.press("Enter");
  await expect(bob.locator(".room-ui .msgs")).toContainText("Ann: hello from e2e");
});

test("lobby lists rooms and a full room is refused", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/?fast");
  await expect(page.getByRole("button", { name: /Duel 1v1/ })).toBeVisible();
  const a = await join(browser, "DuelA").then(async (p) => {
    await p.goto("/?room=duel&name=DuelA&fast");
    return p;
  });
  const b = await (await browser.newContext()).newPage();
  await b.goto("/?room=duel&name=DuelB&fast");
  await b.waitForFunction(() => window.__lab.game !== undefined);
  const c = await (await browser.newContext()).newPage();
  await c.goto("/?room=duel&name=DuelC&fast");
  await expect(c.getByText(/Помилка запуску/)).toBeVisible();
  await a.close();
});
