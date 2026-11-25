import React from "react";
import type { HostMessage, ViewMessage } from "../../src/shared/protocol";

// Provide global React for classic JSX compilation under tsx.
(globalThis as any).React = React;

export interface VNode {
  tag: string;
  props: Record<string, any>;
  children: VNodeChild[];
  path: string;
  mockElement: any;
}

export type VNodeChild = VNode | string;

interface HookCell {
  state?: any;
  memo?: { deps: any[] | undefined; value: any };
  ref?: { current: any };
  effect?: {
    fn: () => void | (() => void);
    deps: any[] | undefined;
    cleanup?: () => void;
    hasRun?: boolean;
  };
}

interface ComponentInstance {
  hooks: HookCell[];
  classInstance?: any;
  mounted: boolean;
}

const SYMBOL_MEMO = Symbol.for("react.memo");
const SYMBOL_FORWARD_REF = Symbol.for("react.forward_ref");
const SYMBOL_FRAGMENT = Symbol.for("react.fragment");
const SYMBOL_PROVIDER = Symbol.for("react.provider");

const sharedEnvironment = {
  installed: false,
  storage: new Map<string, string>(),
  docListeners: new Map<string, Set<Function>>(),
  winListeners: new Map<string, Set<Function>>(),
  copiedTexts: [] as string[],
  reloadCount: 0,
  externalOpened: [] as string[],
  postSink: (_msg: ViewMessage) => {},
  bodyDataset: {} as Record<string, string>,
  htmlDataset: {} as Record<string, string>,
};

export function setupBrowserGlobals(): typeof sharedEnvironment {
  if (sharedEnvironment.installed) return sharedEnvironment;
  sharedEnvironment.installed = true;

  const g = globalThis as any;
  g.React = React;

  g.acquireVsCodeApi = () => ({
    postMessage: (msg: ViewMessage) => sharedEnvironment.postSink(msg),
    getState: () => undefined,
    setState: () => {},
  });

  g.localStorage = {
    getItem: (k: string) => sharedEnvironment.storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      sharedEnvironment.storage.set(k, String(v));
    },
    removeItem: (k: string) => {
      sharedEnvironment.storage.delete(k);
    },
    clear: () => {
      sharedEnvironment.storage.clear();
    },
  };

  g.document = {
    body: { dataset: sharedEnvironment.bodyDataset },
    documentElement: {
      dataset: sharedEnvironment.htmlDataset,
      classList: {
        add() {},
        remove() {},
        contains: () => false,
      },
    },
    addEventListener(type: string, fn: Function) {
      let set = sharedEnvironment.docListeners.get(type);
      if (!set) {
        set = new Set();
        sharedEnvironment.docListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: Function) {
      sharedEnvironment.docListeners.get(type)?.delete(fn);
    },
    createElement: () => ({
      style: {},
      focus() {},
      click() {},
      setAttribute() {},
      remove() {},
    }),
  };

  g.window = g;
  g.addEventListener = (type: string, fn: Function) => {
    let set = sharedEnvironment.winListeners.get(type);
    if (!set) {
      set = new Set();
      sharedEnvironment.winListeners.set(type, set);
    }
    set.add(fn);
  };
  g.removeEventListener = (type: string, fn: Function) => {
    sharedEnvironment.winListeners.get(type)?.delete(fn);
  };
  g.dispatchEvent = (ev: any) => {
    const set = sharedEnvironment.winListeners.get(ev.type);
    if (set) {
      for (const fn of [...set]) fn(ev);
    }
    return true;
  };
  g.location = {
    reload: () => {
      sharedEnvironment.reloadCount += 1;
    },
  };
  g.open = (url: string) => {
    sharedEnvironment.externalOpened.push(url);
    return null;
  };

  const clipboardImpl = {
    writeText: (text: string) => {
      sharedEnvironment.copiedTexts.push(text);
      return Promise.resolve();
    },
  };
  if (typeof g.navigator === "object" && g.navigator) {
    try {
      Object.defineProperty(g.navigator, "clipboard", {
        value: clipboardImpl,
        configurable: true,
      });
    } catch {
      g.navigator.clipboard = clipboardImpl;
    }
  } else {
    g.navigator = { clipboard: clipboardImpl };
  }

  g.FileReader = class MockFileReader {
    result: string | ArrayBuffer | null = null;
    error: any = null;
    onload: ((ev: any) => void) | null = null;
    onerror: ((ev: any) => void) | null = null;

    readAsDataURL(file: any) {
      Promise.resolve().then(async () => {
        try {
          if (typeof file?._dataUrl === "string") {
            this.result = file._dataUrl;
          } else if (typeof file?.arrayBuffer === "function") {
            const buf = Buffer.from(await file.arrayBuffer());
            this.result = `data:${file.type || "application/octet-stream"};base64,${buf.toString("base64")}`;
          } else {
            const raw = typeof file?._content === "string" ? file._content : "mock-binary";
            this.result = `data:${file?.type || "image/png"};base64,${Buffer.from(raw).toString("base64")}`;
          }
          this.onload?.({ target: this });
        } catch (err) {
          this.error = err;
          this.onerror?.({ target: this });
        }
      });
    }

    readAsText(file: any) {
      Promise.resolve().then(async () => {
        try {
          if (typeof file?._content === "string") {
            this.result = file._content;
          } else if (typeof file?.text === "function") {
            this.result = await file.text();
          } else {
            this.result = "";
          }
          this.onload?.({ target: this });
        } catch (err) {
          this.error = err;
          this.onerror?.({ target: this });
        }
      });
    }
  };

  if (typeof g.btoa !== "function") {
    g.btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
  }
  if (typeof g.atob !== "function") {
    g.atob = (s: string) => Buffer.from(s, "base64").toString("binary");
  }

  return sharedEnvironment;
}

