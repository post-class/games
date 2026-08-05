/** DOM 生成の小さなヘルパ。フレームワークを入れずに読みやすさを保つため。 */

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  node.addEventListener(type, handler as EventListener);
}

export function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const node = el('button', { class: className, type: 'button' }, label);
  node.addEventListener('click', onClick);
  return node;
}

/** 一時的な通知。エラーも成功もここに出す。 */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  let host = document.querySelector<HTMLElement>('.toast-host');
  if (!host) {
    host = el('div', { class: 'toast-host' });
    document.body.appendChild(host);
  }
  const node = el('div', { class: `toast toast-${kind}` }, message);
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 400);
  }, 2600);
}

export interface ModalHandle {
  close(): void;
  body: HTMLElement;
}

export interface ModalOptions {
  onClose?: () => void;
  /**
   * 背後のステージを見せたまま開く。
   * おへやの模様替えのように、結果を見ながら操作したい画面で使う
   * （プレイテストで、家具を置いても画面が隠れて見えなかった）。
   */
  compact?: boolean;
}

export function modal(
  title: string,
  onCloseOrOptions?: (() => void) | ModalOptions,
): ModalHandle {
  const options: ModalOptions =
    typeof onCloseOrOptions === 'function' ? { onClose: onCloseOrOptions } : (onCloseOrOptions ?? {});
  const onClose = options.onClose;
  const body = el('div', { class: 'modal-body' });
  const closeBtn = button('×', () => handle.close(), 'modal-close');
  const box = el(
    'div',
    { class: `modal-box ${options.compact ? 'modal-compact' : ''}` },
    el('header', { class: 'modal-head' }, el('h2', { class: 'modal-title' }, title), closeBtn),
    body,
  );
  const backdrop = el(
    'div',
    { class: `modal-backdrop ${options.compact ? 'modal-backdrop-clear' : ''}` },
    box,
  );
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) handle.close();
  });
  document.body.appendChild(backdrop);

  const handle: ModalHandle = {
    body,
    close() {
      backdrop.remove();
      onClose?.();
    },
  };
  return handle;
}
