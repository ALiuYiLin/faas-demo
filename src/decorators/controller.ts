import { registerController } from "@/runtime/context";
import type { ClassDecoratorLike } from "./types";

/**
 * 标记一个类为控制器，并指定挂载路径前缀（Spring 风格 `@Controller`）。
 *
 * 只写元数据；实例化与挂载由运行时的 `controllerRouter()` / registry 完成。
 *
 * @param path 控制器挂载的路径前缀，如 `"/users"`，默认 `"/"`
 */
export function Controller(path = "/"): ClassDecoratorLike {
  return (target) => {
    registerController(target, path);
  };
}