function depsChanged(prev: any[] | undefined, next: any[] | undefined): boolean {
  if (!prev || !next) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

function makeMockElement(nodeRef: { vnode?: VNode }): any {
  const elListeners = new Map<string, Set<Function>>();
  const el: any = {
    value: "",
    checked: false,
    files: [],
    scrollHeight: 120,
    scrollTop: 0,
    clientHeight: 100,
    focused: false,
    selected: false,
    scrolledIntoView: false,
    style: {},
    addEventListener(type: string, fn: Function) {
      let set = elListeners.get(type);
      if (!set) {
        set = new Set();
        elListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: Function) {
      elListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev: any) {
      const event = { target: el, currentTarget: el, ...ev };
      for (const fn of elListeners.get(event.type) ?? []) fn(event);
      return true;
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, bottom: 100, right: 300, width: 300, height: 100 };
    },
    scrollTo(_x?: any, y?: number) {
      if (typeof y === "number") el.scrollTop = y;
    },
    focus() {
      el.focused = true;
    },
    blur() {
      el.focused = false;
      const vnode = nodeRef.vnode;
      if (vnode?.props?.onBlur) {
        vnode.props.onBlur({
          target: el,
          currentTarget: el,
          preventDefault() {},
          stopPropagation() {},
        });
      }
    },
    select() {
      el.selected = true;
    },
    scrollIntoView() {
      el.scrolledIntoView = true;
    },
    click() {
      const vnode = nodeRef.vnode;
      if (vnode?.props?.onClick) {
        vnode.props.onClick({
          target: el,
          currentTarget: el,
          preventDefault() {},
          stopPropagation() {},
        });
      }
    },
    contains(other: any): boolean {
      const root = nodeRef.vnode;
      if (!root || !other) return false;
      if (root.mockElement === other) return true;
      const walk = (n: VNode): boolean => {
        if (n.mockElement === other) return true;
        for (const c of n.children) {
          if (typeof c !== "string" && walk(c)) return true;
        }
        return false;
      };
      return walk(root);
    },
  };
  return el;
}

export function getText(node: VNodeChild | null | undefined): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return node.children.map((c) => getText(c)).join("");
}

