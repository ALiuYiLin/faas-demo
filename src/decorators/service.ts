import { registerBean } from "@/container/metadata";
import type { ClassDecoratorLike } from "./types";

/**
 * 标记一个类为 bean（Spring 风格 `@Service`）。
 *
 * bean 名约定：去掉 `Impl` 后缀后首字母小写，
 * 所以 `UserServiceImpl` 注册为 `userService`，正好能被 `@Resource userService` 注入。
 *
 * @param name 显式指定 bean 名，缺省走上面的约定
 */
export function Service(name?: string): ClassDecoratorLike {
  return (target) => {
    registerBean(target, name);
  };
}
