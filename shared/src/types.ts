/**
 * Брендовані типи: структурно це просто number, але компілятор не дасть переплутати
 * id сутності з номером тіку чи seq команди (усі три — числа, і всі три ходять поруч).
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EntityId = Brand<number, "EntityId">;
export type Tick = Brand<number, "Tick">;
export type Seq = Brand<number, "Seq">;
export type PlayerId = Brand<number, "PlayerId">;

// Єдине місце, де звичайне число «стає» брендованим. Це не `as`-приведення типів у коді
// гри, а функції-конструктори з перевіркою (див. «What TypeScript found» у README).
function brandInt<B extends string>(name: B) {
  return (n: number): Brand<number, B> => {
    if (!Number.isInteger(n) || n < 0)
      throw new RangeError(`${name} must be a non-negative integer`);
    return n as Brand<number, B>; // cast #1: конструктор бренду — єдиний легальний вхід
  };
}

export const EntityId = brandInt("EntityId");
export const Tick = brandInt("Tick");
export const Seq = brandInt("Seq");
export const PlayerId = brandInt("PlayerId");

/** Команда керування — те, що клієнт шле на сервер на кожному тіку. */
export interface Command {
  readonly turn: -1 | 0 | 1;
  readonly thrust: boolean;
  readonly brake: boolean;
  readonly fire: boolean;
}

/** Команда з номером, як її бачить світ. */
export interface SeqCommand extends Command {
  readonly seq: number;
}

export const IDLE_COMMAND: SeqCommand = Object.freeze({
  seq: 0,
  turn: 0,
  thrust: false,
  brake: false,
  fire: false,
});

/** Результат замість винятків на межах системи. */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

/** Для вичерпних switch: якщо сюди дійшли — забули гілку, і tsc це покаже. */
export function assertNever(x: never, what = "value"): never {
  throw new Error(`Unhandled ${what}: ${JSON.stringify(x)}`);
}