export class MountedTree {
  private instances = new Map<string, ComponentInstance>();
  private elementCache = new Map<string, { mockElement: any; refBox: { vnode?: VNode } }>();
  private root: VNodeChild[] = [];
  private renderPending = false;
  private contextValues = new Map<any, any[]>();
  private pendingEffects: { path: string; cell: HookCell }[] = [];
  private idCounter = 0;

  constructor(private renderElement: () => React.ReactNode) {
    setupBrowserGlobals();
    this.rerender();
  }

  updateRenderFn(renderElement: () => React.ReactNode): void {
    this.renderElement = renderElement;
    this.rerender();
  }

  rerender(): void {
    const prevDispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
      .ReactCurrentDispatcher.current;

    const visitedPaths = new Set<string>();
    let pass = 0;

    try {
      do {
        this.renderPending = false;
        this.pendingEffects = [];
        visitedPaths.clear();
        this.idCounter = 0;

        const out = this.renderNode(this.renderElement(), "root", visitedPaths);
        this.root = Array.isArray(out) ? out : out ? [out] : [];

        // Run queued effects after commit
        const effectsToRun = [...this.pendingEffects];
        this.pendingEffects = [];
        for (const { cell } of effectsToRun) {
          if (cell.effect?.cleanup) {
            try {
              cell.effect.cleanup();
            } catch {
              // ignore cleanup errors in tests
            }
          }
          const cleanup = cell.effect?.fn();
          if (cell.effect) {
            cell.effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
            cell.effect.hasRun = true;
          }
        }

        // Cleanup unmounted component instances
        for (const [path, inst] of [...this.instances.entries()]) {
          if (!visitedPaths.has(path)) {
            for (const cell of inst.hooks) {
              if (cell.effect?.cleanup) {
                try {
                  cell.effect.cleanup();
                } catch {
                  // ignore
                }
              }
            }
            this.instances.delete(path);
          }
        }
        pass++;
      } while (this.renderPending && pass < 20);
    } finally {
      (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
        .ReactCurrentDispatcher.current = prevDispatcher;
    }
  }

  unmount(): void {
    for (const inst of this.instances.values()) {
      for (const cell of inst.hooks) {
        if (cell.effect?.cleanup) {
          try {
            cell.effect.cleanup();
          } catch {
            // ignore
          }
        }
      }
    }
    this.instances.clear();
    this.elementCache.clear();
    this.root = [];
  }

  private scheduleUpdate(): void {
    this.renderPending = true;
  }

  private getOrCreateMockElement(path: string, props: Record<string, any>) {
    let entry = this.elementCache.get(path);
    if (!entry) {
      const refBox: { vnode?: VNode } = {};
      entry = { mockElement: makeMockElement(refBox), refBox };
      this.elementCache.set(path, entry);
    }
    if (props.value !== undefined) entry.mockElement.value = String(props.value);
    if (props.checked !== undefined) entry.mockElement.checked = Boolean(props.checked);
    return entry;
  }

  private renderNode(node: any, path: string, visitedPaths: Set<string>): VNodeChild | VNodeChild[] | null {
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) {
      const res: VNodeChild[] = [];
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        const keyPart = item && typeof item === "object" && item.key != null ? `k_${item.key}` : `i_${i}`;
        const child = this.renderNode(item, `${path}.${keyPart}`, visitedPaths);
        if (Array.isArray(child)) res.push(...child);
        else if (child !== null) res.push(child);
      }
      return res;
    }

    if (typeof node !== "object") return String(node);

    const { type, props = {} } = node;

    if (type === SYMBOL_FRAGMENT || type === React.Fragment) {
      return this.renderNode(props.children, `${path}.frag`, visitedPaths);
    }

    if (type && typeof type === "object" && type.$$typeof === SYMBOL_PROVIDER) {
      const ctx = type._context ?? type;
      let stack = this.contextValues.get(ctx);
      if (!stack) {
        stack = [];
        this.contextValues.set(ctx, stack);
      }
      stack.push(props.value);
      try {
        return this.renderNode(props.children, `${path}.prov`, visitedPaths);
      } finally {
        stack.pop();
      }
    }

