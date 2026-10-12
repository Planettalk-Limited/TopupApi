// Customer and admin JWTs must never be interchangeable, even in the worst-case config
// where both are signed with the same secret (CUSTOMER_JWT_SECRET unset). Exercised
// through the real guards over HTTP, with Prisma mocked to "find" any id it is asked for
// — so the rejection below comes from the audience checks, not from a missing row.
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'
import { AuthModule } from '../auth/auth.module'
import { CommonModule } from '../common/common.module'
import { PrismaService } from '../common/prisma.service'
import { RedisService } from '../common/redis.service'
import { CUSTOMER_AUDIENCE } from './customer-jwt'
import { CustomersModule } from './customers.module'

const SHARED_SECRET = 'same-secret-for-both'

describe('admin vs customer token isolation', () => {
  let app: INestApplication
  const signer = new JwtService({ secret: SHARED_SECRET })

  const adminToken = () => signer.sign({ sub: 'admin-1', email: 'ops@planettalk.com', role: 'ADMIN' })
  const customerToken = () =>
    signer.sign({ sub: 'cust-1', email: 'ada@example.com' }, { audience: CUSTOMER_AUDIENCE })

  beforeAll(async () => {
    process.env.JWT_SECRET = SHARED_SECRET
    delete process.env.CUSTOMER_JWT_SECRET

    const prisma = {
      adminUser: {
        findUnique: jest.fn(async ({ where }: any) => ({
          id: where.id,
          email: 'ops@planettalk.com',
          name: 'Ops',
          role: 'ADMIN',
          active: true,
        })),
      },
      customer: {
        findUnique: jest.fn(async ({ where }: any) => ({
          id: where.id,
          email: 'ada@example.com',
          firstName: 'Ada',
          lastName: 'Obi',
          phone: '+447860980321',
          emailVerifiedAt: new Date(),
        })),
      },
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), CommonModule, AuthModule, CustomersModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue({})
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('admin token works on the admin route', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${adminToken()}`)
      .expect(200)
  })

  it('customer token works on the customer route', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/customer/me')
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(200)
    expect(res.body).toEqual({
      id: 'cust-1',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Obi',
      phone: '+447860980321',
    })
  })

  it('admin guard rejects a customer token', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(401)
  })

  it('customer guard rejects an admin token', async () => {
    await request(app.getHttpServer())
      .get('/api/customer/me')
      .set('Authorization', `Bearer ${adminToken()}`)
      .expect(401)
  })

  it('customer guard rejects a missing / garbage token', async () => {
    await request(app.getHttpServer()).get('/api/customer/me').expect(401)
    await request(app.getHttpServer()).get('/api/customer/beneficiaries').set('Authorization', 'Bearer nope').expect(401)
  })
})
