import { Controller, Get, Resource } from "@/decorators";
import type { UserService } from "@/modules/service/UserService";



@Controller("/users")
export class UserController {
  @Resource
  private userService!: UserService;

  @Get('/list')
  list(){
    return this.userService.list()
  }
}