    if (typeof type === "string") {
      const elKey = `${path}:${type}`;
      const elEntry = this.getOrCreateMockElement(elKey, props);
      const elementRef = node.ref;
      if (elementRef) {
        if (typeof elementRef === "function") elementRef(elEntry.mockElement);
        else if (typeof elementRef === "object") elementRef.current = elEntry.mockElement;
      }

      const renderedChildren = this.renderNode(props.children, `${path}.>${type}`, visitedPaths);
      const childrenArr: VNodeChild[] = renderedChildren === null
        ? []
        : Array.isArray(renderedChildren)
          ? renderedChildren
          : [renderedChildren];

      const vnode: VNode = {
        tag: type,
        props,
        children: childrenArr,
        path: elKey,
        mockElement: elEntry.mockElement,
      };
      elEntry.refBox.vnode = vnode;
      return vnode;
    }

    if (type && typeof type === "object" && type.$$typeof === SYMBOL_MEMO) {
      const innerType = type.type;
      return this.renderComponent(innerType, props, node.ref, `${path}.memo(${innerType.name || "anon"})`, visitedPaths);
    }

    if (type && typeof type === "object" && type.$$typeof === SYMBOL_FORWARD_REF) {
      return this.renderComponent(
        (p: any) => type.render(p, node.ref),
        props,
        null,
        `${path}.fwd(${type.render?.name || "anon"})`,
        visitedPaths
      );
    }

    if (typeof type === "function") {
      return this.renderComponent(type, props, node.ref, `${path}.${type.name || "comp"}`, visitedPaths);
    }

