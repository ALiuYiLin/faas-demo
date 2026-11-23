import type { DecoratorLike } from "./types";

/**
 * 标记一个类为服务（Spring 风格 `@Service`）。
 *
 * ⚠️ 当前仅声明签名，不做任何注册（之后可接入 IOC 容器）。
 *
 * @param name 服务名，缺省用类名
 */
export function Service(name?: string): DecoratorLike {
  return () => {
    // TODO: 把 name 收进元数据，供 IOC 容器注册
    void name;
  };
}
