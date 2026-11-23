import type { DecoratorLike } from "./types";

/**
 * 声明一个 GET 路由（Spring 风格 `@GetMapping`）。
 *
 * ⚠️ 当前仅声明签名，不做任何注册。
 *
 * @param path 路由路径，如 `"/list"`，默认 `"/"`
 */
export function Get(path = "/"): DecoratorLike {
  return () => {
    // TODO: 把 { method: "GET", path } 收进方法元数据
    void path;
  };
}

/**
 * 声明一个 POST 路由（Spring 风格 `@PostMapping`）。
 *
 * ⚠️ 当前仅声明签名，不做任何注册。
 *
 * @param path 路由路径，如 `"/create"`，默认 `"/"`
 */
export function Post(path = "/"): DecoratorLike {
  return () => {
    // TODO: 把 { method: "POST", path } 收进方法元数据
    void path;
  };
}
