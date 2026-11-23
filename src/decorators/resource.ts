import { registerInject } from "../container/metadata";
import type { PropertyDecoratorLike } from "./types";

/**
 * `@Resource` 的签名：既支持裸写法 `@Resource`，也支持带名字的 `@Resource("userService")`。
 */
export type ResourceDecorator = {
  /** 直接当装饰器用：`@Resource` */
  (target: object, propertyKey: string | symbol): void;
  /** 工厂用法：`@Resource("beanName")` 或 `@Resource()` */
  (name?: string): PropertyDecoratorLike;
};

/**
 * 按名称注入依赖（Spring 风格 `@Resource`），用在属性上：
 *
 * ```ts
 * @Controller("/users")
 * class UserController {
 *   @Resource private userService!: UserService;          // 按属性名找 bean
 *   @Resource("cacheService") private cache!: Cache;      // 显式指定 bean 名
 * }
 * ```
 *
 * 只记录元数据；真正的注入发生在容器 `resolve()` 时（用 getter 延迟解析）。
 *
 * @param name 要注入的 bean 名，缺省用属性名
 */
export const Resource = function (
  nameOrTarget?: string | object,
  propertyKey?: string | symbol,
): PropertyDecoratorLike | void {
  // 被当作裸装饰器调用：@Resource -> (target, propertyKey)
  if (typeof propertyKey === "string" || typeof propertyKey === "symbol") {
    registerInject((nameOrTarget as object).constructor, propertyKey);
    return;
  }

  // 工厂调用：@Resource("name") / @Resource()
  const name = nameOrTarget as string | undefined;
  return (target, key) => {
    registerInject(target.constructor, key, name);
  };
} as ResourceDecorator;
