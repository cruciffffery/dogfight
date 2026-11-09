import { Vector2 } from "./vector.js";

/**
 * Базова сутність. Усі ігрові об'єкти успадковуються від неї РІВНО на один рівень
 * (Ship, Bullet, Asteroid, Pickup, Explosion). Поведінку, яку треба ділити між різними
 * гілками (наведення, ефекти підсилювачів), додаємо композицією — полями-компонентами,
 * а не новими рівнями ієрархії (див. README, «Композиція замість успадкування»).
 */
export class Entity {
  // Приватний статичний лічильник: ззовні не можна ні прочитати, ні «зламати» нумерацію
  static #nextId = 1;
  #id = Entity.#nextId++;

  /** Для тестів і нового матчу: почати нумерацію спочатку. */
  static resetIds(start = 1) {
    Entity.#nextId = start;
  }

  constructor({ kind, pos = Vector2.ZERO, vel = Vector2.ZERO, angle = 0, radius = 0 }) {
    this.kind = kind;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.alive = true;
    this.collidable = radius > 0;
    // стан попереднього кроку — для інтерполяції в рендері
    this.prevPos = pos;
    this.prevAngle = angle;
    // компоненти композиції (null = немає)
    this.homing = null;
  }

  get id() {
    return this.#id;
  }

  /** Викликається світом на початку кроку. */
  savePrev() {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  /** Поведінка за замовчуванням: рух з постійною швидкістю. Наслідники перевизначають. */
  update(dt, _world) {
    this.pos = this.pos.add(this.vel.scale(dt));
  }
}
