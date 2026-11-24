
import { Body, Controller, Get, Param, Post, Resource, controllerRouter } from "@faas/runtime";
import { ns } from "../utils";

@Controller('/role')
export class RoleController {
  @Get('list')
  get(){
    return ns()
  }
}
export default controllerRouter(RoleController);