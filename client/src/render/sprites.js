/**
 * Спрайт-аркуш: одна картинка + атлас (координати кадрів).
 * drawImage з прямокутником-джерелом малює потрібний кадр.
 */
export function createSprites(sheet, atlas) {
  if (!sheet || !atlas?.frames) return null;
  const { frames } = atlas;

  /**
   * Малює кадр по центру поточної трансформації.
   * @param {number} worldSize — бажаний розмір кадру у світових px
   */
  function draw(ctx, name, worldSize) {
    const f = frames[name];
    if (!f) return false;
    const half = worldSize / 2;
    ctx.drawImage(sheet, f.x, f.y, f.w, f.h, -half, -half, worldSize, worldSize);
    return true;
  }

  /** Розмір кадру у світі з урахуванням масштабу, з яким його малювали. */
  function naturalSize(name) {
    const f = frames[name];
    return f ? f.w / f.scale : 0;
  }

  return { draw, naturalSize, has: (name) => name in frames };
}
