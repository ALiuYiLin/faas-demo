
import { Body, Controller, Get, Param, Post, Resource, controllerRouter } from "@faas/runtime";

@Controller('/role')
export class RoleController {
  @Get('list')
  get(){
    return 'nihao role'
  }
}
export default controllerRouter(RoleController);