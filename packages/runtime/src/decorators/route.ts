import { registerRoute } from "../context";
import type { MethodDecoratorLike } from "./types";

/**
 * 声明一个 GET 路由（Spring 风格 `@GetMapping`）。
 *
 * 只记录元数据，实际注册由 `controllerRouter()` 完成。
 *
 * @param path 路由路径，如 `"/list"`；留空表示控制器根路径
 */
export function Get(path = "/"): MethodDecoratorLike {
  return (target, key) => {
    registerRoute(target.constructor, "get", path, key);
  };
}

/**
 * 声明一个 POST 路由（Spring 风格 `@PostMapping`）。
 *
 * @param path 路由路径，如 `"/create"`；留空表示控制器根路径
 */
export function Post(path = "/"): MethodDecoratorLike {
  return (target, key) => {
    registerRoute(target.constructor, "post", path, key);
  };
}