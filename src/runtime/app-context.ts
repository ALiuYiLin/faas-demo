import { beanName, classMeta, dropClassMeta, noteBean } from "./context";

/**
 * 进程级应用上下文（IOC 容器）。
 *
 * - `beans`：bean 名 -> 类，全局一份；`@Service` 在 bundle 求值时注册。
 * - `singletons`：类 -> 实例，全局一份；service 就是进程内单例。
 * - 重载 service 时覆盖 bean 定义并驱逐旧实例，注入方的 getter 下次访问自然拿到新实例。
 */
export class AppContext {
  private readonly beans = new Map<string, Function>();
  private readonly singletons = new Map<Function, unknown>();
  /** 重载期间允许同名 bean 覆盖 */
  private allowReplace = false;

  registerBean(name: string, type: Function): void {
    const existing = this.beans.get(name);
    if (existing && existing !== type && !this.allowReplace) {
      throw new Error(
        `[runtime] bean 名冲突："${name}" 已被 ${existing.name || "匿名类"} 占用，` +
          `${type.name || "匿名类"} 无法注册`,
      );
    }
    this.beans.set(name, type);
    noteBean(name, type);
  }

  /** 执行 reload 时打开：允许同名 bean 覆盖旧定义 */
  withReplace<T>(fn: () => T): T {
    const prev = this.allowReplace;
    this.allowReplace = true;
    try {
      return fn();
    } finally {
      this.allowReplace = prev;
    }
  }

  has(name: string): boolean {
    return this.beans.has(name);
  }

  getBean(name: string): Function | undefined {
    return this.beans.get(name);
  }

  beanNames(): string[] {
    return [...this.beans.keys()];
  }

  /** 按类取实例；同一个类只会 new 一次 */
  resolve<T>(type: new (...args: any[]) => T): T {
    const cached = this.singletons.get(type);
    if (cached !== undefined) return cached as T;

    const instance = new type();
    // 先占位再注入：循环依赖不会无限递归
    this.singletons.set(type, instance);

    for (const inject of classMeta(type).injects) {
      const ref = inject.ref ?? String(inject.property);
      // getter 延迟解析：重载 service 之后，已有实例下次访问自动拿到新单例
      Object.defineProperty(instance as object, inject.property, {
        configurable: true,
        enumerable: true,
        get: () => this.resolveByName(ref),
      });
    }

    return instance;
  }

  /** 按 bean 名取实例 */
  resolveByName<T = unknown>(name: string): T {
    const type = this.getBean(name);
    if (!type) {
      const known = this.beanNames();
      throw new Error(
        `[runtime] 找不到名为 "${name}" 的 bean。` +
          (known.length ? `已注册：${known.join(", ")}` : "当前没有任何 bean"),
      );
    }
    return this.resolve(type as new (...args: any[]) => T);
  }

  /** 丢弃某个类的实例 + 元数据（重载后清理旧代） */
  forget(type: Function): void {
    this.singletons.delete(type);
    dropClassMeta(type);
  }

  /** 删除 bean 定义（service 被移除 / 改名时） */
  removeBean(name: string): void {
    const type = this.beans.get(name);
    this.beans.delete(name);
    if (type) this.forget(type);
  }

  /** 按约定命名解析 bean（兜底注册用） */
  registerByConvention(type: Function): string {
    const name = beanName(type);
    this.registerBean(name, type);
    return name;
  }
}

export const appContext = new AppContext();
