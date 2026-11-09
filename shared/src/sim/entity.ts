import { EntityId } from "../types.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

export type EntityKind = "ship" | "bullet" | "asteroid" | "pickup" | "explosion";

/** Компонент наведення (композиція, Лаба 2). */
export interface Homing {
  readonly targetKind: EntityKind;
  readonly turnRate: number;
  readonly range: number;
  readonly ignoreId: EntityId | null;
}

export interface EntityInit {
  pos?: Vector2;
  vel?: Vector2;
  angle?: number;
  radius?: number;
}

/**
 * Базова сутність. Нащадки — рівно один рівень (Ship, Bullet, Asteroid, Pickup, Explosion);
 * кожен оголошує літеральний `kind`, тож `GameEntity` — дискриміноване об'єднання.
 */
export abstract class Entity {
  static #nextId = 1;
  readonly #id: EntityId = EntityId(Entity.#nextId++);

  /** Для тестів і еталонного сценарію: почати нумерацію спочатку. */
  static resetIds(start = 1): void {
    Entity.#nextId = start;
  }

  abstract readonly kind: EntityKind;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  alive = true;
  collidable: boolean;
  prevPos: Vector2;
  prevAngle: number;
  homing: Homing | null = null;

  constructor({ pos = Vector2.ZERO, vel = Vector2.ZERO, angle = 0, radius = 0 }: EntityInit) {
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.collidable = radius > 0;
    this.prevPos = pos;
    this.prevAngle = angle;
  }

  get id(): EntityId {
    return this.#id;
  }

  savePrev(): void {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  /** Поведінка за замовчуванням: рух з постійною швидкістю. */
  update(dt: number, _world: World): void {
    this.pos = this.pos.add(this.vel.scale(dt));
  }
}