    return null;
  }

  private renderComponent(
    Comp: any,
    props: Record<string, any>,
    ref: any,
    compPath: string,
    visitedPaths: Set<string>
  ): VNodeChild | VNodeChild[] | null {
    visitedPaths.add(compPath);
    let inst = this.instances.get(compPath);
    if (!inst) {
      inst = { hooks: [], mounted: false };
      this.instances.set(compPath, inst);
    }

    // Class component (e.g. ErrorBoundary)
    if (Comp.prototype && Comp.prototype.isReactComponent) {
      if (!inst.classInstance) {
        const instance = new Comp(props);
        instance.props = props;
        instance.setState = (partial: any) => {
          const next = typeof partial === "function" ? partial(instance.state, instance.props) : partial;
          instance.state = { ...instance.state, ...next };
          this.scheduleUpdate();
        };
        inst.classInstance = instance;
      } else {
        inst.classInstance.props = props;
      }

      if (ref) {
        if (typeof ref === "function") ref(inst.classInstance);
        else ref.current = inst.classInstance;
      }

      try {
        const rendered = inst.classInstance.render();
        return this.renderNode(rendered, compPath, visitedPaths);
      } catch (err: any) {
        if (typeof Comp.getDerivedStateFromError === "function") {
          const derived = Comp.getDerivedStateFromError(err);
          inst.classInstance.state = { ...inst.classInstance.state, ...derived };
          inst.classInstance.componentDidCatch?.(err, { componentStack: compPath });
          const fallbackRendered = inst.classInstance.render();
          return this.renderNode(fallbackRendered, compPath, visitedPaths);
        }
        throw err;
      }
    }

    // Functional component with hooks
    let hookIndex = 0;
    const hooks = inst.hooks;
    const self = this;

    const getCell = (): HookCell => {
      const idx = hookIndex++;
      if (!hooks[idx]) hooks[idx] = {};
      return hooks[idx];
    };

    const dispatcher: any = {
      useState(initial: any) {
        const cell = getCell();
        if (!("state" in cell)) {
          cell.state = typeof initial === "function" ? initial() : initial;
        }
        const setState = (val: any) => {
          const next = typeof val === "function" ? val(cell.state) : val;
          if (!Object.is(cell.state, next)) {
            cell.state = next;
            self.scheduleUpdate();
          }
        };
        return [cell.state, setState];
      },
      useReducer(reducer: (s: any, a: any) => any, initialArg: any, init?: (a: any) => any) {
        const cell = getCell();
        if (!("state" in cell)) {
          cell.state = init ? init(initialArg) : initialArg;
        }
        const dispatch = (action: any) => {
          const next = reducer(cell.state, action);
          if (!Object.is(cell.state, next)) {
            cell.state = next;
            self.scheduleUpdate();
          }
        };
        return [cell.state, dispatch];
      },
      useMemo(factory: () => any, deps: any[] | undefined) {
        const cell = getCell();
        if (!cell.memo || depsChanged(cell.memo.deps, deps)) {
          cell.memo = { deps, value: factory() };
        }
        return cell.memo.value;
      },
      useCallback(fn: Function, deps: any[] | undefined) {
        const cell = getCell();
        if (!cell.memo || depsChanged(cell.memo.deps, deps)) {
          cell.memo = { deps, value: fn };
        }
        return cell.memo.value;
      },
      useRef(initialValue: any) {
        const cell = getCell();
        if (!cell.ref) {
          cell.ref = { current: initialValue };
        }
        return cell.ref;
      },
      useEffect(create: () => void | (() => void), deps: any[] | undefined) {
        const cell = getCell();
        const shouldRun = !cell.effect || !cell.effect.hasRun || depsChanged(cell.effect.deps, deps);
        const prevCleanup = cell.effect?.cleanup;
        cell.effect = {
          fn: create,
          deps,
          cleanup: prevCleanup,
          hasRun: !shouldRun && Boolean(cell.effect?.hasRun),
        };
        if (shouldRun) {
          self.pendingEffects.push({ path: compPath, cell });
        }
      },
      useLayoutEffect(create: () => void | (() => void), deps: any[] | undefined) {
        return dispatcher.useEffect(create, deps);
      },
      useContext(ctx: any) {
        getCell();
        const stack = self.contextValues.get(ctx);
        return stack && stack.length > 0 ? stack[stack.length - 1] : ctx?._currentValue;
      },
      useId() {
        const cell = getCell();
        if (!("state" in cell)) {
          cell.state = `:r${self.idCounter++}:`;
        }
        return cell.state;
      },
      useImperativeHandle() {
        getCell();
      },
      useDebugValue() {},
      useDeferredValue(v: any) {
        return v;
      },
      useTransition() {
        return [false, (cb: () => void) => cb()];
      },
      useSyncExternalStore(_sub: any, getSnap: () => any) {
        return getSnap();
      },
    };

    (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
      .ReactCurrentDispatcher.current = dispatcher;

    const rendered = Comp(props, ref);
    inst.mounted = true;
    return this.renderNode(rendered, compPath, visitedPaths);
  }

  text(): string {
    return this.root.map((c) => getText(c)).join(" ");
  }

  findAll(predicate: (n: VNode) => boolean): VNode[] {
    const out: VNode[] = [];
    const walk = (n: VNodeChild) => {
      if (typeof n === "string") return;
      if (predicate(n)) out.push(n);
      for (const c of n.children) walk(c);
    };
    for (const c of this.root) walk(c);
    return out;
  }

  findOne(predicate: (n: VNode) => boolean, description = "matching element"): VNode {
    const all = this.findAll(predicate);
    if (all.length === 0) {
      throw new Error(`Could not find ${description}. Rendered text preview:\n${this.text().slice(0, 600)}`);
    }
    return all[0];
  }

  findAllByText(text: string | RegExp, tag?: string): VNode[] {
    const exact = this.findAll((n) => {
      if (tag && n.tag !== tag) return false;
      const t = getText(n).trim();
      return typeof text === "string" ? t === text : text.test(t);
    });
    if (exact.length > 0) return exact;
    return this.findAll((n) => {
      if (tag && n.tag !== tag) return false;
      const t = getText(n);
      return typeof text === "string" ? t.includes(text) : text.test(t);
    });
  }

  findByText(text: string | RegExp, tag?: string): VNode {
    const candidates = this.findAll((n) => {
      if (tag && n.tag !== tag) return false;
      const t = getText(n).trim();
      return typeof text === "string" ? t === text : text.test(t);
    });
    if (candidates.length > 0) return candidates[candidates.length - 1];
    const loose = this.findAll((n) => {
      if (tag && n.tag !== tag) return false;
      const t = getText(n);
      return typeof text === "string" ? t.includes(text) : text.test(t);
    });
    if (loose.length > 0) return loose[loose.length - 1];
    throw new Error(`Could not find ${tag ?? "element"} with text "${text}". Available text:\n${this.text().slice(0, 600)}`);
  }

  findButton(text: string | RegExp): VNode {
    return this.findByText(text, "button");
  }

  findByClass(className: string, tag?: string): VNode {
    return this.findOne(
      (n) =>
        (!tag || n.tag === tag) &&
        typeof n.props.className === "string" &&
        n.props.className.split(/\s+/).includes(className),
      `${tag ?? "element"}.${className}`
    );
  }

  findAllByClass(className: string, tag?: string): VNode[] {
    return this.findAll(
      (n) =>
        (!tag || n.tag === tag) &&
        typeof n.props.className === "string" &&
        n.props.className.split(/\s+/).includes(className)
    );
  }

  findByTitle(title: string | RegExp, tag?: string): VNode {
    return this.findOne((n) => {
      if (tag && n.tag !== tag) return false;
      const t = n.props.title;
      if (typeof t !== "string") return false;
      return typeof title === "string" ? t.includes(title) : title.test(t);
    }, `${tag ?? "element"}[title=${title}]`);
  }

  findByAriaLabel(label: string | RegExp, tag?: string): VNode {
    return this.findOne((n) => {
      if (tag && n.tag !== tag) return false;
      const a = n.props["aria-label"];
      if (typeof a !== "string") return false;
      return typeof label === "string" ? a.includes(label) : label.test(a);
    }, `${tag ?? "element"}[aria-label=${label}]`);
  }

  findByPlaceholder(placeholder: string | RegExp): VNode {
    return this.findOne((n) => {
      const p = n.props.placeholder;
      if (typeof p !== "string") return false;
      return typeof placeholder === "string" ? p.includes(placeholder) : placeholder.test(p);
    }, `[placeholder=${placeholder}]`);
  }

  private flush(fn: () => void): void {
    fn();
    this.rerender();
  }

  private findAncestor(target: VNode, tag: string): VNode | null {
    let found: VNode | null = null;
    const walk = (n: VNodeChild, parents: VNode[]): boolean => {
      if (typeof n === "string") return false;
      if (n === target) {
        for (let i = parents.length - 1; i >= 0; i--) {
          if (parents[i].tag === tag) {
            found = parents[i];
            return true;
          }
        }
        return true;
      }
      parents.push(n);
      for (const c of n.children) {
        if (walk(c, parents)) return true;
      }
      parents.pop();
      return false;
    };
    for (const c of this.root) {
      if (walk(c, [])) break;
    }
    return found;
  }

  private resolveLive(node: VNode): VNode {
    const exact = this.findAll((n) => n.path === node.path && n.tag === node.tag);
    if (exact.length > 0) return exact[0];
    const byMock = this.findAll((n) => n.mockElement === node.mockElement && n.tag === node.tag);
    if (byMock.length > 0) return byMock[0];
    return node;
  }

  click(inputNode: VNode, extra?: Record<string, any>): void {
    const node = this.resolveLive(inputNode);
    if (node.props.disabled) {
      throw new Error(`Attempted to click disabled <${node.tag}> (${getText(node) || node.props.title || node.props.className})`);
    }
    this.flush(() => {
      let stopped = false;
      const ev = {
        target: node.mockElement,
        currentTarget: node.mockElement,
        preventDefault() {},
        stopPropagation() {
          stopped = true;
        },
        ...extra,
      };
      node.props.onMouseDown?.(ev);
      node.props.onClick?.(ev);
      if (node.tag === "button" && node.props.type === "submit") {
        const form = this.findAncestor(node, "form");
        form?.props?.onSubmit?.({
          target: form.mockElement,
          currentTarget: form.mockElement,
          preventDefault() {},
          stopPropagation() {},
        });
      }
    });
  }

  doubleClick(inputNode: VNode): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      node.props.onDoubleClick?.({
        target: node.mockElement,
        currentTarget: node.mockElement,
        preventDefault() {},
        stopPropagation() {},
      });
    });
  }

  mouseDown(inputNode: VNode): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      node.props.onMouseDown?.({
        target: node.mockElement,
        currentTarget: node.mockElement,
        preventDefault() {},
        stopPropagation() {},
      });
    });
  }

  change(inputNode: VNode, value: string | boolean, extraTargetProps?: Record<string, any>): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      const target = {
        ...node.mockElement,
        value: typeof value === "boolean" ? node.mockElement.value : value,
        checked: typeof value === "boolean" ? value : node.mockElement.checked,
        ...extraTargetProps,
      };
      node.mockElement.value = target.value;
      node.mockElement.checked = target.checked;
      node.props.onChange?.({
        target,
        currentTarget: target,
        preventDefault() {},
        stopPropagation() {},
      });
    });
  }

  blur(inputNode: VNode): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      node.props.onBlur?.({
        target: node.mockElement,
        currentTarget: node.mockElement,
        preventDefault() {},
        stopPropagation() {},
      });
    });
  }

  keyDown(inputNode: VNode, init: Record<string, any>): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      node.props.onKeyDown?.({
        preventDefault() {},
        stopPropagation() {},
        target: node.mockElement,
        currentTarget: node.mockElement,
        ...init,
      });
    });
  }

  paste(inputNode: VNode, clipboardData: any): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      node.props.onPaste?.({
        preventDefault() {},
        stopPropagation() {},
        clipboardData,
        target: node.mockElement,
        currentTarget: node.mockElement,
      });
    });
  }

  dragEnter(inputNode: VNode, dataTransfer: any): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      node.props.onDragEnter?.({
        preventDefault() {},
        stopPropagation() {},
        dataTransfer,
      });
    });
  }

  dragOver(inputNode: VNode, dataTransfer: any): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      node.props.onDragOver?.({
        preventDefault() {},
        stopPropagation() {},
        dataTransfer,
      });
    });
  }

  dragLeave(inputNode: VNode): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      node.props.onDragLeave?.({
        preventDefault() {},
        stopPropagation() {},
      });
    });
  }

  drop(inputNode: VNode, dataTransfer: any): void {
    const node = this.resolveLive(inputNode);
    this.flush(() => {
      node.props.onDrop?.({
        preventDefault() {},
        stopPropagation() {},
        dataTransfer,
      });
    });
  }

  dispatchDocumentEvent(type: string, eventInit: Record<string, any>): void {
    this.flush(() => {
      const listeners = sharedEnvironment.docListeners.get(type);
      if (listeners) {
        for (const fn of [...listeners]) fn(eventInit);
      }
    });
  }

  async tick(ms = 10): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    this.rerender();
  }
}

export function createHostDispatcher() {
  const env = setupBrowserGlobals();
  env.storage.clear();
  env.copiedTexts.length = 0;
  env.externalOpened.length = 0;
  env.reloadCount = 0;
  for (const k of Object.keys(env.bodyDataset)) delete env.bodyDataset[k];
  for (const k of Object.keys(env.htmlDataset)) delete env.htmlDataset[k];
  const posted: ViewMessage[] = [];
  env.postSink = (msg) => {
    posted.push(msg);
  };

  const sendHost = (msg: HostMessage, tree?: MountedTree) => {
    (globalThis as any).dispatchEvent({ type: "message", data: msg });
    tree?.rerender();
  };

  return { env, posted, sendHost };
}

// Install browser shims eagerly at import time so static imports of UI modules work seamlessly.
setupBrowserGlobals();
