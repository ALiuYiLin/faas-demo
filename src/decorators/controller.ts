import type { DecoratorLike } from "./types";

/**
 * 标记一个类为控制器（Spring 风格 `@Controller`）。
 *
 * ⚠️ 当前仅声明签名，不做任何注册：装饰器执行时什么也不做，后续再接入元数据注册表。
 *
 * @param path 控制器挂载的路径前缀，如 `"/users"`，默认 `"/"`
 */
export function Controller(path = "/"): DecoratorLike {
  return () => {
    // TODO: 把 path 收进元数据，供启动时注册路由
    void path;
  };
}
