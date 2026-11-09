/**
 * querySelector з перевіркою типу в рантаймі замість `as HTMLInputElement`:
 * якщо розмітка зміниться, отримаємо зрозумілу помилку, а не undefined.value.
 */
export function $<T extends Element>(
  root: ParentNode,
  selector: string,
  ctor: abstract new () => T,
): T {
  const el = root.querySelector(selector);
  if (!(el instanceof ctor)) throw new Error(`Expected ${ctor.name} for "${selector}"`);
  return el;
}
