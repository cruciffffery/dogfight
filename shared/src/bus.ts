/**
 * Типізована шина подій поверх EventTarget (є і в браузері, і в Node).
 *
 *   const bus = new Bus<{ hit: { id: EntityId } }>();
 *   bus.on("hit", (d) => d.id);      // d: { id: EntityId } — тип виводиться з назви події
 *   bus.emit("hit", { id });          // помилка компіляції, якщо detail не тієї форми
 *   bus.emit("hti", …);               // помилка компіляції: такої події немає
 *
 * Generic-параметр M пов'язує назву події з формою її payload — без жодних приведень типів.
 */
export class Bus<M extends object> extends EventTarget {
  emit<K extends keyof M & string>(type: K, detail: M[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on<K extends keyof M & string>(
    type: K,
    fn: (detail: M[K]) => void,
    options?: { once?: boolean; signal?: AbortSignal },
  ): () => void {
    const listener = (e: Event): void => {
      if (e instanceof CustomEvent) fn(e.detail);
    };
    this.addEventListener(type, listener, options);
    return () => this.removeEventListener(type, listener);
  }
}
