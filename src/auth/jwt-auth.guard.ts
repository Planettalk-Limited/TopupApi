import { Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

/** Guards admin routes: requires a valid Bearer JWT issued by AuthService. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
