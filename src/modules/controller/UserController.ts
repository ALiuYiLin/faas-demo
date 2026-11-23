import { Body, Controller, Get, Param, Post, Resource } from "@/decorators";
import type { CreateUserInput, User } from "@/modules/entity/User";
import type { UserService } from "@/modules/service/UserService";

@Controller("/users")
export class UserController {
  @Resource
  private userService!: UserService;

  @Get("/list")
  list(): User[] {
    return this.userService.list();
  }

  @Get("/detail/:id")
  detail(@Param("id") id: string): User | null {
    return this.userService.find(id) ?? null;
  }

  @Post("/create")
  create(@Body() input: CreateUserInput): User {
    return this.userService.create(input);
  }
}
