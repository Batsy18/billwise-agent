import bcrypt from 'bcrypt';
import type { KeyMaterial } from '../auth/keys';
import { signAccessToken, type JwtSettings } from '../auth/tokens';
import { AppError } from '../http/errors';
import type { SubscriberRepository } from '../repositories/types';

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

// Compared against when the user does not exist, so both failure paths cost one bcrypt
// compare and response timing does not reveal which subscriber numbers exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => (dummyHash ??= bcrypt.hash('not-a-real-password', 10));

export class AuthService {
  constructor(
    private readonly subscribers: SubscriberRepository,
    private readonly keys: KeyMaterial,
    private readonly jwt: JwtSettings,
  ) {}

  async login(subscriberNo: string, password: string): Promise<LoginResult> {
    const user = await this.subscribers.findByNo(subscriberNo);
    const ok = await bcrypt.compare(password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !ok) throw new AppError('UNAUTHORIZED', 'Invalid subscriber number or password');
    return {
      accessToken: signAccessToken(this.keys, this.jwt, {
        subscriberNo: user.subscriberNo,
        role: user.role,
      }),
      tokenType: 'Bearer',
      expiresIn: this.jwt.ttlSeconds,
    };
  }
}
