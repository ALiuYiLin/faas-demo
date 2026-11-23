/**
 * `@faas/runtime/internal` —— 只给平台层（registry / dev / 测试）用的内部入口。
 *
 * 热区模块不应该 import 这个子路径：它暴露的是容器与元数据的实现细节。
 */
export { appContext, AppContext } from "./app-context";
export {
  beanName,
  beginCapture,
  classMeta,
  dropClassMeta,
  endCapture,
} from "./context";
export type {
  ClassMeta,
  HttpMethod,
  InjectMeta,
  ParamMeta,
  Registrations,
  RouteMeta,
} from "./context";
