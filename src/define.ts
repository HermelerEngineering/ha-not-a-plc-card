/**
 * An idempotent replacement for Lit's `@customElement` decorator.
 *
 * With the editor panel installed, this bundle is loaded twice (once as the
 * panel `module_url`, once as the Lovelace card resource). Lit's built-in
 * `@customElement` calls `customElements.define` unconditionally, so the second
 * load throws `Failed to execute 'define'… has already been used`. Guarding on
 * `customElements.get` makes the define a no-op on the second load (the first
 * registration wins), so the bundle is safe to import more than once.
 */
export function defineOnce(name: string) {
  return function <T extends CustomElementConstructor>(cls: T): T {
    if (!customElements.get(name)) customElements.define(name, cls);
    return cls;
  };
}
