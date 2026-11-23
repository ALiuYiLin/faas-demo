import { beanNames, classMeta, getBean } from "./metadata";

/** 极简 IOC 容器：单例 + 按 bean 名做属性注入（@Resource）。 */
export class Container {
  private readonly singletons = new Map<Function, unknown>();

  /** 按类取实例；同一个类只会 new 一次。 */
  resolve<T>(type: new (...args: any[]) => T): T {
    const cached = this.singletons.get(type);
    if (cached !== undefined) return cached as T;

    const instance = new type();
    // 先占位再注入，注入链里出现循环依赖时不会无限递归
    this.singletons.set(type, instance);

    for (const inject of classMeta(type).injects) {
      const ref = inject.ref ?? String(inject.property);
      // 用 getter 而不是立即赋值：真正的解析推迟到第一次访问，天然支持循环依赖
      Object.defineProperty(instance as object, inject.property, {
        configurable: true,
        enumerable: true,
        get: () => this.resolveByName(ref),
      });
    }

    return instance;
  }

  /** 按 bean 名取实例。 */
  resolveByName<T = unknown>(name: string): T {
    const type = getBean(name);
    if (!type) {
      const known = beanNames();
      throw new Error(
        `[container] 找不到名为 "${name}" 的 bean。` +
          (known.length
            ? `已注册：${known.join(", ")}`
            : "当前没有任何 bean，确认 @Service 所在的模块被 import 过"),
      );
    }
    return this.resolve(type as new (...args: any[]) => T);
  }
}
