/**
 * Спрайт-аркуш: картинка + атлас (zod-перевірений JSON).
 */
import { z } from "zod";

export const AtlasSchema = z.object({
  cell: z.number(),
  frames: z.record(
    z.string(),
    z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), scale: z.number() }),
  ),
});
export type Atlas = z.infer<typeof AtlasSchema>;

export interface Sprites {
  draw(ctx: CanvasRenderingContext2D, name: string, worldSize: number): boolean;
  naturalSize(name: string): number;
  has(name: string): boolean;
}

export function createSprites(sheet: unknown, atlasJson: unknown): Sprites | null {
  if (!(sheet instanceof ImageBitmap)) return null;
  const parsed = AtlasSchema.safeParse(atlasJson);
  if (!parsed.success) return null;
  const { frames } = parsed.data;
  return {
    draw(ctx, name, worldSize) {
      const f = frames[name];
      if (!f) return false;
      const half = worldSize / 2;
      ctx.drawImage(sheet, f.x, f.y, f.w, f.h, -half, -half, worldSize, worldSize);
      return true;
    },
    naturalSize(name) {
      const f = frames[name];
      return f ? f.w / f.scale : 0;
    },
    has: (name) => name in frames,
  };
}
