import type { DecoratorLike } from "./types";

/**
 * `@Resource` 的签名：既支持裸写法 `@Resource`，也支持带名字的 `@Resource("userService")`。
 */
export type ResourceDecorator = {
  /** 直接当装饰器用：`@Resource` */
  (target: unknown, propertyKey: string | symbol): void;
  /** 工厂用法：`@Resource("beanName")` 或 `@Resource()` */
  (name?: string): DecoratorLike;
};

/**
 * 按名称注入依赖（Spring 风格 `@Resource`），用在属性上：
 *
 * ```ts
 * @Controller("/users")
 * class UserController {
 *   @Resource private userService!: UserService;
 *   @Resource("cacheService") private cache!: Cache;
 * }
 * ```
 *
 * ⚠️ 当前仅声明签名，不做任何注入：装饰器执行时什么也不做，后续接 IOC 容器时
 * 在这里按 name / 属性名解析并写入实例。
 *
 * @param name 要注入的 bean 名，缺省用属性名
 */
export const Resource = function (
  nameOrTarget?: string | object,
  propertyKey?: string | symbol,
): DecoratorLike | void {
  // 被当作裸装饰器调用：@Resource → (target, propertyKey)
  if (typeof propertyKey === "string" || typeof propertyKey === "symbol") {
    return;
  }
  // 工厂调用：@Resource("name") / @Resource()
  return () => {
    // TODO: 把 { propertyKey, name } 收进元数据，供 IOC 容器注入
    void nameOrTarget;
  };
} as ResourceDecorator;
