import express, { type RequestHandler, type Router } from "express";

export interface RouterEntry {
  prefix: string;
  router: Router;
}

/**
 * 组合路由表：所有 controller 的 router 在这里拼成一张表，换版时整表重建。
 * `handle` 每次请求抓一次快照，所以替换 `composed` 不影响进行中的请求。
 */
export class RouterTable {
  private composed: Router = express.Router();

  rebuild(entries: Iterable<RouterEntry>): void {
    const next = express.Router();
    for (const entry of entries) {
      next.use(entry.prefix, entry.router);
    }
    this.composed = next;
  }

  readonly handle: RequestHandler = (req, res, next) => {
    const router = this.composed;
    router(req, res, next);
  };
}
